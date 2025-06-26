const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}/view`;
  const debugLog = req.query.log === 'true';

  console.log(`🔍 Scraping Archidekt deck: ${url}`);

  let browser;

  try {
    browser = await puppeteer.launch({
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

    // ✅ Set the 'deckView' cookie to force table view
    await page.setCookie({
      name: 'deckView',
      value: '4',
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    if (debugLog) {
      const html = await page.content();
      console.log("📝 DEBUG HTML:", html.substring(0, 2000)); // print first 2k chars
    }

    console.log("📄 Page loaded, extracting cards...");

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
        const scryRes = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}`);
        const cardData = await scryRes.json();
        const img = cardData.image_uris?.normal || cardData.card_faces?.[0]?.image_uris?.normal;

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

    console.log(`📦 Done. Returning ${images.length} images to client.`);
    res.json({ images });

  } catch (err) {
    console.error("❌ Scrape failed:", err);
    res.status(500).json({ error: 'Scraping failed', details: err.message });

  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MTG Proxy API running on http://localhost:${PORT}`);
});
