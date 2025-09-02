const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const LRU = require('lru-cache');
const LRUCache = LRU.LRUCache || LRU; // v11 (LRUCache) and older fallback
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// We'll set our own ETag so disable Express' automatic one
app.set('etag', false);

/* =========================
   Cache configuration
   ========================= */

const FRESH_TTL_MS = 5 * 60 * 1000;      // 5 minutes (responses considered "fresh")
const SWR_TTL_MS   = 60 * 60 * 1000;     // 1 hour (serve stale while we refresh)
const MAX_DECKS    = 500;                // up to 500 distinct decks in memory

// Deck cache: key = `${provider}:${deckId}`
// value shape:
// {
//   payload: { images, categoryOrder, deckHash, provider, deckId },
//   etag: "W/....",
//   deckHash: "abc123",
//   freshUntil: <timestamp>,
//   swrUntil: <timestamp>,
//   pageSig: "<signature string>"
// }
const deckCache = new LRUCache({ max: MAX_DECKS });

// In-flight refreshes (dedupe concurrent scrapes)
const inFlight = new Map();

// Scryfall item cache (set/collector → JSON + ETag/Last-Modified)
const scryCache = new LRUCache({
  max: 8000,
  ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
});

// User agent for preflight fetches (some hosts are picky)
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

/* =========================
   Helpers
   ========================= */

function hashJSON(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

function weakEtagForPayload(payload) {
  // Only hash the stable parts we return to the client
  const h = hashJSON({ images: payload.images, categoryOrder: payload.categoryOrder });
  return `W/"${h}"`;
}

function makeCacheRecord(payload, pageSig) {
  const now = Date.now();
  return {
    payload,
    etag: weakEtagForPayload(payload),
    deckHash: payload.deckHash,
    freshUntil: now + FRESH_TTL_MS,
    swrUntil: now + SWR_TTL_MS,
    pageSig: pageSig || null,
  };
}

function isFresh(rec) {
  return rec && Date.now() < rec.freshUntil;
}
function withinSWR(rec) {
  return rec && Date.now() < rec.swrUntil;
}

function bumpFreshness(rec) {
  const now = Date.now();
  rec.freshUntil = now + FRESH_TTL_MS;
  rec.swrUntil = now + SWR_TTL_MS;
  return rec;
}

function setClientCacheHeaders(res, etag) {
  // Let clients cache the JSON; browsers/proxies can revalidate.
  res.setHeader(
    'Cache-Control',
    `public, max-age=${Math.floor(FRESH_TTL_MS / 1000)}, stale-while-revalidate=${Math.floor(
      (SWR_TTL_MS - FRESH_TTL_MS) / 1000
    )}`
  );
  res.setHeader('ETag', etag);
}

/* =========================
   Page signature (preflight)
   ========================= */

function deckViewUrl(provider, deckId) {
  return provider === 'archidekt'
    ? `https://archidekt.com/decks/${deckId}/view`
    : `https://www.moxfield.com/decks/${deckId}`;
}

/**
 * Try HEAD first to get ETag/Last-Modified/Content-Length.
 * If none or unsupported, GET the HTML shell and hash it.
 * Returns a compact string signature (stable for equality checks).
 */
async function fetchPageSignature(url) {
  // 1) HEAD
  try {
    const h = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
      redirect: 'follow',
    });
    // Some CDNs respond 405 to HEAD; handle that
    if (h.ok) {
      const etag = (h.headers.get('etag') || '').trim();
      const lastMod = (h.headers.get('last-modified') || '').trim();
      const len = (h.headers.get('content-length') || '').trim();
      if (etag || lastMod || len) {
        return ['H', etag, lastMod, len].join('|');
      }
    }
  } catch (e) {
    // Swallow and fall through to GET
  }

  // 2) GET minimal HTML shell (no Puppeteer)
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Cache-Control': 'no-cache',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`GET ${r.status}`);
    const etag = (r.headers.get('etag') || '').trim();
    const lastMod = (r.headers.get('last-modified') || '').trim();
    const len = (r.headers.get('content-length') || '').trim();
    const text = await r.text();
    // Normalize whitespace to reduce noise, then hash
    const bodyHash = crypto
      .createHash('sha1')
      .update(text.replace(/\s+/g, ' ').slice(0, 1_000_000)) // cap at 1MB
      .digest('hex');
    return ['G', etag, lastMod, len, bodyHash].join('|');
  } catch (e) {
    // If even GET fails, return null → fallback to TTL behavior
    return null;
  }
}

