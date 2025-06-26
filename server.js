const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:id', async (req, res) => {
  const deckId = req.params.id;
  const deckUrl = `https://archidekt.com/decks/${deckId}/?view=grid`; // 🔄 Force Grid View

  console.log(`\n📥 [REQUEST] Deck ID: ${deckId}`);
  console.log(`🔗 Fetching: ${deckUrl}`);

  try {
    const htmlRes = await fetch(deckUrl);
    const html = await htmlRes.text();
    const $ = cheerio.load(html);

    const images = [];

    // 🔎 Each card is inside this container in Grid View
    $('.imageCard_imageCard__x7s_J').each((_, el) => {
      const imgEl = $(el).find('img#basicCardImage');
      const qtyEl = $(el).find('button.cornerQuantity_cornerQuantity__or_QR');

      const name = imgEl.attr('alt')?.trim();
      const img = imgEl.attr('src');
      const quantity = parseInt(qtyEl.text().trim(), 10) || 1;

      if (name && img && img.includes('scryfall')) {
        images.push({ name, img, quantity });
        console.log(`🃏 ${name} × ${quantity}`);
      } else {
        console.warn(`⚠️ Skipped an invalid card (missing name/image/quantity)`);
      }
    });

    console.log(`✅ Total cards returned: ${images.length}`);
    res.json({ images });
  } catch (err) {
    console.error("❌ Scraping failed:", err);
    res.status(500).json({ error: 'Failed to scrape Archidekt deck page' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ MTG Proxy Scraper API (Grid view enforced) is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});
