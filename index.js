const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();

// View engine (EJS) setup – optional, but you have ejs installed
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Simple root route
app.get('/', (req, res) => {
  res.send('Hello from IS403Project3!');
});

// Use the port EB gives you, or 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});