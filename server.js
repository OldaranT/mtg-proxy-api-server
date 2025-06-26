const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:id', async (req, res) => {
  const deckId = req.params.id;
  const deckUrl = `https://archidekt.com/decks/${deckId}/?view=stacks`;

  console.log(`\n📥 [Puppeteer] Loading deck: ${deckUrl}`);

  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(deckUrl, { waitUntil: 'networkidle2' });

    // Wait for card images to be rendered
    await page.waitForSelector('img#basicCardImage', { timeout: 15000 });

    const content = await page.content();
    await browser.close();

    const $ = cheerio.load(content);
    const images = [];

    $('.imageCard_imageCard__x7s_J').each((_, el) => {
      const imgEl = $(el).find('img#basicCardImage');
      const qtyEl = $(el).find('button.cornerQuantity_cornerQuantity__or_QR');

      const name = imgEl.attr('alt')?.trim();
      const img = imgEl.attr('src');
      const quantity = parseInt(qtyEl.text().trim(), 10) || 1;

      if (name && img) {
        images.push({ name, img, quantity });
        console.log(`🃏 ${name} × ${quantity}`);
      }
    });

    res.json({ images });
  } catch (err) {
    console.error('❌ Puppeteer scrape failed:', err);
    res.status(500).json({ error: 'Scraping with Puppeteer failed' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ MTG Proxy API (with Puppeteer) is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
