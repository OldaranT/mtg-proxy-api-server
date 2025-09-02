const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto'); // built-in (no npm dep)
const LRU = require('lru-cache');
const LRUCache = LRU.LRUCache || LRU; // v11+ or older
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('etag', false); // we'll control ETags

/* =========================
   Caches
   ========================= */

// One cache for all deck payloads (Archidekt + Moxfield)
const deckCache = new LRUCache({ max: 500 });

// Deduplicate concurrent builds/checks
const inFlight = new Map();

// Scryfall JSON cache (uses conditional requests)
const scryCache = new LRUCache({
  max: 8000,
  ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
});

/* Moxfield fallback TTL/SWR (Archidekt is strict via updatedAt) */
const MOX_FRESH_MS = 5 * 60 * 1000;
const MOX_SWR_MS = 60 * 60 * 1000;

/* =========================
   Helpers
   ========================= */

function hashJSON(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

function weakEtagForPayload(payload) {
  const h = hashJSON({ images: payload.images, categoryOrder: payload.categoryOrder });
  return `W/"${h}"`;
}

function setNoCacheWithETag(res, etag) {
  // clients must revalidate every time → instant change visibility
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
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
  if (resp.status === 304 && cached?.data) return cached.data;

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
   Archidekt — INSTANT change detection using updatedAt
   ========================= */

// Fast check: hit Archidekt's small API to get updatedAt
async function getArchidektUpdatedAt(deckId) {
  const url = `https://archidekt.com/api/decks/${deckId}/small/`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'mtg-proxy-api-server/1.0',
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Archidekt small ${resp.status}: ${text || 'fetch error'}`);
  }
  const json = await resp.json();
  // normalized ISO string (or null)
  return json?.updatedAt || null;
}

// Scrape rows (names/qty/foil/set/cn/category)
async function scrapeArchidektRows(deckId) {
  const url = `https://archidekt.com/decks/${deckId}/view`;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
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
      const nodes = document.querySelectorAll('[class^="table_row"]');
      const out = [];
      nodes.forEach((row) => {
        const nameEl = row.querySelector('[class^="spreadsheetCard_cursorCard"] span');
        const qtyEl = row.querySelector('[class^="spreadsheetCard_quantity"] input[type="number"]');
        const finishBtn = row.querySelector('[class^="spreadsheetCard_modifier"] button');
        const setInput = row.querySelector('[class^="spreadsheetCard_setName"] input');
        const catEl = row.querySelector('[class^="simpleCategorySelection_trigger"]');

        if (!(nameEl && qtyEl && finishBtn && setInput)) return;

        const name = nameEl.textContent.trim();
        const quantity = parseInt(qtyEl.value, 10) || 1;
        const foil = (finishBtn.textContent || '').trim().toLowerCase() === 'foil';

        const setText = setInput.placeholder || setInput.value || '';
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

    return rows;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function hydrateRowsToPayload(rows, { provider, deckId }) {
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
      console.warn(`⚠️ [Scryfall fail] ${card.name} (${card.setCode}/${card.collectorNumber}): ${e.message}`);
    }
  }

  const categoryOrder = Array.from(new Set(images.map((c) => c.category || 'Uncategorized')));
  return { images, categoryOrder, provider, deckId };
}

async function resolveArchidekt(deckId) {
  const key = `archidekt:${deckId}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    const remoteUpdatedAt = await getArchidektUpdatedAt(deckId); // <— cheap, instant

    const cached = deckCache.get(key);
    // If we have a cached payload and updatedAt matches, we’re current
    if (cached && cached.archidektUpdatedAt === remoteUpdatedAt) {
      return cached;
    }

    // Otherwise (first time or changed), scrape + hydrate now
    const rows = await scrapeArchidektRows(deckId);
    const payload = await hydrateRowsToPayload(rows, { provider: 'archidekt', deckId });

    // also compute a deckHash for debugging/consistency (not used for invalidation anymore)
    payload.deckHash = hashJSON(rows.map(r => [r.name, r.quantity, r.foil, r.setCode, r.collectorNumber, r.category]));

    const rec = {
      payload,
      etag: weakEtagForPayload(payload),
      archidektUpdatedAt: remoteUpdatedAt || null,
      lastScrapedAt: Date.now(),
    };
    deckCache.set(key, rec);
    return rec;
  })()
    .catch((e) => {
      console.error(`❌ resolveArchidekt failed: ${e.message}`);
      // if something failed, fall back to any cached copy
      const fallback = deckCache.get(key);
      if (fallback) return fallback;
      throw e;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

/* =========================
   Moxfield (TTL + SWR as before)
   ========================= */

function moxKey(deckId) {
  return `moxfield:${deckId}`;
}
function moxIsFresh(rec) {
  return rec && Date.now() - rec.lastScrapedAt < MOX_FRESH_MS;
}
function moxWithinSWR(rec) {
  return rec && Date.now() - rec.lastScrapedAt < MOX_SWR_MS;
}

async function scrapeMoxfield(deckId) {
  const url = `https://www.moxfield.com/decks/${deckId}`;
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

    const deckHash = hashJSON(cards.map((c) => [c.name, c.quantity, c.img]));
    const images = cards.map((c) => ({ name: c.name, img: c.img, quantity: c.quantity }));
    const categoryOrder = [];

    const payload = { images, categoryOrder, provider: 'moxfield', deckId, deckHash };
    return {
      payload,
      etag: weakEtagForPayload(payload),
      lastScrapedAt: Date.now(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function resolveMoxfield(deckId) {
  const key = moxKey(deckId);
  const cached = deckCache.get(key);
  if (moxIsFresh(cached)) return cached;

  if (moxWithinSWR(cached)) {
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        scrapeMoxfield(deckId)
          .then((rec) => (deckCache.set(key, rec), rec))
          .catch((e) => {
            console.error(`❌ Moxfield refresh failed: ${e.message}`);
            return cached;
          })
          .finally(() => inFlight.delete(key))
      );
    }
    return cached;
  }

  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      scrapeMoxfield(deckId)
        .then((rec) => (deckCache.set(key, rec), rec))
        .finally(() => inFlight.delete(key))
    );
  }
  return await inFlight.get(key);
}

/* =========================
   Route
   ========================= */

app.get('/api/deck', async (req, res) => {
  try {
    const deckUrl = req.query.url;
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

    const rec = provider === 'archidekt'
      ? await resolveArchidekt(deckId)
      : await resolveMoxfield(deckId);

    // Client-side conditional AFTER we ensured freshness (for Archidekt)
    const clientETag = req.headers['if-none-match'];
    if (clientETag && clientETag === rec.etag) {
      setNoCacheWithETag(res, rec.etag);
      return res.status(304).end();
    }

    setNoCacheWithETAG(res, rec.etag); // typo guard
    return res.json(rec.payload);
  } catch (err) {
    console.error('❌ /api/deck failed:', err);
    return res.status(500).json({ error: 'Scraping failed', details: err.message });
  }
});

/* small helper to avoid copy/paste typos */
function setNoCacheWithETAG(res, etag) {
  setNoCacheWithETag(res, etag);
}

/* =========================
   Start
   ========================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
