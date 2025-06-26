const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/archidekt/:deckId', async (req, res) => {
  const deckId = req.params.deckId;
  const url = `https://archidekt.com/decks/${deckId}`;

  console.log(`📥 Scraping Archidekt deck: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    console.log('🌐 Navigating to page...');
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for any basic card image to appear
    console.log('⏳ Waiting for card images...');
    await page.waitForSelector('img#basicCardImage', { timeout: 20000 });

    // Extract card data
    const cards = await page.evaluate(() => {
      const result = [];
      const cardEls = document.querySelectorAll('img#basicCardImage');

      cardEls.forEach(img => {
        const name = img.getAttribute('alt') || 'Unknown';
        const imgUrl = img.getAttribute('src');

        // Quantity is in the closest parent element's .cornerQuantity_cornerQuantity__or_QR button
        const container = img.closest('.imageCard_imageCard__x7s_J');
        const qtyEl = container?.querySelector('.cornerQuantity_cornerQuantity__or_QR');
        const quantity = qtyEl ? parseInt(qtyEl.textContent.trim(), 10) : 1;

        result.push({ name, img: imgUrl, quantity });
      });

      return result;
    });

    await browser.close();

    console.log(`✅ Found ${cards.length} cards`);
    res.json({ images: cards });
  } catch (error) {
    console.error('❌ Puppeteer scrape failed:', error);
    res.status(500).json({ error: 'Failed to scrape Archidekt deck' });
  }
});

app.get('/', (req, res) => {
  res.send('🧙‍♂️ MTG Proxy API is running!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
