const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const app = express();

app.use(cors());
const PORT = process.env.PORT || 3000;

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}/view`;

  console.log(`🔍 Scraping deck: ${deckId}`);

  try {
    const browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote'
      ],
      headless: 'new'
    });

    const page = await browser.newPage();

    await page.setCookie({
      name: 'deckView',
      value: '4', // table view
      domain: '.archidekt.com',
      path: '/'
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.spreadsheetCard_card__S3yrf');

    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('.spreadsheetCard_card__S3yrf');
      const results = [];

      rows.forEach(row => {
        const nameEl = row.querySelector('.spreadsheetCard_cardName__OH0lE span');
        const qtyEl = row.querySelector('input[type="number"]');

        const name = nameEl?.innerText?.trim();
        const quantity = parseInt(qtyEl?.value || '1');

        if (name && quantity > 0) {
          results.push({ name, quantity });
        }
      });

      return results;
    });

    await browser.close();

    // Use Scryfall to get images
    const images = [];
    for (const card of cards) {
      try {
        const response = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}`);
        const cardData = await response.json();
        const image = cardData.image_uris?.normal || cardData.card_faces?.[0]?.image_uris?.normal;

        if (image) {
          images.push({ name: card.name, quantity: card.quantity, img: image });
        } else {
          console.warn(`⚠️ No image for ${card.name}`);
        }
      } catch (err) {
        console.error(`❌ Scryfall error for ${card.name}`, err);
      }
    }

    res.json({ deckId, images });
  } catch (err) {
    console.error('❌ Puppeteer scrape failed:', err);
    res.status(500).json({ error: 'Scraping failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
