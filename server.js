const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer'); // kept for Moxfield only
const crypto = require('crypto');       // built-in (no npm dep)
const LRU = require('lru-cache');
const LRUCache = LRU.LRUCache || LRU;   // v11+ or older interop
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('etag', false); // we'll manage ETag ourselves

/* =========================
   Caches
   ========================= */

const deckCache = new LRUCache({ max: 500 }); // Archidekt + Moxfield
const inFlight = new Map();

// Scryfall cache (JSON, with conditional headers)
const scryCache = new LRUCache({
  max: 8000,
  ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
});

/* Moxfield freshness/SWR (Archidekt uses updatedAt instead) */
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
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
}

// defensive getter
const get = (o, path, d = null) =>
  path.split('.').reduce((v, k) => (v && v[k] !== undefined ? v[k] : undefined), o) ?? d;

/* =========================
   Scryfall helpers
   ========================= */

async function fetchScryfallCardBySetNum(setCode, collectorNumber) {
  const key = `setnum:${setCode}/${collectorNumber}`;
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

async function fetchScryfallByNameExact(name) {
  const key = `name:${name.toLowerCase()}`;
  const cached = scryCache.get(key);
  const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  const resp = await fetch(url, { headers });
  if (resp.status === 304 && cached?.data) return cached.data;
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Scryfall named ${resp.status}: ${txt || 'fetch error'}`);
  }

  const data = await resp.json();
  const etag = resp.headers.get('etag') || null;
  const lastModified = resp.headers.get('last-modified') || null;
  scryCache.set(key, { data, etag, lastModified });
  return data;
}

/* =========================
   Archidekt via API (no scraping)
   ========================= */

async function fetchArchidektSmall(deckId) {
  const url = `https://archidekt.com/api/decks/${deckId}/small/`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'mtg-proxy-api-server/1.0',
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Archidekt small ${resp.status}: ${txt || 'fetch error'}`);
  }
  return resp.json();
}

async function fetchArchidektDeck(deckId) {
  const url = `https://archidekt.com/api/decks/${deckId}/`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'mtg-proxy-api-server/1.0',
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Archidekt deck ${resp.status}: ${txt || 'fetch error'}`);
  }
  return resp.json();
}

// Parse Archidekt full deck JSON into rows we can hydrate with Scryfall
function parseArchidektRows(deckJson) {
  const catMap = new Map((deckJson.categories || []).map(c => [c.id, c.name]));
  const rows = [];

  for (const it of deckJson.cards || []) {
    const name =
      get(it, 'card.name') ||
      get(it, 'card.oracleCard.name') ||
      it.name ||
      '';

    const quantity = it.quantity ?? it.count ?? 1;

    // category: prefer mapping via categoryId
    const category =
      (it.categoryId && catMap.get(it.categoryId)) ||
      it.category ||
      'Uncategorized';

    // finish (foil vs nonfoil)
    const finish = (it.finish || it.modifier || '').toString().toLowerCase();
    const foil = finish.includes('foil');

    // printing info — try several shapes Archidekt may use
    const setCode =
      get(it, 'card.edition.set.code') ||
      get(it, 'card.edition.code') ||
      get(it, 'card.set.code') ||
      get(it, 'edition.code') ||
      it.setCode ||
      null;

    const collectorNumber =
      get(it, 'card.edition.collectorNumber') ||
      get(it, 'card.collectorNumber') ||
      it.collectorNumber ||
      null;

    rows.push({ name, quantity, foil, setCode, collectorNumber, category });
  }

  return rows.filter(r => r.name && r.quantity > 0);
}

async function hydrateRowsToPayload(rows, { provider, deckId }) {
  const images = [];

  for (const card of rows) {
    try {
      let data;
      if (card.setCode && card.collectorNumber) {
        data = await fetchScryfallCardBySetNum(card.setCode, card.collectorNumber);
      } else {
        // fallback if Archidekt didn’t provide printing — use name
        data = await fetchScryfallByNameExact(card.name);
      }

      let imgFront = null;
      let imgBack = null;

      if (Array.isArray(data.card_faces) && data.card_faces.length >= 2) {
        imgFront = data.card_faces[0]?.image_uris?.normal || data.image_uris?.normal || null;
        imgBack  = data.card_faces[1]?.image_uris?.normal || null;
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
      console.warn(`⚠️ [Scryfall fail] ${card.name} (${card.setCode || 'N/A'}/${card.collectorNumber || 'N/A'}): ${e.message}`);
    }
  }

  const categoryOrder = Array.from(new Set(images.map(c => c.category || 'Uncategorized')));
  return { images, categoryOrder, provider, deckId };
}

async function resolveArchidekt(deckId) {
  const key = `archidekt:${deckId}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    // 1) cheap change check
    let small;
    try {
      small = await fetchArchidektSmall(deckId);
    } catch (e) {
      console.warn(`⚠️ small() failed: ${e.message} — will fetch full deck anyway`);
    }
    const remoteUpdatedAt = small?.updatedAt || null;

    const cached = deckCache.get(key);
    if (cached && remoteUpdatedAt && cached.archidektUpdatedAt === remoteUpdatedAt) {
      // up to date — skip full download
      return cached;
    }

    // 2) fetch full deck and rebuild
    const deckJson = await fetchArchidektDeck(deckId);
    const rows = parseArchidektRows(deckJson);
    const payload = await hydrateRowsToPayload(rows, { provider: 'archidekt', deckId });

    // stable fingerprint for debugging (not used for invalidation now)
    payload.deckHash = hashJSON(
      payload.images.map(r => [r.name, r.quantity, r.foil, r.setCode, r.collectorNumber, r.category])
    );

    const rec = {
      payload,
      etag: weakEtagForPayload(payload),
      archidektUpdatedAt: deckJson.updatedAt || remoteUpdatedAt || null,
      lastScrapedAt: Date.now(),
    };
    deckCache.set(key, rec);
    return rec;
  })()
    .catch((e) => {
      console.error(`❌ resolveArchidekt failed: ${e.message}`);
      const fallback = deckCache.get(key);
      if (fallback) return fallback;
      throw e;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

/* =========================
   Moxfield (unchanged, still Puppeteer)
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

    const images = cards.map((c) => ({ name: c.name, img: c.img, quantity: c.quantity }));
    const categoryOrder = [];
    const payload = {
      images,
      categoryOrder,
      provider: 'moxfield',
      deckId,
      deckHash: hashJSON(images.map(c => [c.name, c.quantity, c.img])),
    };

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

    // Client revalidation AFTER we ensured freshness/currentness
    const clientETag = req.headers['if-none-match'];
    if (clientETag && clientETag === rec.etag) {
      setNoCacheWithETag(res, rec.etag);
      return res.status(304).end();
    }

    setNoCacheWithETag(res, rec.etag);
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
