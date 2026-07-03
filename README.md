# Starterfolio — SMM Panel Website

A full-stack Instagram/YouTube/Facebook/Telegram/X/TikTok services marketplace with wallet-based ordering, built with Node.js, Express, EJS, and a free cloud database (Turso) — deployable to Netlify so **it's live 24/7 without your laptop ever needing to be on.**

## Features
- Signup / Login with email + password (bcrypt-hashed), plus **Sign in with Google**
- **Email OTP verification on signup** — new accounts must confirm a 6-digit code emailed to them before the account is created, cutting down on spam/fake signups (see below)
- **Automatic UPI wallet top-ups via UPIGateway** — customer pays with any UPI app on a hosted QR/UPI payment page, balance credits instantly, zero manual approval
- Full service catalog (75+ Instagram/YouTube/Facebook/Telegram/X/TikTok services)
- Order placement with automatic balance deduction
- Email alert to you on every new order (for manual fulfillment)
- Order history, transaction history, support tickets
- Admin Panel: manage users, orders, services, categories, tickets, transactions, settings
- **Runs on Netlify's free plan + a free cloud database — no server to keep on, no laptop needed**

---

## 🚀 Going live for free (step-by-step)

Your site needs two free accounts: a place to store data that never resets (**Turso**), and a place to run the website (**Netlify**). Both together cost **$0/month** for a new business at your current scale.

