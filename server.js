const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const context = browser.defaultBrowserContext();

    // ✅ Force deckView to table view via cookie
    await context.setCookie({
      name: 'deckView',
      value: '4', // table view
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log("📄 Page loaded, extracting cards...");

    // Extract card names + quantities from table view
    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('.table_row__yAAZX');
      const extracted = [];

      rows.forEach(row => {
        const nameBtn = row.querySelector('button.spreadsheetCard_cardName__OH0lE span span');
        const qtyInput = row.querySelector('input[type="number"]');

        if (nameBtn && qtyInput) {
          const name = nameBtn.textContent.trim();
          const quantity = parseInt(qtyInput.value, 10) || 1;
          extracted.push({ name, quantity });
        }
      });

      return extracted;
    });

    console.log(`✅ Extracted ${cards.length} card(s). Fetching images from Scryfall...`);

    const images = [];

    for (const card of cards) {
      try {
        const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}`);
        const data = await res.json();
        const img = data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal;

        if (img) {
          images.push({
            name: card.name,
            img,
            quantity: card.quantity
          });
        } else {
          console.warn(`⚠️ No image found for: ${card.name}`);
        }
      } catch (err) {
        console.error(`❌ Scryfall fetch error for ${card.name}:`, err.message);
      }
    }

    await browser.close();
    console.log(`📦 Done. Sending ${images.length} images to client.`);
    res.json({ images });
  } catch (err) {
    console.error("❌ Error scraping Archidekt:", err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MTG Proxy API running on http://localhost:${PORT}`);
});
