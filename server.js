const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}/view`;

  console.log(`🔍 [START] Scraping Archidekt deck: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    console.log("💾 Setting deckView cookie for table view...");
    await page.setCookie({
      name: 'deckView',
      value: '4',
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    console.log("🌐 Navigating to page...");
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log("📄 Page loaded. Extracting card data...");
    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('.table_row__yAAZX');
      const data = [];

      rows.forEach((row, index) => {
        const nameEl = row.querySelector('button.spreadsheetCard_cardName__OH0lE span span');
        const qtyEl = row.querySelector('input[type="number"]');
        const finishBtn = row.querySelector('.spreadsheetCard_modifier__YtDhf button');
        const setTextEl = row.querySelector('.spreadsheetCard_setName__37QxL');

        if (nameEl && qtyEl && finishBtn && setTextEl) {
          const name = nameEl.textContent.trim();
          const quantity = parseInt(qtyEl.value, 10) || 1;
          const foil = finishBtn.textContent.trim().toLowerCase() === 'foil';

          const setText = setTextEl.textContent;
          const match = setText.match(/\((\w+)\)\s*\((\d+)\)/);
          const setCode = match?.[1];
          const collectorNumber = match?.[2];

          if (setCode && collectorNumber) {
            data.push({ name, quantity, foil, setCode, collectorNumber });
          } else {
            console.warn(`⚠️ [Row ${index}] Could not parse set info: "${setText}"`);
          }
        } else {
          console.warn(`⚠️ [Row ${index}] Missing data fields`);
        }
      });

      return data;
    });

    await browser.close();
    console.log(`✅ Extracted ${cards.length} card(s).`);

    const images = [];

    for (const card of cards) {
      const apiUrl = `https://api.scryfall.com/cards/${card.setCode}/${card.collectorNumber}`;
      console.log(`🔗 Fetching image for "${card.name}" from ${apiUrl}`);

      try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        let img = data?.image_uris?.normal;
        if (card.foil && data?.foil && data.image_uris?.normal) {
          img = data.image_uris.normal;
        }

        if (img) {
          console.log(`🖼️ Found image for "${card.name}"`);
          images.push({
            name: card.name,
            img,
            quantity: card.quantity,
            foil: card.foil,
            set: card.setCode,
            collectorNumber: card.collectorNumber
          });
        } else {
          console.warn(`⚠️ No image for "${card.name}"`);
        }
      } catch (err) {
        console.error(`❌ Scryfall fetch failed for "${card.name}": ${err.message}`);
      }
    }

    console.log(`📦 Done. Returning ${images.length} image(s) to client.`);
    res.json({ images });

  } catch (err) {
    console.error("❌ Global scraping error:", err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
