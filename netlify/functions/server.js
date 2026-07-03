// Netlify Functions entry point — wraps the same Express app used for local dev
// so all routes (pages, admin panel, API, webhooks) work identically when deployed.
const serverless = require('serverless-http');
const app = require('../../app');

exports.handler = serverless(app);
