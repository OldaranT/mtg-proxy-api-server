
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/api/deck', async (req, res) => {
  const { url } = req.query;

  if (!url || (!url.includes('archidekt.com') && !url.includes('moxfield.com'))) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  console.log(`🔍 [START] Scraping deck from: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    if (url.includes('archidekt.com')) {
      console.log('🍃 Detected Archidekt, setting deckView cookie...');
      await page.setCookie({
        name: 'deckView',
        value: '4',
        domain: 'archidekt.com',
        path: '/',
        httpOnly: false,
        secure: true
      });
    }

    if (url.includes('moxfield.com')) {
      console.log('🧊 Detected Moxfield, setting state cookie for table view...');
      await page.setCookie({
        name: 'state',
        value: JSON.stringify({
          viewSettings: {
            groupBy: "type",
            sortBy: "name",
            useMana: false,
            usePrice: false,
            useSet: false,
            columns: "three",
            isHighlightBarEnabled: false,
            isDarkModeEnabled: true,
            playStyle: "paperEuros",
            viewMode: "table",
            personalDeckListMode: "list",
            viewAsAuthorIntends: true,
            splitPrimerWidth: 25,
            primerTheme: "default",
            foilMode: "animated",
            showLegalOnly: false,
            ignoreAuthorOverrides: false,
            allowMultiplePrintings: false,
            useTiers: false
          }
        }),
        domain: 'www.moxfield.com',
        path: '/',
        httpOnly: false,
        secure: true
      });
    }

    console.log("🌐 Navigating to page...");
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    let cards = [];

    if (url.includes('archidekt.com')) {
      console.log("📄 Scraping Archidekt table view...");
      cards = await page.evaluate(() => {
        const rows = document.querySelectorAll('.table_row');
        const data = [];

        rows.forEach((row) => {
          const nameEl = row.querySelector('.spreadsheetCard_cursorCard span');
          const qtyEl = row.querySelector('.spreadsheetCard_quantity input');
          const finishBtn = row.querySelector('.spreadsheetCard_modifier button');
          const setInput = row.querySelector('.spreadsheetCard_setName input');

          if (nameEl && qtyEl && finishBtn && setInput) {
            const name = nameEl.textContent.trim();
            const quantity = parseInt(qtyEl.value, 10) || 1;
            const foil = finishBtn.textContent.toLowerCase().includes('foil');

            const setText = setInput.placeholder || '';
            const match = setText.match(/\((\w+)\)\s*\((\d+)\)/);
            const setCode = match?.[1];
            const collectorNumber = match?.[2];

            if (name && setCode && collectorNumber) {
              data.push({ name, quantity, foil, setCode, collectorNumber });
            }
          }
        });

        return data;
      });
    }

    if (url.includes('moxfield.com')) {
      console.log("📄 Scraping Moxfield deck view...");
      cards = await page.evaluate(() => {
        const data = [];
        const cardEls = document.querySelectorAll('.decklist-card');

        cardEls.forEach(cardEl => {
          const name = cardEl.querySelector('.decklist-card-phantomsearch')?.textContent?.trim();
          const qtyText = cardEl.querySelector('.decklist-card-quantity')?.textContent?.trim().replace(/^x/i, '');
          const quantity = parseInt(qtyText || '1', 10);
          const img = cardEl.querySelector('img.img-card')?.src;

          if (name && quantity && img) {
            data.push({ name, quantity, img });
          }
        });

        return data;
      });
    }

    console.log(`✅ Extracted ${cards.length} card(s)`);

    let finalCards = [];

    if (url.includes('archidekt.com')) {
      for (const card of cards) {
        const apiUrl = `https://api.scryfall.com/cards/${card.setCode}/${card.collectorNumber}`;
        console.log(`🔗 Fetching Scryfall image for ${card.name}...`);
        try {
          const response = await fetch(apiUrl);
          const data = await response.json();
          const img = data?.image_uris?.normal;
          if (img) {
            finalCards.push({ ...card, img });
          }
        } catch (err) {
          console.error(`❌ Failed Scryfall fetch for ${card.name}`);
        }
      }
    } else {
      finalCards = cards;
    }

    await browser.close();
    res.json({ images: finalCards });
  } catch (err) {
    console.error("❌ Scrape failed:", err);
    res.status(500).json({ error: "Scrape failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