async function fetchDeckPageSignature(provider, deckId) {
  const url = deckViewUrl(provider, deckId);
  return await fetchPageSignature(url);
}

/* =========================
   Scryfall (conditional)
   ========================= */

async function fetchScryfallCard(setCode, collectorNumber) {
  const key = `${setCode}/${collectorNumber}`;
  const cached = scryCache.get(key);

  const url = `https://api.scryfall.com/cards/${setCode}/${collectorNumber}`;
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const resp = await fetch(url, { headers });

  if (resp.status === 304 && cached?.data) {
    return cached.data; // use existing JSON
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Scryfall ${resp.status}: ${txt || 'fetch error'}`);
  }

  const data = await resp.json();
  const etag = resp.headers.get('etag') || null;
  const lastModified = resp.headers.get('last-modified') || null;

  scryCache.set(key, { data, etag, lastModified });
  return data;
}

/* =========================
   Deck scrape → JSON
   ========================= */

async function scrapeArchidekt(deckId) {
  const url = `https://archidekt.com/decks/${deckId}/view`;
  console.log(`🔍 [Archidekt] ${url}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    // Force table view
    await page.setCookie({
      name: 'deckView',
      value: '4',
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true,
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 900000 });

    const rows = await page.evaluate(() => {
      const rows = document.querySelectorAll('[class^="table_row"]');
      const out = [];
      rows.forEach((row) => {
        const nameEl = row.querySelector('[class^="spreadsheetCard_cursorCard"] span');
        const qtyEl = row.querySelector('[class^="spreadsheetCard_quantity"] input[type="number"]');
        const finish = row.querySelector('[class^="spreadsheetCard_modifier"] button');
        const setIn = row.querySelector('[class^="spreadsheetCard_setName"] input');
        const catEl = row.querySelector('[class^="simpleCategorySelection_trigger"]');
        if (!(nameEl && qtyEl && finish && setIn)) return;

        const name = nameEl.textContent.trim();
        const quantity = parseInt(qtyEl.value, 10) || 1;
        const foil = (finish.textContent || '').trim().toLowerCase() === 'foil';

        const setText = setIn.placeholder || setIn.value || '';
        const m = setText.match(/\((\w+)\)\s*\((\d+)\)/);
        const setCode = m?.[1];
        const collectorNumber = m?.[2];

        const category = (catEl?.textContent || 'Uncategorized').trim();
        if (name && setCode && collectorNumber) {
          out.push({ name, quantity, foil, setCode, collectorNumber, category });
        }
      });
      return out;
    });

    // Compute a deck fingerprint from the rows (name/qty/foil/set/cn/category)
    const deckHash = hashJSON(
      rows.map((r) => [r.name, r.quantity, r.foil, r.setCode, r.collectorNumber, r.category])
    );

    // Hydrate images using Scryfall (with conditional caching)
    const images = [];
    for (const card of rows) {
      try {
        const data = await fetchScryfallCard(card.setCode, card.collectorNumber);
        let imgFront = null;
        let imgBack = null;

        if (Array.isArray(data.card_faces) && data.card_faces.length >= 2) {
          imgFront = data.card_faces[0]?.image_uris?.normal || data.image_uris?.normal || null;
          imgBack = data.card_faces[1]?.image_uris?.normal || null;
        } else {
          imgFront = data.image_uris?.normal || null;
          imgBack = null;
        }

        if (imgFront) {
          images.push({
            ...card,
            img: imgFront,
            backImg: imgBack || null,
          });
        }
      } catch (e) {
        console.warn(
          `⚠️ [Scryfall fail] ${card.name} (${card.setCode}/${card.collectorNumber}): ${e.message}`
        );
      }
    }

    const categoryOrder = Array.from(new Set(images.map((c) => c.category || 'Uncategorized')));
    return { images, categoryOrder, deckHash, provider: 'archidekt', deckId };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function scrapeMoxfield(deckId) {
  const url = `https://www.moxfield.com/decks/${deckId}`;
  console.log(`🔍 [Moxfield] ${url}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();

    await page.setCookie({
      name: 'state',
      value: JSON.stringify({
        viewSettings: { viewMode: 'grid', groupBy: 'type', sortBy: 'name' },
      }),
      domain: 'www.moxfield.com',
      path: '/',
      httpOnly: false,
      secure: true,
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 900000 });

    const cards = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="decklist-card"]');
      const list = [];
      els.forEach((el) => {
        const name = el.querySelector('.decklist-card-phantomsearch')?.textContent?.trim();
        const qtyText = el.querySelector('.decklist-card-quantity')?.textContent || '';
        const qty = parseInt(qtyText.replace('x', ''), 10) || 1;
        const img = el.querySelector('img.img-card')?.src;
        if (name && img) list.push({ name, img, quantity: qty });
      });
      return list;
    });

    // Build a stable hash (name + qty + img)
    const deckHash = hashJSON(cards.map((c) => [c.name, c.quantity, c.img]));
    const images = cards.map((c) => ({ name: c.name, img: c.img, quantity: c.quantity }));
    const categoryOrder = []; // moxfield scrape doesn't categorize in this quick path

    return { images, categoryOrder, deckHash, provider: 'moxfield', deckId };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* =========================
   Cache wrapper with preflight signature
   ========================= */

async function getDeckCached(provider, deckId, { force = false } = {}) {
  const key = `${provider}:${deckId}`;
  const cached = deckCache.get(key);

  // Force rebuild bypasses everything
  if (force) {
    return await buildAndCache(provider, deckId, key);
  }

  // If still fresh, ship it
  if (isFresh(cached)) {
    return cached;
  }

  // Preflight: try to detect page changes cheaply
  let sig = null;
  try {
    sig = await fetchDeckPageSignature(provider, deckId);
  } catch (e) {
    console.warn(`⚠️ preflight failed for ${key}: ${e.message}`);
  }

  // If we have a cached record and the page signature hasn't changed,
  // just renew freshness and avoid a heavy scrape.
  if (cached && sig && cached.pageSig === sig) {
    const renewed = bumpFreshness(cached);
    deckCache.set(key, renewed);
    return renewed;
  }

  // If within SWR, serve stale and refresh if not already doing so.
  if (withinSWR(cached)) {
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        buildAndCache(provider, deckId, key, sig)
          .catch((err) => console.error(`❌ refresh failed for ${key}:`, err))
          .finally(() => inFlight.delete(key))
      );
    }
    return cached;
  }

  // Outside SWR: block on a rebuild (but dedupe)
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      buildAndCache(provider, deckId, key, sig).finally(() => inFlight.delete(key))
    );
  }
  const rec = await inFlight.get(key);
  return rec;
}

async function buildAndCache(provider, deckId, key, pageSigFromPreflight = null) {
  const fresh =
    provider === 'archidekt' ? await scrapeArchidekt(deckId) : await scrapeMoxfield(deckId);

  // If we didn't preflight or signature failed, try to set one now (non-blocking)
  let pageSig = pageSigFromPreflight;
  if (!pageSig) {
    try {
      pageSig = await fetchDeckPageSignature(provider, deckId);
    } catch {
      pageSig = null;
    }
  }

  const rec = makeCacheRecord(fresh, pageSig);
  deckCache.set(key, rec);
  return rec;
}

/* =========================
   Route
   ========================= */

app.get('/api/deck', async (req, res) => {
  try {
    const deckUrl = req.query.url;
    const force = req.query.force === '1' || req.query.force === 'true';

    if (!deckUrl) return res.status(400).json({ error: 'Missing deck URL' });

    let provider, deckId;

    if (deckUrl.includes('archidekt.com')) {
      provider = 'archidekt';
      deckId = deckUrl.match(/decks\/(\d+)/)?.[1];
      if (!deckId) return res.status(400).json({ error: 'Invalid Archidekt URL' });
    } else if (deckUrl.includes('moxfield.com')) {
      provider = 'moxfield';
      deckId = deckUrl.match(/\/decks\/([^/]+)/)?.[1];
      if (!deckId) return res.status(400).json({ error: 'Invalid Moxfield URL' });
    } else {
      return res.status(400).json({ error: 'Unsupported deck provider' });
    }

    const rec = await getDeckCached(provider, deckId, { force });

    // Client-side conditional
    const clientETag = req.headers['if-none-match'];
    if (clientETag && clientETag === rec.etag) {
      setClientCacheHeaders(res, rec.etag);
      return res.status(304).end();
    }

    setClientCacheHeaders(res, rec.etag);
    return res.json(rec.payload);
  } catch (err) {
    console.error('❌ /api/deck failed:', err);
    return res.status(500).json({ error: 'Scraping failed', details: err.message });
  }
});

/* =========================
   Start
   ========================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
