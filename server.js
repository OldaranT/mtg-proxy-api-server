const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}/view`;

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

    // ✅ Set the deckView cookie to '4' (table view) at the browser context level
    await context.overridePermissions(url, []); // optional, can omit
    await context.setCookie({
      name: 'deckView',
      value: '4',
      domain: 'archidekt.com',
      path: '/',
      httpOnly: false,
      secure: true
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // 💡 Insert scraping logic here (table view parsing)
    const cards = await page.evaluate(() => {
      const rows = document.querySelectorAll('.table_row__yAAZX');
      const result = [];

      rows.forEach(row => {
        const nameBtn = row.querySelector('button.spreadsheetCard_cardName__OH0lE span span');
        const qtyInput = row.querySelector('input[type="number"]');

        if (nameBtn && qtyInput) {
          const name = nameBtn.textContent.trim();
          const quantity = parseInt(qtyInput.value, 10) || 1;
          result.push({ name, quantity });
        }
      });

      return result;
    });

    console.log(`✅ Scraped ${cards.length} cards`);

    // 📦 Now resolve card image URLs from Scryfall
    const images = [];
    for (const card of cards) {
      try {
        const response = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}`);
        const data = await response.json();
        const img = data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal;

        if (img) {
          images.push({ name: card.name, img, quantity: card.quantity });
        }
      } catch (err) {
        console.warn(`⚠️ Failed to fetch Scryfall image for: ${card.name}`);
      }
    }

    await browser.close();
    return res.json({ images });
  } catch (err) {
    console.error("❌ Error scraping Archidekt:", err);
    return res.status(500).json({ error: "Scraping failed" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
