const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}`;

  console.log(`📥 Fetching deck ${deckId} from: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    console.log('⏳ Waiting for cards to render...');
    await page.waitForSelector('img#basicCardImage');

    // Get all images and quantities
    const cards = await page.evaluate(() => {
      const result = [];
      const cardNodes = document.querySelectorAll('img#basicCardImage');

      cardNodes.forEach(img => {
        const parent = img.closest('.imageCard_imageCard__x7s_J');
        const quantityBtn = parent?.querySelector('.cornerQuantity_cornerQuantity__or_QR');
        const quantity = quantityBtn ? parseInt(quantityBtn.textContent.trim(), 10) : 1;

        result.push({
          name: img.getAttribute('alt') || 'Unknown',
          img: img.getAttribute('src'),
          quantity
        });
      });

      return result;
    });

    await browser.close();

    console.log(`✅ Found ${cards.length} cards`);
    res.json({ images: cards });
  } catch (error) {
    console.error('❌ Error scraping Archidekt:', error);
    res.status(500).json({ error: 'Failed to fetch deck images' });
  }
});

app.get('/', (req, res) => {
  res.send('MTG Proxy API is running');
});

app.listen(PORT, () => {
  console.log(`🚀 MTG Proxy API server is running on port ${PORT}`);
});
