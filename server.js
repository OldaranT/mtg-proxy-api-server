const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: 'https://oldarant.github.io'
}));

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}/view`;

  console.log(`🔍 Scraping Archidekt deck: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const [page] = await browser.pages();

    // ✅ Set cookie to force table view
    await page.setCookie({
      name: 'deckView',
      value: '4', // Table view
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    console.log('🍪 Cookie set to table view');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('📄 Page loaded. Extracting card data...');

    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('.table_row__yAAZX');
      const extracted = [];

      rows.forEach(row => {
        const nameEl = row.querySelector('button.spreadsheetCard_cardName__OH0lE span span');
        const qtyEl = row.querySelector('input[type="number"]');

        if (nameEl && qtyEl) {
          const name = nameEl.textContent.trim();
          const quantity = parseInt(qtyEl.value, 10) || 1;
          extracted.push({ name, quantity });
        }
      });

      return extracted;
    });

    console.log(`🧠 Found ${cards.length} cards. Querying Scryfall for images...`);

    const images = [];

    for (const card of cards) {
      try {
        const scryfallRes = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}`);
        const scryfallData = await scryfallRes.json();

        const img = scryfallData.image_uris?.normal || scryfallData.card_faces?.[0]?.image_uris?.normal;

        if (img) {
          images.push({
            name: card.name,
            img,
            quantity: card.quantity
          });
        } else {
          console.warn(`⚠️ No image for ${card.name}`);
        }
      } catch (err) {
        console.error(`❌ Scryfall error for ${card.name}: ${err.message}`);
      }
    }

    await browser.close();

    console.log(`✅ Done! Returning ${images.length} images.`);
    res.json({ images });

  } catch (err) {
    console.error("❌ Scraping failed:", err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MTG Proxy API server running at http://localhost:${PORT}`);
});
