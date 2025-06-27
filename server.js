const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/deck', async (req, res) => {
  const deckUrl = req.query.url;
  if (!deckUrl) return res.status(400).json({ error: 'Missing deck URL' });

  if (deckUrl.includes('archidekt.com')) {
    const deckId = deckUrl.match(/decks\/(\d+)/)?.[1];
    if (!deckId) return res.status(400).json({ error: 'Invalid Archidekt URL' });
    return scrapeArchidekt(deckId, res);
  } else if (deckUrl.includes('moxfield.com')) {
    const deckId = deckUrl.match(/\/decks\/([^\/]+)/)?.[1];
    if (!deckId) return res.status(400).json({ error: 'Invalid Moxfield URL' });
    return scrapeMoxfield(deckId, res);
  } else {
    return res.status(400).json({ error: 'Unsupported deck provider' });
  }
});

// -------- ARCHIDEKT SCRAPER --------
async function scrapeArchidekt(deckId, res) {
  const url = `https://archidekt.com/decks/${deckId}/view`;
  console.log(`🔍 [Archidekt] Scraping deck: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Force table view
    await page.setCookie({
      name: 'deckView',
      value: '4',
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 900000 });
    console.log("📄 [Archidekt] Page loaded, extracting cards...");

    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('[class^="table_row"]');
      const data = [];

      rows.forEach((row, index) => {
        try {
          const nameEl = row.querySelector('[class^="spreadsheetCard_cursorCard"] span');
          const qtyEl = row.querySelector('[class^="spreadsheetCard_quantity"] input[type="number"]');
          const finishBtn = row.querySelector('[class^="spreadsheetCard_modifier"] button');
          const setInput = row.querySelector('[class^="spreadsheetCard_setName"] input');

          if (nameEl && qtyEl && finishBtn && setInput) {
            const name = nameEl.textContent.trim();
            const quantity = parseInt(qtyEl.value, 10) || 1;
            const foil = finishBtn.textContent.trim().toLowerCase() === 'foil';

            const setText = setInput.placeholder || setInput.value || '';
            const match = setText.match(/\((\w+)\)\s*\((\d+)\)/);
            const setCode = match?.[1];
            const collectorNumber = match?.[2];

            if (name && setCode && collectorNumber) {
              data.push({ name, quantity, foil, setCode, collectorNumber });
              console.log(`🟢 [${index}] Added: ${name} (${quantity}) — ${foil ? 'Foil' : 'Normal'} — ${setCode} #${collectorNumber}`);
            } else {
              console.warn(`⚠️ [${index}] Missing fields: name="${name}", set="${setText}"`);
            }
          } else {
            console.warn(`⚠️ [${index}] Incomplete row — skipping.`);
          }
        } catch (err) {
          console.error(`❌ [${index}] Error parsing row:`, err);
        }
      });

      return data;
    });

    await browser.close();

    console.log(`✅ [Archidekt] Extracted ${cards.length} card(s).`);
    const images = [];

    for (const card of cards) {
      const apiUrl = `https://api.scryfall.com/cards/${card.setCode}/${card.collectorNumber}`;
      console.log(`🔗 [Scryfall] Fetching ${card.name} → ${apiUrl}`);

      try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        const img = data.image_uris?.normal;

        if (img) {
          images.push({ ...card, img });
        } else {
          console.warn(`⚠️ [Scryfall] No image for ${card.name}`);
        }
      } catch (err) {
        console.error(`❌ [Scryfall] Error for ${card.name}: ${err.message}`);
      }
    }

    console.log(`📦 [Archidekt] Done. Returning ${images.length} image(s).`);
    res.json({ images });

  } catch (err) {
    console.error("❌ [Archidekt] Scraping failed:", err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
}

// -------- MOXFIELD SCRAPER --------
async function scrapeMoxfield(deckId, res) {
  const url = `https://www.moxfield.com/decks/${deckId}`;
  console.log(`🔍 [Moxfield] Scraping deck: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Set view mode cookie to "grid"
    await page.setCookie({
      name: 'state',
      value: JSON.stringify({
        viewSettings: {
          viewMode: 'grid',
          groupBy: 'type',
          sortBy: 'name'
        }
      }),
      domain: 'www.moxfield.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 900000 });
    console.log("📄 [Moxfield] Page loaded, extracting cards...");

    const cards = await page.evaluate(() => {
      const elements = document.querySelectorAll('[class*="decklist-card"]');
      const cardList = [];

      elements.forEach(el => {
        const name = el.querySelector('.decklist-card-phantomsearch')?.textContent?.trim();
        const qtyText = el.querySelector('.decklist-card-quantity')?.textContent || '';
        const qty = parseInt(qtyText.replace('x', ''), 10) || 1;
        const img = el.querySelector('img.img-card')?.src;

        if (name && img) {
          for (let i = 0; i < qty; i++) {
            cardList.push({ name, img });
          }
        }
      });

      return cardList;
    });

    await browser.close();
    console.log(`✅ [Moxfield] Extracted ${cards.length} card(s).`);
    res.json({ images: cards });
  } catch (err) {
    console.error("❌ [Moxfield] Scraping failed:", err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