### Step 1 — Push this project to GitHub (~2 minutes)
1. Go to [github.com/join](https://github.com/join) and create a free account if you don't have one.
2. Create a new **empty** repository (e.g. named `starterfolio`) at [github.com/new](https://github.com/new) — don't add a README/gitignore, keep it empty.
3. In this project folder, run:
   ```bash
   cd starterfolio
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/starterfolio.git
   git push -u origin main
   ```
   (GitHub will show you this exact command with your username after you create the repo — just copy-paste it.)

### Step 2 — Create your free database on Turso (~3 minutes)
1. Go to [turso.tech](https://turso.tech) and sign up (free tier: 500 databases, 9GB storage — way more than you'll need starting out).
2. Once logged in, create a new database (name it e.g. `starterfolio`).
3. Open the database and find:
   - **Database URL** — looks like `libsql://starterfolio-yourname.turso.io`
   - **Auth Token** — click "Create Token" if one isn't shown already
4. Keep these two values handy for Step 4.

### Step 3 — Deploy to Netlify (~3 minutes)
1. Go to [app.netlify.com/signup](https://app.netlify.com/signup) and sign up (free — the "Starter" plan is what you want, no credit card needed).
2. Click **Add new site → Import an existing project → Deploy with GitHub**.
3. Authorize Netlify to access your GitHub account, then pick the `starterfolio` repository you pushed in Step 1.
4. Netlify will auto-detect the settings from `netlify.toml` in this project — just click **Deploy**.
5. Your site will build and go live at a random URL like `https://random-name-123.netlify.app`. It's now running 24/7 — no laptop required.

### Step 4 — Add your environment variables in Netlify
This is the important part — your secrets (database, payments, email, Google login) live here, not in your code.
1. In your Netlify site dashboard: **Site configuration → Environment variables → Add a variable**.
2. Add each of these (copy the names exactly):

   | Key | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | from Step 2 |
   | `TURSO_AUTH_TOKEN` | from Step 2 |
   | `SESSION_SECRET` | any long random string (mash your keyboard, 40+ characters) |
   | `UPIGATEWAY_API_KEY` | from your UPIGateway dashboard → API Keys & Webhooks (see Payments section below) |
   | `PUBLIC_BASE_URL` | your live site URL, e.g. `https://your-site-name.netlify.app` |
   | `ADMIN_NOTIFY_EMAIL` | your email, to receive new-order alerts |
   | `SMTP_USER` / `SMTP_PASS` | your Gmail + App Password (see Emails section below) |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud Console (see Google Sign-In section below) |
   | `GOOGLE_CALLBACK_URL` | `https://your-site-name.netlify.app/auth/google/callback` |

3. After adding variables, go to **Deploys → Trigger deploy → Deploy site** so the new variables take effect.
4. (Optional but recommended) Under **Domain management**, connect your `starterfolio` domain to this Netlify site instead of the random `.netlify.app` URL.

That's it — your site is now permanently live, with real data that survives restarts, redeploys, and Netlify's serverless cold starts, and you never need to leave any device running.

---

## 💳 Payments — UPI only, fully automatic (UPIGateway)

This site uses **UPIGateway** (the merchant dashboard you're already signed up with) for wallet top-ups. When a customer clicks "Pay with UPI":
1. The site creates an order via UPIGateway's Create Order API and redirects the customer to UPIGateway's own hosted payment page (shows a live QR code + tap-to-pay links for GPay/PhonePe/Paytm/BHIM).
2. After paying, UPIGateway redirects the customer back to the site with a transaction reference.
3. The site **never trusts that redirect alone** — it calls UPIGateway's Check Order Status API server-to-server to confirm the real payment status before crediting the wallet.
4. As a safety net, UPIGateway's webhook also calls the site directly, so the wallet still credits automatically even if the customer closes their browser right after paying.

### Setup
1. In your UPIGateway dashboard, go to **API Keys & Webhooks** (the page shown in your screenshot).
2. Copy the **API Key** shown there into Netlify's `UPIGATEWAY_API_KEY` environment variable (Step 4 above).
3. In the same dashboard page, set the **Webhook URL** field to:
   ```
   https://your-site.netlify.app/webhooks/upigateway
   ```
   and click **Update Webhook**.
4. Set `PUBLIC_BASE_URL` in Netlify's environment variables to your real live site URL (e.g. `https://your-site-name.netlify.app`) — this is used to build the link UPIGateway sends customers back to after paying.
5. Redeploy. The "Pay with UPI" button on the Add Funds page activates automatically.

**Note on customer mobile numbers:** UPIGateway's Create Order API requires a customer mobile number. If a user hasn't provided one (the current version of this site doesn't collect it at signup), a placeholder number is sent — this doesn't affect the actual UPI payment or verification, only the customer info shown in your UPIGateway dashboard. If you'd like real customer phone numbers captured and sent instead, that's a small addition to the signup/profile forms — just ask.

## 🔑 Sign in with Google
1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → create/select a project → configure OAuth consent screen (External is fine).
2. Create an OAuth Client ID → **Web application**.
3. Authorized redirect URI: `https://your-site.netlify.app/auth/google/callback`
4. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` to Netlify env vars, redeploy.

## 📧 Order notification emails (and signup OTP — same SMTP setup powers both)
Every order emails `ADMIN_NOTIFY_EMAIL` with the order/service/link/quantity/amount/customer, and the same SMTP credentials also send the signup verification codes described below.

**Using Brevo (recommended):**
1. Sign up free at [app.brevo.com](https://app.brevo.com) (free tier: 300 emails/day, no credit card needed).
2. Go to **SMTP & API → SMTP tab** → copy your SMTP login (looks like `xxxxx@smtp-brevo.com`) and generate an SMTP key.
3. Set these exact values in Netlify's environment variables:
   ```
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=xxxxx@smtp-brevo.com
   SMTP_PASS=your-brevo-smtp-key
   ADMIN_NOTIFY_EMAIL=your-real-email@example.com
   ```
   **Important:** `SMTP_SECURE` must be `false` for port 587 — `true` is only correct for port 465. Getting this backwards is a very common mistake that causes emails to silently fail. (As a safety net, the app now auto-detects and auto-corrects this specific mismatch at startup with a console warning — but it's best to set it correctly from the start.)

**Alternative — Gmail with an App Password:**
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-16-character-app-password   # from https://myaccount.google.com/apppasswords (needs 2-Step Verification enabled)
```

⚠️ **Never paste real SMTP passwords/API keys into chat, tickets, or any document that isn't your own `.env` file or your hosting provider's environment variable settings.**

## ✅ Signup email verification (OTP) — reducing spam accounts
This uses the same `SMTP_USER` / `SMTP_PASS` credentials as order notification emails above — **no extra setup needed if you've already configured those.** It automatically activates as soon as `SMTP_USER` and `SMTP_PASS` are set (it does *not* require `ADMIN_NOTIFY_EMAIL` — that's only for order alerts).

**How it works:**
1. Customer fills in the signup form (name, email, password).
2. Instead of creating the account immediately, the site emails them a 6-digit code and holds their details in a temporary, unconfirmed record for 10 minutes.
3. They enter the code on a verification page. Only once it's confirmed correct is the real account actually created and they're logged in.
4. Built-in abuse protection: max 5 wrong attempts per code, a 60-second cooldown between resend requests, and codes expire after 10 minutes.

**Note:** users who sign up via "Continue with Google" skip this step entirely, since Google has already verified their email address for you.

**If SMTP isn't configured**, signups fall back to creating the account immediately with no OTP step — so the site is never accidentally blocked from accepting signups just because email credentials haven't been set up yet on a new deployment.

### "The OTP email never arrived" — how to actually diagnose it
Don't guess — log in as admin and go to **Admin → Settings → "Send Test Email to Myself"** (or visit `/admin/test-email?to=your-address@example.com` directly). This sends a real test email through your exact SMTP configuration and reports back the precise reason if it fails, instead of a generic "didn't arrive."

The single most common cause with **Brevo specifically**: the "From" address must be a **verified sender** in your Brevo account. Your `SMTP_USER` login (something like `xxxxx@smtp-brevo.com`) is just an authentication credential — it is *not* a real mailbox and can't be used as the visible sender address. Brevo will often accept the SMTP request without an error, then silently drop the email, which is why it can look like nothing went wrong on the code side while nothing arrives.

**Fix:**
1. In Brevo, go to **Senders, Domains & Dedicated IPs** → add and verify a real email address you own (e.g. the address you signed up to Brevo with, or a custom one like `support@yourdomain.com` once verified).
2. Set `SMTP_FROM` in your environment variables to that verified address.
3. Redeploy, then use the test-email tool above again to confirm.

Other things the test-email tool will catch: wrong password/API key, wrong host/port/secure combination, or your Brevo account being in a state that blocks sending (e.g. unconfirmed account, sending limit reached). Also check your **Spam/Junk folder** and Brevo's own dashboard under **Transactional → Logs**, which shows the real delivery status of every email Brevo attempted to send.

---

## Running locally (for testing changes before deploying)
```bash
cd starterfolio
npm install
node server.js
```
Visit `http://localhost:3000`. Without `TURSO_DATABASE_URL` set, it automatically uses a local file database — perfect for local testing, but remember the **live Netlify site needs Turso** to keep data permanently (see Step 2 above).

### Default admin account
`admin@starterfolio.com` / `Admin@123` — **change this immediately** after your first deploy (Admin → Users, or your own Profile page).

## Making changes after you're live
Any time you edit the code, just:
```bash
git add .
git commit -m "describe your change"
git push
```
Netlify automatically rebuilds and redeploys within a minute or two — no manual server restarts, no downtime for users.

## 🔍 SEO — getting found on Google

Some honesty up front: **no one can guarantee a first-page Google ranking** — not any developer, not any tool. Rankings depend on competition (established SMM panels have years of backlinks and history), site age, and real user engagement over time. What I *can* do — and have done — is implement every legitimate technical SEO fundamental properly, which gives you a real, honest shot at ranking as your site matures. Anyone promising guaranteed page-1 rankings for a brand-new site is not being straight with you.

### What's already built in
- **Unique, keyword-rich `<title>` and meta description on every page** (home, services, each category, legal pages) targeting real search terms like "cheap Instagram followers," "buy Instagram likes," "cheap SMM panel India"
- **Structured data (JSON-LD)** — `Organization` and `FAQPage` schema on the homepage, which can make your FAQs appear directly in Google search results as rich snippets
- **`sitemap.xml`** — lists every public page (home, services, all categories) so Google can discover everything efficiently
- **`robots.txt`** — tells search engines to crawl your storefront but skip private pages (dashboard, admin, orders, payments)
- **Proper heading structure** — one clear `<h1>` per page, logically nested `<h2>`s (this matters more than people think)
- **Genuine, useful on-page content** — an "About" section and FAQ on the homepage written in natural language that includes the terms people actually search for, not keyword-stuffed spam (Google penalizes that)
- **Real legal pages** (`/terms`, `/refund-policy`, `/privacy-policy`) — beyond compliance, having genuine policy pages is a small trust signal for both users and search engines
- **Open Graph / Twitter Card tags** — so links to your site look good when shared on WhatsApp, Facebook, Twitter, etc.

### What you should do next (things I can't do for you)
1. **Submit your site to [Google Search Console](https://search.google.com/search-console)** (free) — add your domain, verify ownership, and submit `https://your-domain.com/sitemap.xml`. This is the single most important step to get indexed at all; without it, Google may take weeks to find a new site on its own.
2. **Do the same on [Bing Webmaster Tools](https://www.bing.com/webmasters)** — smaller share of search traffic, but free and easy.
3. **Get backlinks** — links from other websites to yours (business directories, relevant forums, social media profiles) are one of the strongest ranking factors. This can't be faked convincingly, but it's very achievable over time.
4. **Keep adding real content** — a blog with genuinely useful posts ("How to grow your Instagram in 2026," "Instagram algorithm tips," etc.) targeting long-tail keywords is one of the most reliable ways small sites actually rank, since you're not competing head-on with huge established panels for the most generic terms.
5. **Connect your real `starterfolio` domain** instead of the `.netlify.app` subdomain — a custom domain is generally viewed more favorably and looks more trustworthy to both users and Google. Once connected, set `PUBLIC_BASE_URL` in your environment variables to that domain so all the SEO tags above point to the right URL.
6. **Be patient** — realistically, expect weeks to a few months of consistent traffic and content before seeing meaningful rankings for competitive terms, even with everything set up correctly. Long-tail, less competitive phrases (e.g. "buy Instagram views India cheap UPI payment") will likely rank faster than short generic ones ("Instagram followers").

## Troubleshooting

**"This function has crashed" — `Cannot find module '@libsql/linux-x64-gnu'`**
This happens because Netlify's function bundler (esbuild) tries to bundle the database driver's native binary incorrectly. It's already fixed in `netlify.toml` via the `external_node_modules = ["@libsql/client"]` setting, which tells Netlify to install that package normally via `npm install` instead of bundling it. If you ever see this error again after changing `netlify.toml`, make sure that line is still present, then **redeploy** (Deploys → Trigger deploy → Clear cache and deploy site).

**"Something went wrong" / 500 error, with `ConnectionFailed` mentioning a path like `/var/task/netlify/functions/data/starterfolio.db`**
This means `TURSO_DATABASE_URL` isn't set (or wasn't picked up on the last deploy) — add it under Site configuration → Environment variables, then Deploys → Trigger deploy → Clear cache and deploy site.

**"Something went wrong" / 500 error, with no obvious database message (views/templates not found)**
This was a path-resolution bug that's already fixed in `app.js`: when Netlify bundles the whole app into one function file, `__dirname` no longer points to the real project folder the way it does locally, so Express couldn't find `views/`/`public/`. The fix (`resolveProjectPath` in `app.js`) checks several possible locations and picks whichever one actually exists at runtime, so it works both locally and once bundled on Netlify. If you ever see this again, redeploy with cache cleared; if it persists, check the Netlify function logs for the exact error (Site → Functions → server → view logs).

**"Something went wrong" / 500 error, function logs show `Cannot find module 'ejs'`**
Express's view engine loads template engines (`ejs`) using a *dynamic* `require()` call buried inside Express's own code — esbuild can't see that at bundle time, so it doesn't automatically include `ejs` in the bundle. This is already fixed in `netlify.toml` by adding `ejs`, `express-ejs-layouts`, and `express` to `external_node_modules`, which tells Netlify to install and load them normally via `npm install` instead of trying to bundle them. If this error reappears, confirm those three packages are still listed there, then redeploy with cache cleared.

**"I paid but the site says the payment failed / stayed Pending"**
This was a real timezone bug that's now fixed: the server runs in UTC, but UPIGateway (an Indian provider) records transactions in IST (UTC+5:30). For payments made late at night IST, the date sent to the "Check Order Status" API could be off by one calendar day, making the gateway report "transaction not found" for a payment that actually succeeded. This is fixed — the app now converts to IST correctly, and also tries the adjacent day as a safety net. On top of that fix, there's now a **"🔄 Recheck" button** on both the customer's Transactions page and Admin → Transactions for any Pending/Failed deposit — clicking it re-verifies the real status directly with UPIGateway and credits the wallet if the payment actually went through. Use this for any customer (including past ones) who says they paid but their balance didn't update.

**General tip:** whenever you see a 500 error on the live site, the browser only shows a generic "Something went wrong" message on purpose (so real errors/stack traces are never exposed to visitors). The *actual* error is always in **Netlify → Logs → Functions → server → (click the failing invocation)** — always check there first.

## Project structure
```
starterfolio/
  app.js                     → the actual Express app (routes, auth, payments, admin) — shared by both entry points below
  server.js                  → local dev entry point (node server.js)
  netlify/functions/server.js → Netlify serverless entry point (used automatically when deployed)
  netlify.toml                → Netlify build/routing configuration
  db.js                       → database schema + seed data (Turso in production, local file in dev)
  .env                        → your local secrets (never committed — see .gitignore)
  views/                      → EJS templates (public site + admin panel)
  public/                     → CSS & JS assets
```
