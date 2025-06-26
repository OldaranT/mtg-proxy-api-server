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

  console.log(`\n📥 [REQUEST] Fetching deck ${deckId} from Archidekt`);
  console.log(`🌐 Target URL: ${deckUrl}`);

  try {
    const htmlRes = await fetch(deckUrl);
    console.log(`🔄 Fetch status: ${htmlRes.status}`);

    if (!htmlRes.ok) {
      console.error(`❌ Failed to fetch Archidekt deck page (status ${htmlRes.status})`);
      return res.status(htmlRes.status).json({ error: 'Failed to fetch Archidekt deck page' });
    }

    const html = await htmlRes.text();
    const $ = cheerio.load(html);

    const images = [];
    const cardBlocks = $('[data-card-quantity]');
    console.log(`🔍 Found ${cardBlocks.length} card quantity blocks`);

    cardBlocks.each((_, el) => {
      const quantity = parseInt($(el).attr('data-card-quantity')) || 1;
      const imgEl = $(el).find('img#basicCardImage');
      const img = imgEl.attr('src');
      const name = imgEl.attr('alt');

      if (name && img && img.includes('/card_images/')) {
        console.log(`🃏 Found card: ${name} ×${quantity}`);
        images.push({ name, img, quantity });
      } else {
        console.warn(`⚠️ Skipping block — Missing valid image or name`);
      }
    });

    console.log(`✅ Total cards returned: ${images.length}`);

    res.json({ images });
  } catch (err) {
    console.error('❌ Exception while scraping:', err);
    res.status(500).json({ error: 'Failed to scrape deck page' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ MTG Proxy Scraper API is running with verbose logging');
});

app.listen(PORT, () => {
  console.log(`🚀 MTG Proxy Scraper API running on port ${PORT}`);
});
