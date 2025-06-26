const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// 🟣 Archidekt Proxy Endpoint
app.get('/api/archidekt/:id', async (req, res) => {
  const deckId = req.params.id;
  const archidektUrl = `https://archidekt.com/api/decks/${deckId}/small/`;

  try {
    const response = await fetch(archidektUrl);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deck.' });
  }
});

// 🟣 (Future) Scryfall Proxy Example
app.get('/api/scryfall/:name', async (req, res) => {
  const name = req.params.name;
  const scryfallUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;

  try {
    const response = await fetch(scryfallUrl);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch card from Scryfall.' });
  }
});

app.get('/', (req, res) => {
  res.send('MTG Proxy API Server is up and running ✅');
});

app.listen(PORT, () => {
  console.log(`MTG Proxy API server is running on port ${PORT}`);
});
