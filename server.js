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

    $('[data-card-name]').each((_, el) => {
      const name = $(el).attr('data-card-name');
      const quantity = parseInt($(el).closest('[data-card-quantity]').attr('data-card-quantity') || '1');
      const img = $(el).find('img').attr('src');

      if (name && img && img.includes('/card_images/')) {
        images.push({ name, img, quantity });
      }
    });

    res.json({ images });
  } catch (err) {
    console.error('Scraping failed:', err);
    res.status(500).json({ error: 'Failed to scrape deck page' });
  }
});

app.get('/', (req, res) => {
  res.send('MTG Proxy Scraper API is running ✅');
});

app.listen(PORT, () => {
  console.log(`MTG Proxy Scraper API running on port ${PORT}`);
});
