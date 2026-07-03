// Local development entry point. Run with: node server.js
// (On Netlify, netlify/functions/server.js is used instead — see README.)
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Starterfolio running at http://localhost:${PORT}`);
});
