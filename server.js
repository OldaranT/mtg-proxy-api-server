const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:id', async (req, res) => {
  const deckId = req.params.id;
  const deckUrl = `https://archidekt.com/decks/${deckId}/`;

  try {
    const htmlRes = await fetch(deckUrl);
    if (!htmlRes.ok) {
      return res.status(htmlRes.status).json({ error: 'Failed to fetch Archidekt deck page' });
    }

    const html = await htmlRes.text();
    const $ = cheerio.load(html);

    const images = [];

    $('[data-card-quantity]').each((_, el) => {
      const quantity = parseInt($(el).attr('data-card-quantity')) || 1;
      const imgEl = $(el).find('img#basicCardImage');
      const img = imgEl.attr('src');
      const name = imgEl.attr('alt');

      if (name && img && img.includes('/card_images/')) {
        images.push({ name, img, quantity });
      }
    });

    res.json({ images });
  } catch (err) {
    console.error('❌ Scraping failed:', err);
    res.status(500).json({ error: 'Failed to scrape deck page' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ MTG Proxy Scraper API using #basicCardImage');
});

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
