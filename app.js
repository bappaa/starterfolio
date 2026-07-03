require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const expressLayouts = require('express-ejs-layouts');
const { nanoid } = require('nanoid');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { init, dbRun, dbGet, dbAll, dbTransaction } = require('./db');

const app = express();

// ---------- Resolve views/ and public/ reliably, even when bundled by Netlify/esbuild ----------
// When Netlify bundles this file into a single function, __dirname no longer points to the
// real project root the way it does locally — it can point one level too deep (inside
// netlify/functions/) or to a Lambda task root. We try every plausible location and use
// whichever one actually contains the folder, instead of hard-coding a single assumption.
function resolveProjectPath(folderName) {
  const candidates = [
    path.join(__dirname, folderName),                 // local `node server.js`
    path.join(__dirname, '..', '..', folderName),      // bundled inside netlify/functions/
    path.join(process.env.LAMBDA_TASK_ROOT || '', folderName), // AWS Lambda / Netlify Functions root
    path.join(process.cwd(), folderName),              // fallback: current working directory
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing matched — return the first candidate anyway so the error message at least
  // shows a sensible path instead of crashing on undefined.
  return candidates[0];
}

const viewsPath = resolveProjectPath('views');
const publicPath = resolveProjectPath('public');

app.set('view engine', 'ejs');
app.set('views', viewsPath);
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(publicPath));
app.use(cookieParser());

// Make sure the database schema + seed data exist before handling any request.
// (Cheap no-op after the first call — the promise is cached.)
app.use((req, res, next) => {
  init().then(() => next()).catch(next);
});

app.use(passport.initialize());

// ---------- Auth: signed JWT cookie (stateless — works on serverless hosts like Netlify) ----------
const JWT_SECRET = process.env.SESSION_SECRET || 'starterfolio-super-secret-key-change-in-prod';
const COOKIE_NAME = 'sf_auth';

function issueAuthCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// ---------- Google OAuth (Sign in with Google) ----------
// Only activates once GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set in .env
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleEnabled) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
      const avatar = profile.photos && profile.photos[0] && profile.photos[0].value;
      let user = await dbGet('SELECT * FROM users WHERE google_id = ?', [profile.id]);
      if (!user && email) {
        user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
      }
      if (user) {
        await dbRun('UPDATE users SET google_id = ?, avatar_url = ? WHERE id = ?', [profile.id, avatar || user.avatar_url, user.id]);
        user = await dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
      } else {
        const randomHash = bcrypt.hashSync(nanoid(24), 10);
        const apiKey = nanoid(32);
        const info = await dbRun(
          `INSERT INTO users (name, email, password_hash, api_key, google_id, avatar_url) VALUES (?, ?, ?, ?, ?, ?)`,
          [profile.displayName || 'Google User', email, randomHash, apiKey, profile.id, avatar]
        );
        user = await dbGet('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
      }
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }));
}

// ---------- Helpers ----------
async function getSettings() {
  const rows = await dbAll('SELECT key, value FROM settings');
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  return obj;
}

app.use(async (req, res, next) => {
  try {
    res.locals.currentUser = null;
    res.locals.settings = await getSettings();
    res.locals.path = req.path;
    res.locals.googleEnabled = googleEnabled;
    res.locals.upiGatewayEnabled = upiGatewayEnabled;
    res.locals.otpSignupEnabled = otpSignupEnabled;
    res.locals.siteBaseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const token = req.cookies[COOKIE_NAME];
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [payload.uid]);
        if (user && user.status === 'active') {
          res.locals.currentUser = user;
          req.user = user;
        }
      } catch (e) {
        // invalid/expired token — treat as logged out
      }
    }
    next();
  } catch (e) {
    next(e);
  }
});

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).send('Forbidden - Admin only');
  next();
}

// Surfaces a badge count of manual UPI payments awaiting admin review on every admin page,
// so it's impossible to miss customers waiting on approval no matter which admin page you're on.
app.use('/admin', requireAuth, requireAdmin, ah(async (req, res, next) => {
  const row = await dbGet(`SELECT COUNT(*) c FROM transactions WHERE method='Manual UPI' AND status='Review'`);
  res.locals.pendingDepositCount = row ? row.c : 0;
  next();
}));

function fmtMoney(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}
app.locals.fmtMoney = fmtMoney;

function genOrderNo() {
  return 'SF' + Date.now().toString(36).toUpperCase() + nanoid(4).toUpperCase();
}

// Wrap async route handlers so thrown errors reach Express's error handler instead of hanging.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- Email (SMTP) — shared by admin order alerts and signup OTP verification ----------
const smtpEnabled = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const emailEnabled = !!(smtpEnabled && process.env.ADMIN_NOTIFY_EMAIL);
let mailTransporter = null;
if (smtpEnabled) {
  const smtpPort = parseInt(process.env.SMTP_PORT, 10) || 465;
  // `secure: true` (implicit TLS) is only correct for port 465. Every other port —
  // including 587 (STARTTLS), which most providers like Brevo/SendGrid/Mailgun use —
  // needs `secure: false`. Mixing these up is a very common misconfiguration that causes
  // emails to silently fail, so we auto-correct it here and warn loudly if we had to.
  const requestedSecure = process.env.SMTP_SECURE !== 'false';
  const correctSecure = smtpPort === 465;
  if (requestedSecure !== correctSecure) {
    console.warn(
      `⚠️  SMTP_SECURE=${requestedSecure} looks wrong for SMTP_PORT=${smtpPort}. ` +
      `Port 465 needs SMTP_SECURE=true; every other port (587, 2525, etc.) needs SMTP_SECURE=false. ` +
      `Auto-correcting to secure=${correctSecure} for this run — please fix the SMTP_SECURE ` +
      `environment variable so this warning goes away.`
    );
  }
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: correctSecure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Whether new signups require verifying an emailed OTP before the account is created.
// Automatically disabled if SMTP isn't configured, so the site never gets stuck unable
// to let anyone sign up just because email credentials haven't been set yet.
const otpSignupEnabled = smtpEnabled;

// The visible "From" address. Brevo (and most transactional email providers) require the
// From address to be a verified sender in their dashboard — the SMTP_USER login (e.g.
// xxxxx@smtp-brevo.com) is just a credential, not a real mailbox, and using it as "From"
// is a common reason emails get silently rejected or dropped. Set SMTP_FROM to a
// real address you've verified in Brevo → Senders, Domains & Dedicated IPs; falls back to
// SMTP_USER if not set (works fine for providers like Gmail where the login IS a real inbox).
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER;

async function sendOtpEmail(toEmail, name, otp, settings) {
  const subject = `Your ${settings.site_name} verification code: ${otp}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#6c5ce7;">Verify your email</h2>
      <p>Hi ${name || 'there'},</p>
      <p>Use the code below to finish creating your ${settings.site_name} account. This code expires in 10 minutes.</p>
      <div style="font-size: 32px; font-weight: 800; letter-spacing: 8px; background:#f4f4f8; color:#111; padding: 18px 24px; border-radius: 10px; text-align:center; margin: 20px 0;">${otp}</div>
      <p style="color:#888; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>`;
  const info = await mailTransporter.sendMail({
    from: `"${settings.site_name}" <${SMTP_FROM}>`,
    to: toEmail,
    subject,
    html,
  });
  console.log(`OTP email dispatched to ${toEmail} — messageId: ${info.messageId}, response: ${info.response}`);
  return info;
}

async function notifyAdminNewOrder({ orderNo, user, service, link, quantity, charge }) {
  if (!emailEnabled) return;
  const settings = await getSettings();
  const subject = `🛒 New Order ${orderNo} — ${service.name}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color:#6c5ce7;">New Order Received on ${settings.site_name}</h2>
      <p>A customer just placed an order that needs to be fulfilled manually.</p>
      <table style="width:100%; border-collapse: collapse; margin-top:16px;">
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Order #</strong></td><td style="padding:8px; border:1px solid #ddd;">${orderNo}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Service</strong></td><td style="padding:8px; border:1px solid #ddd;">${service.name} (${service.service_code || ''})</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Link</strong></td><td style="padding:8px; border:1px solid #ddd;"><a href="${link}">${link}</a></td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Quantity</strong></td><td style="padding:8px; border:1px solid #ddd;">${quantity.toLocaleString()}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Amount Charged</strong></td><td style="padding:8px; border:1px solid #ddd;">${settings.currency}${fmtMoney(charge)}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Customer</strong></td><td style="padding:8px; border:1px solid #ddd;">${user.name} (${user.email})</td></tr>
      </table>
      <p style="margin-top:20px;">Log in to your Admin Panel → Orders to update this order's status once delivered.</p>
    </div>`;
  try {
    const info = await mailTransporter.sendMail({
      from: `"${settings.site_name}" <${SMTP_FROM}>`,
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject,
      html,
    });
    console.log(`Order notification email dispatched — messageId: ${info.messageId}, response: ${info.response}`);
  } catch (err) {
    console.error('Failed to send order notification email:', err.message);
  }
}

// Emails the admin as soon as a customer submits a UTR for manual review, so approval can
// happen quickly instead of the customer waiting around indefinitely.
async function notifyAdminManualPayment({ txn, user }) {
  if (!emailEnabled) return;
  const settings = await getSettings();
  const subject = `💰 UPI Payment Submitted for Review — ${txn.reference}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color:#6c5ce7;">Manual UPI Payment Awaiting Approval</h2>
      <p>A customer has submitted a UTR for a wallet top-up. Review and approve it from the Admin Panel.</p>
      <table style="width:100%; border-collapse: collapse; margin-top:16px;">
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Reference</strong></td><td style="padding:8px; border:1px solid #ddd;">${txn.reference}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Amount</strong></td><td style="padding:8px; border:1px solid #ddd;">${settings.currency}${fmtMoney(txn.amount)}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>UTR / Transaction ID</strong></td><td style="padding:8px; border:1px solid #ddd;">${txn.gateway_payment_id || '<em>Not provided — match by amount, reference &amp; timing</em>'}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Customer</strong></td><td style="padding:8px; border:1px solid #ddd;">${user.name} (${user.email})</td></tr>
      </table>
      <p style="margin-top:20px;">Log in to your Admin Panel → Deposit Review to approve or reject this payment.</p>
    </div>`;
  try {
    const info = await mailTransporter.sendMail({
      from: `"${settings.site_name}" <${SMTP_FROM}>`,
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject,
      html,
    });
    console.log(`Manual payment review email dispatched — messageId: ${info.messageId}, response: ${info.response}`);
  } catch (err) {
    console.error('Failed to send manual payment review email:', err.message);
  }
}

// Emails the customer once their manual UPI payment has been approved or rejected.
async function notifyUserManualPaymentDecision({ txn, user, approved, adminNote }) {
  if (!emailEnabled) return; // reuse the same "is SMTP configured" flag
  const settings = await getSettings();
  const subject = approved
    ? `✅ Your wallet has been credited — ${settings.currency}${fmtMoney(txn.amount)}`
    : `⚠️ Your UPI payment could not be verified — ${txn.reference}`;
  const html = approved
    ? `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#22c55e;">Payment Confirmed</h2>
        <p>Hi ${user.name},</p>
        <p>Your payment of <strong>${settings.currency}${fmtMoney(txn.amount)}</strong> (reference ${txn.reference}) has been verified and credited to your wallet.</p>
      </div>`
    : `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#ef4444;">Payment Not Verified</h2>
        <p>Hi ${user.name},</p>
        <p>We could not verify your submitted payment of ${settings.currency}${fmtMoney(txn.amount)} (reference ${txn.reference}).</p>
        ${adminNote ? `<p><strong>Note from our team:</strong> ${adminNote}</p>` : ''}
        <p>If you believe this is a mistake, please open a support ticket with your UTR/transaction ID.</p>
      </div>`;
  try {
    await mailTransporter.sendMail({
      from: `"${settings.site_name}" <${SMTP_FROM}>`,
      to: user.email,
      subject,
      html,
    });
  } catch (err) {
    console.error('Failed to send payment decision email:', err.message);
  }
}

// ---------- UPIGateway (ekQR) — UPI payment gateway ----------
// Automatic UPI deposits: customer is redirected to a hosted UPI payment page (shows a
// dynamic QR + intent links), UPIGateway verifies the payment and calls our webhook, and
// we double-check with their Check Order Status API before crediting the wallet.
const upiGatewayEnabled = !!process.env.UPIGATEWAY_API_KEY;
const UPIGATEWAY_CREATE_ORDER_URL = 'https://api.ekqr.in/api/create_order';
const UPIGATEWAY_CHECK_STATUS_URL = 'https://api.ekqr.in/api/check_order_status';

// Small helper: format a Date as DD-MM-YYYY in IST (UTC+5:30), which is what UPIGateway's
// status API expects, since it's an Indian payment provider that records transactions in
// Indian time. Our server (Netlify Functions) always runs in UTC, so we must convert —
// otherwise, for any payment made late at night IST, the date sent to the "check status"
// API would be off by one day, causing it to report "transaction not found" for a payment
// that actually succeeded (exactly the "I paid but it shows failed" symptom).
function formatDateDDMMYYYY_IST(date) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);
  const d = String(istDate.getUTCDate()).padStart(2, '0');
  const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const y = istDate.getUTCFullYear();
  return `${d}-${m}-${y}`;
}

// ============ PUBLIC PAGES ============
app.get('/', ah(async (req, res) => {
  const categories = await dbAll('SELECT * FROM categories ORDER BY sort_order');
  const featured = await dbAll('SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id WHERE s.featured=1 AND s.active=1 LIMIT 6');
  const stats = {
    services: (await dbGet('SELECT COUNT(*) c FROM services WHERE active=1')).c,
    orders: (await dbGet('SELECT COUNT(*) c FROM orders')).c,
    users: (await dbGet('SELECT COUNT(*) c FROM users')).c,
  };
  const settings = await getSettings();

  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: settings.site_name,
        url: res.locals.siteBaseUrl,
        description: 'Cheap Instagram, Facebook, YouTube, Telegram, TikTok and X (Twitter) marketing services — followers, likes, views and more, delivered instantly.',
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Is it safe to buy Instagram followers and likes?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'Yes — our services deliver engagement gradually and use methods designed to align with normal platform activity patterns. We recommend keeping your account public while an order is processing for the best results.',
            },
          },
          {
            '@type': 'Question',
            name: 'How fast will I receive my order?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'Most orders start within minutes of payment confirmation. Delivery speed depends on the specific service — each service listing shows its average completion time.',
            },
          },
          {
            '@type': 'Question',
            name: 'What payment methods do you accept?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'We accept UPI payments (Google Pay, PhonePe, Paytm, BHIM and all other UPI apps) through a secure, instant payment gateway. Your wallet balance updates automatically the moment payment is confirmed.',
            },
          },
          {
            '@type': 'Question',
            name: "Do you offer refunds if an order doesn't complete?",
            acceptedAnswer: {
              '@type': 'Answer',
              text: "If an order can't be completed, contact our support team via a ticket from your dashboard and we'll review it promptly. Wallet balance is only ever charged once an order is successfully placed.",
            },
          },
        ],
      },
    ],
  });

  res.render('home', {
    title: 'Home',
    categories,
    featured,
    stats,
    seoTitle: `${settings.site_name} — Cheap Instagram, Facebook & YouTube Followers, Likes & Views | Buy SMM Services Online`,
    metaDescription: `Buy cheap Instagram followers, likes & views, Facebook page likes, YouTube subscribers, Telegram members, TikTok and X (Twitter) growth services at ${settings.site_name}. Instant delivery, secure UPI payments, 24/7 support. Starting at just ${settings.currency}0.20 per 1000.`,
    metaKeywords: 'cheap instagram followers, buy instagram likes, cheap smm panel, instagram views india, facebook likes cheap, youtube subscribers cheap, buy tiktok followers, cheap social media marketing panel india, instagram followers india, buy real instagram followers',
    structuredData,
  });
}));

app.get('/services', ah(async (req, res) => {
  const categories = await dbAll('SELECT * FROM categories ORDER BY sort_order');
  const q = (req.query.q || '').trim();
  const catId = req.query.category;
  let services;
  let activeCatName = '';
  if (q) {
    services = await dbAll(`SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id
      WHERE s.active=1 AND (s.name LIKE ? OR s.description LIKE ?) ORDER BY c.sort_order, s.id`, [`%${q}%`, `%${q}%`]);
  } else if (catId) {
    services = await dbAll(`SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id
      WHERE s.active=1 AND s.category_id=? ORDER BY s.id`, [catId]);
    const cat = categories.find(c => String(c.id) === String(catId));
    activeCatName = cat ? cat.name : '';
  } else {
    services = await dbAll(`SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id
      WHERE s.active=1 ORDER BY c.sort_order, s.id`);
  }
  const grouped = {};
  services.forEach(s => {
    if (!grouped[s.cat_name]) grouped[s.cat_name] = [];
    grouped[s.cat_name].push(s);
  });

  const settings = await getSettings();
  const pageTitle = q ? `Search results for "${q}"` : (activeCatName || 'All Services');
  const seoTitle = q
    ? `${pageTitle} · ${settings.site_name} SMM Panel`
    : (activeCatName
      ? `Buy ${activeCatName} Cheap Online | ${settings.site_name}`
      : `All Services — Cheap Instagram, Facebook, YouTube, Telegram, TikTok Services | ${settings.site_name}`);
  const metaDescription = activeCatName
    ? `Buy cheap ${activeCatName.toLowerCase()} instantly at ${settings.site_name}. Real, fast delivery, secure UPI payments, prices starting at ${settings.currency}0.20 per 1000. Trusted SMM panel for creators, businesses and influencers.`
    : `Browse ${services.length}+ SMM services — Instagram followers, likes, views, reels views, Facebook likes, YouTube subscribers, Telegram members, TikTok and X (Twitter) growth. Instant delivery, cheapest prices, UPI payments accepted.`;

  res.render('services', {
    title: pageTitle,
    categories,
    grouped,
    q,
    catId,
    seoTitle,
    metaDescription,
    metaKeywords: 'buy instagram followers cheap, instagram likes india, youtube subscribers cheap, facebook page likes, telegram members buy, tiktok followers cheap, smm panel india, instagram views cheap',
  });
}));

// ============ LEGAL PAGES ============
app.get('/terms', ah(async (req, res) => {
  const settings = await getSettings();
  res.render('legal', {
    title: 'Terms of Service',
    seoTitle: `Terms of Service · ${settings.site_name}`,
    metaDescription: `Terms and conditions for using ${settings.site_name}, a cheap Instagram, Facebook, YouTube and social media marketing services panel.`,
    content: `
      <p>By creating an account and using ${settings.site_name} ("we", "us", "our"), you agree to the following terms.</p>
      <h3 style="color:var(--text);">1. Services</h3>
      <p>${settings.site_name} provides social media marketing (SMM) services including but not limited to followers, likes, views, comments and related engagement for Instagram, Facebook, YouTube, Telegram, TikTok and X (Twitter). Orders are fulfilled using third-party engagement providers and delivery times shown are estimates, not guarantees.</p>
      <h3 style="color:var(--text);">2. Wallet & Payments</h3>
      <p>Funds added to your wallet are used exclusively to purchase services on this platform. Wallet balance is deducted only at the moment an order is successfully placed. Payments are processed via UPI through our payment gateway partner; we do not store your UPI PIN or banking credentials.</p>
      <h3 style="color:var(--text);">3. Account Responsibility</h3>
      <p>You are responsible for the accuracy of the links and information (usernames, post URLs, etc.) you submit when placing an order. Orders placed against private accounts, deleted content, or incorrect links may not be deliverable and are not eligible for automatic refund.</p>
      <h3 style="color:var(--text);">4. Platform Policy Compliance</h3>
      <p>You are responsible for ensuring your use of purchased engagement services complies with the terms of service of the social media platform you are using. ${settings.site_name} is not affiliated with, endorsed by, or sponsored by Instagram, Meta, Google, YouTube, TikTok, Telegram, or X Corp.</p>
      <h3 style="color:var(--text);">5. Changes</h3>
      <p>We may update these terms from time to time; continued use of the site after changes constitutes acceptance of the revised terms.</p>
      <h3 style="color:var(--text);">6. Contact</h3>
      <p>Questions about these terms can be sent to <a href="mailto:${settings.support_email}" style="color:var(--accent);">${settings.support_email}</a> or via a support ticket from your dashboard.</p>
    `,
  });
}));

app.get('/refund-policy', ah(async (req, res) => {
  const settings = await getSettings();
  res.render('legal', {
    title: 'Refund Policy',
    seoTitle: `Refund Policy · ${settings.site_name}`,
    metaDescription: `Refund and cancellation policy for orders placed on ${settings.site_name}.`,
    content: `
      <h3 style="color:var(--text);">Wallet Deposits</h3>
      <p>Funds added to your ${settings.site_name} wallet via UPI are non-refundable once credited, except in cases of a duplicate or erroneous charge, which will be investigated and refunded to the original payment method if confirmed.</p>
      <h3 style="color:var(--text);">Order Refunds</h3>
      <p>If an order fails to start or complete due to an issue on our end (e.g. the underlying service provider is unable to deliver), the order amount will be credited back to your wallet balance. Orders that fail due to incorrect information provided by the customer (private account, wrong link, deleted post, etc.) are not eligible for refund.</p>
      <h3 style="color:var(--text);">Partial Delivery</h3>
      <p>For services delivered gradually, if an order only partially completes, the undelivered portion's value will be credited back to your wallet upon review via a support ticket.</p>
      <h3 style="color:var(--text);">How to Request a Refund</h3>
      <p>Open a support ticket from your dashboard with your order number and a description of the issue. Our team typically reviews refund requests within 24–48 hours.</p>
    `,
  });
}));

app.get('/privacy-policy', ah(async (req, res) => {
  const settings = await getSettings();
  res.render('legal', {
    title: 'Privacy Policy',
    seoTitle: `Privacy Policy · ${settings.site_name}`,
    metaDescription: `How ${settings.site_name} collects, uses and protects your personal information.`,
    content: `
      <h3 style="color:var(--text);">Information We Collect</h3>
      <p>When you create an account, we collect your name and email address. When you place an order, we collect the link/username you submit and the order details. We do not collect or store payment card numbers, UPI PINs, or bank account credentials — payments are processed securely by our payment gateway partner.</p>
      <h3 style="color:var(--text);">How We Use Your Information</h3>
      <p>Your information is used to operate your account, process orders, communicate order/payment status, and provide customer support. We do not sell your personal information to third parties.</p>
      <h3 style="color:var(--text);">Cookies</h3>
      <p>We use a secure, encrypted cookie to keep you logged in. We do not use third-party advertising trackers.</p>
      <h3 style="color:var(--text);">Data Security</h3>
      <p>Passwords are stored using industry-standard one-way hashing (bcrypt) and are never stored or visible in plain text, including to our own staff.</p>
      <h3 style="color:var(--text);">Contact</h3>
      <p>For privacy-related questions or data deletion requests, contact <a href="mailto:${settings.support_email}" style="color:var(--accent);">${settings.support_email}</a>.</p>
    `,
  });
}));

// ============ AUTH ============
app.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('signup', { title: 'Sign Up', error: null });
});

// Step 1: validate the signup form, then either create the account immediately (if OTP
// verification isn't configured) or email a one-time code and hold the account details
// in a pending table until the code is confirmed. This keeps spam/throwaway signups down,
// since a working, accessible email address is required to finish creating the account.
app.post('/signup', ah(async (req, res) => {
  const { name, email, password, confirm_password } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();

  if (!name || !cleanEmail || !password) {
    return res.render('signup', { title: 'Sign Up', error: 'All fields are required.' });
  }
  if (password.length < 6) {
    return res.render('signup', { title: 'Sign Up', error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirm_password) {
    return res.render('signup', { title: 'Sign Up', error: 'Passwords do not match.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.render('signup', { title: 'Sign Up', error: 'Please enter a valid email address.' });
  }
  const existing = await dbGet('SELECT id FROM users WHERE email = ?', [cleanEmail]);
  if (existing) {
    return res.render('signup', { title: 'Sign Up', error: 'An account with this email already exists.' });
  }

  if (!otpSignupEnabled) {
    // Email/OTP not configured on this deployment — fall back to creating the account
    // directly, so signups are never blocked by a missing SMTP setup.
    const hash = bcrypt.hashSync(password, 10);
    const apiKey = nanoid(32);
    const info = await dbRun('INSERT INTO users (name, email, password_hash, api_key) VALUES (?, ?, ?, ?)',
      [name.trim(), cleanEmail, hash, apiKey]);
    issueAuthCookie(res, info.lastInsertRowid);
    return res.redirect('/dashboard');
  }

  // Rate-limit: don't let someone spam-request OTPs for the same email over and over.
  const recentOtp = await dbGet(
    `SELECT * FROM signup_otps WHERE email = ? AND created_at > datetime('now', '-60 seconds') ORDER BY id DESC LIMIT 1`,
    [cleanEmail]
  );
  if (recentOtp) {
    return res.redirect('/signup/verify?email=' + encodeURIComponent(cleanEmail) + '&notice=' + encodeURIComponent('A code was already sent recently — please wait a minute before requesting another.'));
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
  const otpHash = bcrypt.hashSync(otp, 8);
  const passwordHash = bcrypt.hashSync(password, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Clear out any older pending OTPs for this email before creating a fresh one.
  await dbRun('DELETE FROM signup_otps WHERE email = ?', [cleanEmail]);
  await dbRun(
    `INSERT INTO signup_otps (email, otp_hash, name, password_hash, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [cleanEmail, otpHash, name.trim(), passwordHash, expiresAt]
  );

  try {
    const settings = await getSettings();
    await sendOtpEmail(cleanEmail, name.trim(), otp, settings);
  } catch (err) {
    console.error('Failed to send signup OTP email:', err.message);
    return res.render('signup', { title: 'Sign Up', error: 'Could not send verification email. Please check your email address and try again, or contact support.' });
  }

  res.redirect('/signup/verify?email=' + encodeURIComponent(cleanEmail));
}));

// Step 2: customer enters the 6-digit code emailed to them; once correct, the real
// account is created from the details held in signup_otps and they're logged in.
app.get('/signup/verify', ah(async (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.redirect('/signup');
  res.render('signup_verify', { title: 'Verify Your Email', email, error: null, notice: req.query.notice || null });
}));

app.post('/signup/verify', ah(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const code = (req.body.otp || '').trim();
  const renderErr = (msg) => res.render('signup_verify', { title: 'Verify Your Email', email, error: msg, notice: null });

  if (!email || !code) return renderErr('Please enter the verification code.');

  const pending = await dbGet('SELECT * FROM signup_otps WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  if (!pending) return renderErr('No pending verification found for this email. Please sign up again.');

  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await dbRun('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    return renderErr('This code has expired. Please sign up again to get a new code.');
  }

  if (pending.attempts >= 5) {
    await dbRun('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    return renderErr('Too many incorrect attempts. Please sign up again to get a new code.');
  }

  if (!bcrypt.compareSync(code, pending.otp_hash)) {
    await dbRun('UPDATE signup_otps SET attempts = attempts + 1 WHERE id = ?', [pending.id]);
    return renderErr('Incorrect code. Please try again.');
  }

  // Code is correct — double-check the email wasn't registered in the meantime, then
  // create the real account and clean up the pending record.
  const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    await dbRun('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    return res.render('login', { title: 'Log In', error: 'This email is already registered. Please log in.' });
  }

  const apiKey = nanoid(32);
  const info = await dbRun('INSERT INTO users (name, email, password_hash, api_key) VALUES (?, ?, ?, ?)',
    [pending.name, email, pending.password_hash, apiKey]);
  await dbRun('DELETE FROM signup_otps WHERE id = ?', [pending.id]);

  issueAuthCookie(res, info.lastInsertRowid);
  res.redirect('/dashboard');
}));

// Lets the customer request a fresh code without re-entering their signup details,
// e.g. if the first email didn't arrive or the code expired.
app.post('/signup/resend', ah(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.redirect('/signup');

  const pending = await dbGet('SELECT * FROM signup_otps WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  if (!pending) return res.redirect('/signup');

  const recentOtp = await dbGet(
    `SELECT * FROM signup_otps WHERE email = ? AND created_at > datetime('now', '-60 seconds') ORDER BY id DESC LIMIT 1`,
    [email]
  );
  if (recentOtp) {
    return res.redirect('/signup/verify?email=' + encodeURIComponent(email) + '&notice=' + encodeURIComponent('Please wait a minute before requesting another code.'));
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = bcrypt.hashSync(otp, 8);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await dbRun('UPDATE signup_otps SET otp_hash=?, attempts=0, expires_at=?, created_at=datetime(\'now\') WHERE id=?',
    [otpHash, expiresAt, pending.id]);

  try {
    const settings = await getSettings();
    await sendOtpEmail(email, pending.name, otp, settings);
  } catch (err) {
    console.error('Failed to resend signup OTP email:', err.message);
  }

  res.redirect('/signup/verify?email=' + encodeURIComponent(email) + '&notice=' + encodeURIComponent('A new code has been sent to your email.'));
}));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Log In', error: null });
});

app.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE email = ?', [(email || '').toLowerCase().trim()]);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { title: 'Log In', error: 'Invalid email or password.' });
  }
  if (user.status !== 'active') {
    return res.render('login', { title: 'Log In', error: 'Your account has been suspended. Contact support.' });
  }
  issueAuthCookie(res, user.id);
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
}));

app.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/');
});

// ============ GOOGLE SIGN-IN ============
if (googleEnabled) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req, res) => {
      issueAuthCookie(res, req.user.id);
      res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
    }
  );
} else {
  app.get('/auth/google', (req, res) => {
    res.status(503).send('Google Sign-In is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the .env file to enable it.');
  });
}

// ============ DASHBOARD ============
app.get('/dashboard', requireAuth, ah(async (req, res) => {
  const orders = await dbAll(`SELECT o.*, s.name as service_name FROM orders o JOIN services s ON o.service_id=s.id
    WHERE o.user_id=? ORDER BY o.id DESC LIMIT 5`, [req.user.id]);
  const txns = await dbAll('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 5', [req.user.id]);
  const totalSpent = (await dbGet('SELECT COALESCE(SUM(charge),0) t FROM orders WHERE user_id=?', [req.user.id])).t;
  const totalOrders = (await dbGet('SELECT COUNT(*) c FROM orders WHERE user_id=?', [req.user.id])).c;
  res.render('dashboard', { title: 'Dashboard', orders, txns, totalSpent, totalOrders });
}));

// ============ WALLET / ADD FUNDS ============
// Two ways to add funds:
//  1. UPIGateway (automatic) — customer pays on a hosted page, verified server-to-server, no
//     manual step. Requires UPIGATEWAY_API_KEY.
//  2. Manual UPI QR (works without any payment gateway account/API) — a dynamic QR is
//     generated with your own UPI ID, the exact amount, and a unique reference baked in.
//     The customer pays, submits the UTR/transaction ID they see in their UPI app, and an
//     admin reviews + approves it with one click, crediting the wallet instantly. This is
//     the standard approach most SMM resellers use since real payment gateways generally
//     require GST/business registration most individuals reselling these services don't have.
app.get('/deposit', requireAuth, ah(async (req, res) => {
  const txns = await dbAll(`SELECT * FROM transactions WHERE user_id=? AND type='deposit' ORDER BY id DESC LIMIT 20`, [req.user.id]);
  const settings = await getSettings();
  const manualUpiEnabled = settings.manual_upi_enabled !== 'false' && !!settings.upi_id;
  res.render('deposit', { title: 'Add Funds', txns, error: req.query.error, success: req.query.success, manualUpiEnabled });
}));

// Step 1: customer picks an amount, we generate a unique reference code + a dynamic UPI QR
// (encodes your UPI ID, payee name, exact amount and the reference as a "note"/"tr" field
// so it's easy to match against your bank statement / UPI app payment history).
app.post('/deposit/manual/create', requireAuth, ah(async (req, res) => {
  const settings = await getSettings();
  if (settings.manual_upi_enabled === 'false' || !settings.upi_id) {
    return res.redirect('/deposit?error=' + encodeURIComponent('Manual UPI payment is not available right now. Please contact support.'));
  }
  const amount = parseFloat(req.body.amount);
  const minDep = parseFloat(settings.min_deposit) || 50;
  const maxDep = parseFloat(settings.max_deposit) || 50000;

  if (isNaN(amount) || amount < minDep || amount > maxDep) {
    return res.redirect('/deposit?error=' + encodeURIComponent(`Amount must be between ${settings.currency}${minDep} and ${settings.currency}${maxDep}.`));
  }

  // Short, human-friendly reference the customer can read off their UPI app / bank SMS and
  // that you can search for in your bank statement — e.g. SF-8F3K2Q.
  const refCode = 'SF-' + nanoid(6).toUpperCase();

  await dbRun(`INSERT INTO transactions (user_id, type, amount, method, status, reference, note)
    VALUES (?, 'deposit', ?, 'Manual UPI', 'Pending', ?, 'Awaiting payment — manual QR')`,
    [req.user.id, amount, refCode]);

  res.redirect('/deposit/manual/' + encodeURIComponent(refCode));
}));

// Step 2: show the QR + UPI ID + amount + reference, and a form for the customer to submit
// the UTR / UPI transaction ID once they've paid.
app.get('/deposit/manual/:ref', requireAuth, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE reference=? AND user_id=? AND method='Manual UPI'`, [req.params.ref, req.user.id]);
  if (!txn) return res.status(404).render('404', { title: 'Not Found' });

  const settings = await getSettings();
  const payeeName = settings.upi_payee_name || settings.site_name;
  // Standard UPI deep link — every UPI app (GPay, PhonePe, Paytm, BHIM, etc.) understands this
  // format and will pre-fill the payee, amount and a transaction note when scanned.
  const upiLink = `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(payeeName)}&am=${encodeURIComponent(txn.amount)}&cu=INR&tn=${encodeURIComponent(txn.reference)}`;
  const qrDataUrl = await QRCode.toDataURL(upiLink, { width: 320, margin: 1 });

  res.render('deposit_manual', {
    title: 'Complete UPI Payment',
    txn,
    settings,
    qrDataUrl,
    upiLink,
    error: req.query.error,
    submitted: req.query.submitted,
  });
}));

// Step 3: customer confirms they've paid, optionally including the UTR/transaction ID from
// their UPI app to help match the payment faster. UTR is NOT required — making it mandatory
// adds friction and some UPI apps make it a little fiddly to find, so "I've Paid" on its own
// is accepted and the admin matches by amount + reference + timing against their bank/UPI app.
app.post('/deposit/manual/:ref/submit', requireAuth, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE reference=? AND user_id=? AND method='Manual UPI'`, [req.params.ref, req.user.id]);
  if (!txn) return res.status(404).render('404', { title: 'Not Found' });

  if (txn.status !== 'Pending') {
    return res.redirect('/deposit/manual/' + encodeURIComponent(req.params.ref));
  }

  const utr = (req.body.utr || '').trim();

  await dbRun(`UPDATE transactions SET status='Review', gateway_payment_id=?, note=? WHERE id=?`,
    [utr || null, 'Awaiting admin approval', txn.id]);

  notifyAdminManualPayment({ txn: { ...txn, gateway_payment_id: utr }, user: req.user });

  res.redirect('/deposit/manual/' + encodeURIComponent(req.params.ref) + '?submitted=1');
}));

// Step 1: create an order with UPIGateway and redirect the customer to their hosted
// payment page (shows a live QR code + UPI intent links for GPay/PhonePe/Paytm/BHIM).
app.post('/deposit/create-order', requireAuth, ah(async (req, res) => {
  if (!upiGatewayEnabled) {
    return res.redirect('/deposit?error=' + encodeURIComponent('UPI payments are not configured yet. Please contact support.'));
  }
  const settings = await getSettings();
  const amount = parseFloat(req.body.amount);
  const minDep = parseFloat(settings.min_deposit) || 50;
  const maxDep = parseFloat(settings.max_deposit) || 50000;

  if (isNaN(amount) || amount < minDep || amount > maxDep) {
    return res.redirect('/deposit?error=' + encodeURIComponent(`Amount must be between ${settings.currency}${minDep} and ${settings.currency}${maxDep}.`));
  }

  const clientTxnId = 'SF' + Date.now().toString(36).toUpperCase() + nanoid(6).toUpperCase();
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUrl = `${baseUrl}/deposit/callback`;

  try {
    const response = await fetch(UPIGATEWAY_CREATE_ORDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: process.env.UPIGATEWAY_API_KEY,
        client_txn_id: clientTxnId,
        amount: String(amount),
        p_info: 'Wallet Top-up',
        customer_name: req.user.name,
        customer_email: req.user.email,
        customer_mobile: req.user.mobile || '9999999999',
        redirect_url: redirectUrl,
        udf1: String(req.user.id),
      }),
    });
    const data = await response.json();

    if (!data.status || !data.data || !data.data.payment_url) {
      console.error('UPIGateway order creation failed:', data);
      return res.redirect('/deposit?error=' + encodeURIComponent(data.msg || 'Could not initiate payment. Please try again.'));
    }

    await dbRun(`INSERT INTO transactions (user_id, type, amount, method, status, reference, note, gateway_order_id)
      VALUES (?, 'deposit', ?, 'UPI', 'Pending', ?, 'Wallet top-up via UPI', ?)`,
      [req.user.id, amount, clientTxnId, String(data.data.order_id)]);

    res.redirect(data.data.payment_url);
  } catch (err) {
    console.error('UPIGateway order creation error:', err.message);
    res.redirect('/deposit?error=' + encodeURIComponent('Could not initiate payment. Please try again.'));
  }
}));

// Step 2: after paying, UPIGateway redirects the browser back here with the transaction
// details as query params. We never trust query params alone — we call the Check Order
// Status API server-to-server to confirm the real status before crediting the wallet.
app.get('/deposit/callback', requireAuth, ah(async (req, res) => {
  const clientTxnId = req.query.client_txn_id;
  if (!clientTxnId) {
    return res.redirect('/deposit?error=' + encodeURIComponent('Missing transaction reference.'));
  }

  const result = await verifyAndCreditUpiPayment(clientTxnId);
  if (result.error) {
    return res.redirect('/deposit?error=' + encodeURIComponent(result.error));
  }
  res.redirect('/deposit?success=1');
}));

// Safety-net webhook: UPIGateway also calls this server-to-server (configured in your
// UPIGateway dashboard → API Keys & Webhooks → Webhook URL) so the wallet still gets
// credited automatically even if the customer closes their browser right after paying.
//
// GET handler: some dashboards (including this one) send a quick GET request to verify
// the webhook URL is reachable before saving it — this must return JSON, not our normal
// HTML 404 page, or the dashboard shows a "not valid JSON" error when you click Save/Update.
app.get('/webhooks/upigateway', (req, res) => {
  res.status(200).json({ status: true, msg: 'Webhook endpoint is live' });
});

app.post('/webhooks/upigateway', ah(async (req, res) => {
  const clientTxnId = req.body.client_txn_id;
  if (!clientTxnId) return res.status(200).json({ status: true, msg: 'ignored' });
  await verifyAndCreditUpiPayment(clientTxnId);
  res.status(200).json({ status: true, msg: 'ok' });
}));

// Calls UPIGateway's Check Order Status API for one specific date. Returns the parsed
// `data.data` object on a definitive "Transaction found" response, or null if the API
// couldn't find anything for that date (which we use to try an adjacent date next).
async function checkUpiOrderStatusForDate(clientTxnId, txnDate) {
  const response = await fetch(UPIGATEWAY_CHECK_STATUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: process.env.UPIGATEWAY_API_KEY,
      client_txn_id: clientTxnId,
      txn_date: txnDate,
    }),
  });
  const data = await response.json();
  if (data && data.status && data.data) return data.data;
  return null;
}

// Shared verification logic used by both the redirect callback and the webhook.
// Always re-checks the real status with UPIGateway's API — never trusts the caller.
async function verifyAndCreditUpiPayment(clientTxnId) {
  if (!upiGatewayEnabled) return { error: 'UPI payments are not configured.' };

  const txn = await dbGet(`SELECT * FROM transactions WHERE reference = ? AND type = 'deposit'`, [clientTxnId]);
  if (!txn) return { error: 'Transaction not found.' };
  if (txn.status === 'Completed') return { success: true, alreadyProcessed: true };

  try {
    // Our server runs in UTC, but UPIGateway (an Indian provider) records transactions in
    // IST. A payment made late at night IST can fall on a different calendar date in UTC.
    // To be safe against any clock-skew edge case, try IST-today first, then the day
    // before and after, and use whichever one the gateway actually recognizes.
    const createdAt = new Date(txn.created_at);
    const candidateDates = [
      formatDateDDMMYYYY_IST(createdAt),
      formatDateDDMMYYYY_IST(new Date(createdAt.getTime() - 24 * 60 * 60 * 1000)),
      formatDateDDMMYYYY_IST(new Date(createdAt.getTime() + 24 * 60 * 60 * 1000)),
    ];

    let result = null;
    for (const date of candidateDates) {
      result = await checkUpiOrderStatusForDate(clientTxnId, date);
      if (result) break;
    }

    if (!result) {
      return { error: 'Could not verify payment status yet. If money was deducted, it will reflect shortly — check back in a minute or contact support.' };
    }

    if (result.status === 'success') {
      await dbTransaction([
        { sql: `UPDATE transactions SET status='Completed', gateway_payment_id=? WHERE id=?`, args: [result.upi_txn_id || '', txn.id] },
        { sql: 'UPDATE users SET balance = balance + ? WHERE id = ?', args: [txn.amount, txn.user_id] },
      ]);
      return { success: true };
    } else if (result.status === 'failure') {
      await dbRun(`UPDATE transactions SET status='Failed' WHERE id=?`, [txn.id]);
      return { error: 'Payment failed or was cancelled.' };
    } else {
      return { error: 'Payment is still pending. Please wait a moment and check your Transactions page.' };
    }
  } catch (err) {
    console.error('UPIGateway status check error:', err.message);
    return { error: 'Could not verify payment status yet. If money was deducted, it will reflect shortly.' };
  }
}

// ============ PLACE ORDER ============
app.get('/order/:serviceId', requireAuth, ah(async (req, res) => {
  const service = await dbGet('SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id WHERE s.id=?', [req.params.serviceId]);
  if (!service || !service.active) return res.status(404).send('Service not found');
  res.render('order', { title: 'Place Order', service, error: null });
}));

app.post('/order/:serviceId', requireAuth, ah(async (req, res) => {
  const service = await dbGet('SELECT * FROM services WHERE id=?', [req.params.serviceId]);
  if (!service || !service.active) return res.status(404).send('Service not found');

  const link = (req.body.link || '').trim();
  const quantity = parseInt(req.body.quantity, 10);

  const renderErr = (msg) => res.render('order', { title: 'Place Order', service, error: msg });

  if (!link) return renderErr('Please enter a valid link.');
  if (isNaN(quantity) || quantity < service.min_order || quantity > service.max_order) {
    return renderErr(`Quantity must be between ${service.min_order} and ${service.max_order}.`);
  }

  const charge = Math.round((quantity / 1000) * service.rate_per_1000 * 100) / 100;
  const user = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
  const settings = await getSettings();

  if (user.balance < charge) {
    return renderErr(`Insufficient balance. This order costs ${settings.currency}${fmtMoney(charge)} but your balance is ${settings.currency}${fmtMoney(user.balance)}. Please add funds.`);
  }

  const orderNo = genOrderNo();
  await dbTransaction([
    { sql: 'UPDATE users SET balance = balance - ? WHERE id = ?', args: [charge, user.id] },
    { sql: `INSERT INTO orders (order_no, user_id, service_id, link, quantity, charge, status, remains) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      args: [orderNo, user.id, service.id, link, quantity, charge, quantity] },
    { sql: `INSERT INTO transactions (user_id, type, amount, method, status, reference, note) VALUES (?, 'purchase', ?, 'Wallet', 'Completed', ?, ?)`,
      args: [user.id, charge, orderNo, `Order for ${service.name}`] },
  ]);

  notifyAdminNewOrder({ orderNo, user, service, link, quantity, charge });

  res.redirect('/orders?placed=' + orderNo);
}));

// ============ ORDERS LIST ============
app.get('/orders', requireAuth, ah(async (req, res) => {
  const orders = await dbAll(`SELECT o.*, s.name as service_name, s.avg_time FROM orders o JOIN services s ON o.service_id=s.id
    WHERE o.user_id=? ORDER BY o.id DESC`, [req.user.id]);
  res.render('orders', { title: 'My Orders', orders, placed: req.query.placed });
}));

// ============ TRANSACTIONS ============
app.get('/transactions', requireAuth, ah(async (req, res) => {
  const txns = await dbAll('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC', [req.user.id]);
  res.render('transactions', { title: 'Transaction History', txns, notice: req.query.notice, noticeType: req.query.noticeType });
}));

// Lets a customer manually re-check a pending/failed UPI deposit against UPIGateway's real
// status — useful if money was actually deducted but the initial redirect/verification
// missed it (e.g. they closed the tab, or a transient network hiccup).
app.post('/transactions/:id/recheck', requireAuth, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE id=? AND user_id=? AND type='deposit'`, [req.params.id, req.user.id]);
  if (!txn) return res.redirect('/transactions?noticeType=error&notice=' + encodeURIComponent('Transaction not found.'));

  const result = await verifyAndCreditUpiPayment(txn.reference);
  if (result.success) {
    return res.redirect('/transactions?noticeType=success&notice=' + encodeURIComponent(result.alreadyProcessed ? 'This payment was already credited.' : 'Payment confirmed! Your wallet has been credited.'));
  }
  res.redirect('/transactions?noticeType=error&notice=' + encodeURIComponent(result.error || 'Could not verify this payment right now.'));
}));

// ============ PROFILE ============
app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'My Profile', message: null, error: null });
});

app.post('/profile', requireAuth, ah(async (req, res) => {
  const { name } = req.body;
  await dbRun('UPDATE users SET name=? WHERE id=?', [name.trim(), req.user.id]);
  res.render('profile', { title: 'My Profile', message: 'Profile updated successfully.', error: null });
}));

app.post('/profile/password', requireAuth, ah(async (req, res) => {
  const { current_password, new_password } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.render('profile', { title: 'My Profile', message: null, error: 'Current password is incorrect.' });
  }
  if (!new_password || new_password.length < 6) {
    return res.render('profile', { title: 'My Profile', message: null, error: 'New password must be at least 6 characters.' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await dbRun('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
  res.render('profile', { title: 'My Profile', message: 'Password changed successfully.', error: null });
}));

app.post('/profile/regenerate-key', requireAuth, ah(async (req, res) => {
  const key = nanoid(32);
  await dbRun('UPDATE users SET api_key=? WHERE id=?', [key, req.user.id]);
  res.render('profile', { title: 'My Profile', message: 'API key regenerated.', error: null });
}));

// ============ TICKETS / SUPPORT ============
app.get('/tickets', requireAuth, ah(async (req, res) => {
  const tickets = await dbAll('SELECT * FROM tickets WHERE user_id=? ORDER BY id DESC', [req.user.id]);
  res.render('tickets', { title: 'Support Tickets', tickets });
}));

app.get('/tickets/new', requireAuth, ah(async (req, res) => {
  const orders = await dbAll('SELECT id, order_no FROM orders WHERE user_id=? ORDER BY id DESC', [req.user.id]);
  res.render('ticket_new', { title: 'New Ticket', orders, error: null });
}));

app.post('/tickets/new', requireAuth, ah(async (req, res) => {
  const { subject, order_id, message } = req.body;
  if (!subject || !message) {
    const orders = await dbAll('SELECT id, order_no FROM orders WHERE user_id=? ORDER BY id DESC', [req.user.id]);
    return res.render('ticket_new', { title: 'New Ticket', orders, error: 'Subject and message are required.' });
  }
  const info = await dbRun('INSERT INTO tickets (user_id, subject, order_id) VALUES (?, ?, ?)',
    [req.user.id, subject.trim(), order_id || null]);
  await dbRun('INSERT INTO ticket_messages (ticket_id, sender, message) VALUES (?, ?, ?)',
    [info.lastInsertRowid, 'user', message.trim()]);
  res.redirect('/tickets/' + info.lastInsertRowid);
}));

app.get('/tickets/:id', requireAuth, ah(async (req, res) => {
  const ticket = await dbGet('SELECT * FROM tickets WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!ticket) return res.status(404).send('Ticket not found');
  const messages = await dbAll('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id', [ticket.id]);
  res.render('ticket_view', { title: 'Ticket #' + ticket.id, ticket, messages, isAdmin: false });
}));

app.post('/tickets/:id/reply', requireAuth, ah(async (req, res) => {
  const ticket = await dbGet('SELECT * FROM tickets WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!ticket) return res.status(404).send('Ticket not found');
  await dbRun('INSERT INTO ticket_messages (ticket_id, sender, message) VALUES (?, ?, ?)',
    [ticket.id, 'user', req.body.message.trim()]);
  await dbRun(`UPDATE tickets SET status='Open' WHERE id=?`, [ticket.id]);
  res.redirect('/tickets/' + ticket.id);
}));

// ============ API (simple) ============
app.post('/api/v2', ah(async (req, res) => {
  const { key, action } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE api_key=?', [key]);
  if (!user) return res.json({ error: 'Invalid API key' });

  if (action === 'balance') {
    return res.json({ balance: fmtMoney(user.balance), currency: 'INR' });
  }
  if (action === 'services') {
    const services = await dbAll('SELECT id as service, name, rate_per_1000 as rate, min_order as min, max_order as max FROM services WHERE active=1');
    return res.json(services);
  }
  if (action === 'add') {
    const service = await dbGet('SELECT * FROM services WHERE id=?', [req.body.service]);
    if (!service) return res.json({ error: 'Invalid service ID' });
    const quantity = parseInt(req.body.quantity, 10);
    const link = req.body.link;
    if (!link || isNaN(quantity) || quantity < service.min_order || quantity > service.max_order) {
      return res.json({ error: 'Invalid link or quantity' });
    }
    const charge = Math.round((quantity / 1000) * service.rate_per_1000 * 100) / 100;
    if (user.balance < charge) return res.json({ error: 'Not enough funds' });
    const orderNo = genOrderNo();
    await dbTransaction([
      { sql: 'UPDATE users SET balance = balance - ? WHERE id = ?', args: [charge, user.id] },
      { sql: `INSERT INTO orders (order_no, user_id, service_id, link, quantity, charge, status, remains) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?)`,
        args: [orderNo, user.id, service.id, link, quantity, charge, quantity] },
      { sql: `INSERT INTO transactions (user_id, type, amount, method, status, reference, note) VALUES (?, 'purchase', ?, 'API', 'Completed', ?, ?)`,
        args: [user.id, charge, orderNo, `API order for ${service.name}`] },
    ]);
    notifyAdminNewOrder({ orderNo, user, service, link, quantity, charge });
    return res.json({ order: orderNo });
  }
  if (action === 'status') {
    const order = await dbGet('SELECT * FROM orders WHERE order_no=? AND user_id=?', [req.body.order, user.id]);
    if (!order) return res.json({ error: 'Order not found' });
    return res.json({ charge: fmtMoney(order.charge), status: order.status, remains: order.remains });
  }
  return res.json({ error: 'Unknown action' });
}));

// ============ ADMIN ============
app.get('/admin', requireAuth, requireAdmin, ah(async (req, res) => {
  const stats = {
    users: (await dbGet('SELECT COUNT(*) c FROM users')).c,
    orders: (await dbGet('SELECT COUNT(*) c FROM orders')).c,
    revenue: (await dbGet(`SELECT COALESCE(SUM(charge),0) t FROM orders`)).t,
    deposits: (await dbGet(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='deposit' AND status='Completed'`)).t,
    pendingOrders: (await dbGet(`SELECT COUNT(*) c FROM orders WHERE status='Pending'`)).c,
    openTickets: (await dbGet(`SELECT COUNT(*) c FROM tickets WHERE status='Open'`)).c,
    pendingDeposits: (await dbGet(`SELECT COUNT(*) c FROM transactions WHERE method='Manual UPI' AND status='Review'`)).c,
  };
  const recentOrders = await dbAll(`SELECT o.*, u.name as user_name, s.name as service_name FROM orders o
    JOIN users u ON o.user_id=u.id JOIN services s ON o.service_id=s.id ORDER BY o.id DESC LIMIT 10`);
  const recentUsers = await dbAll('SELECT * FROM users ORDER BY id DESC LIMIT 5');
  res.render('admin/dashboard', { title: 'Admin Dashboard', stats, recentOrders, recentUsers, layout: 'admin/layout' });
}));

app.get('/admin/users', requireAuth, requireAdmin, ah(async (req, res) => {
  const users = await dbAll('SELECT * FROM users ORDER BY id DESC');
  res.render('admin/users', { title: 'Manage Users', users, layout: 'admin/layout' });
}));

app.post('/admin/users/:id/balance', requireAuth, requireAdmin, ah(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  const type = req.body.action_type;
  if (!isNaN(amount) && amount > 0) {
    const delta = type === 'deduct' ? -amount : amount;
    await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [delta, req.params.id]);
    await dbRun(`INSERT INTO transactions (user_id, type, amount, method, status, reference, note) VALUES (?, ?, ?, 'Admin', 'Completed', ?, ?)`,
      [req.params.id, type === 'deduct' ? 'admin_deduct' : 'admin_credit', amount, 'ADMIN' + Date.now(), 'Manual balance adjustment by admin']);
  }
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/status', requireAuth, requireAdmin, ah(async (req, res) => {
  await dbRun('UPDATE users SET status=? WHERE id=?', [req.body.status, req.params.id]);
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/role', requireAuth, requireAdmin, ah(async (req, res) => {
  await dbRun('UPDATE users SET role=? WHERE id=?', [req.body.role, req.params.id]);
  res.redirect('/admin/users');
}));

app.get('/admin/orders', requireAuth, requireAdmin, ah(async (req, res) => {
  const orders = await dbAll(`SELECT o.*, u.name as user_name, u.email as user_email, s.name as service_name FROM orders o
    JOIN users u ON o.user_id=u.id JOIN services s ON o.service_id=s.id ORDER BY o.id DESC`);
  res.render('admin/orders', { title: 'Manage Orders', orders, layout: 'admin/layout' });
}));

app.post('/admin/orders/:id/status', requireAuth, requireAdmin, ah(async (req, res) => {
  const { status, remains } = req.body;
  await dbRun('UPDATE orders SET status=?, remains=? WHERE id=?', [status, remains || 0, req.params.id]);
  res.redirect('/admin/orders');
}));

app.get('/admin/services', requireAuth, requireAdmin, ah(async (req, res) => {
  const services = await dbAll(`SELECT s.*, c.name as cat_name FROM services s JOIN categories c ON s.category_id=c.id ORDER BY c.sort_order, s.id`);
  const categories = await dbAll('SELECT * FROM categories ORDER BY sort_order');
  res.render('admin/services', { title: 'Manage Services', services, categories, layout: 'admin/layout' });
}));

app.post('/admin/services/new', requireAuth, requireAdmin, ah(async (req, res) => {
  const { category_id, name, description, rate_per_1000, min_order, max_order, avg_time, service_code } = req.body;
  await dbRun(`INSERT INTO services (category_id, service_code, name, description, rate_per_1000, min_order, max_order, avg_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [category_id, service_code || ('SVC-' + Date.now()), name, description, parseFloat(rate_per_1000), parseInt(min_order), parseInt(max_order), avg_time]);
  res.redirect('/admin/services');
}));

app.post('/admin/services/:id/edit', requireAuth, requireAdmin, ah(async (req, res) => {
  const { name, description, rate_per_1000, min_order, max_order, avg_time, category_id } = req.body;
  await dbRun(`UPDATE services SET name=?, description=?, rate_per_1000=?, min_order=?, max_order=?, avg_time=?, category_id=? WHERE id=?`,
    [name, description, parseFloat(rate_per_1000), parseInt(min_order), parseInt(max_order), avg_time, category_id, req.params.id]);
  res.redirect('/admin/services');
}));

app.post('/admin/services/:id/toggle', requireAuth, requireAdmin, ah(async (req, res) => {
  const s = await dbGet('SELECT active FROM services WHERE id=?', [req.params.id]);
  await dbRun('UPDATE services SET active=? WHERE id=?', [s.active ? 0 : 1, req.params.id]);
  res.redirect('/admin/services');
}));

app.post('/admin/services/:id/delete', requireAuth, requireAdmin, ah(async (req, res) => {
  await dbRun('DELETE FROM services WHERE id=?', [req.params.id]);
  res.redirect('/admin/services');
}));

app.get('/admin/categories', requireAuth, requireAdmin, ah(async (req, res) => {
  const categories = await dbAll('SELECT * FROM categories ORDER BY sort_order');
  res.render('admin/categories', { title: 'Manage Categories', categories, layout: 'admin/layout' });
}));

app.post('/admin/categories/new', requireAuth, requireAdmin, ah(async (req, res) => {
  const { name, icon } = req.body;
  const max = (await dbGet('SELECT MAX(sort_order) m FROM categories')).m || 0;
  await dbRun('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)', [name, icon || '⭐', max + 1]);
  res.redirect('/admin/categories');
}));

app.post('/admin/categories/:id/delete', requireAuth, requireAdmin, ah(async (req, res) => {
  const count = (await dbGet('SELECT COUNT(*) c FROM services WHERE category_id=?', [req.params.id])).c;
  if (count === 0) {
    await dbRun('DELETE FROM categories WHERE id=?', [req.params.id]);
  }
  res.redirect('/admin/categories');
}));

app.get('/admin/tickets', requireAuth, requireAdmin, ah(async (req, res) => {
  const tickets = await dbAll(`SELECT t.*, u.name as user_name, u.email as user_email FROM tickets t JOIN users u ON t.user_id=u.id ORDER BY t.id DESC`);
  res.render('admin/tickets', { title: 'Support Tickets', tickets, layout: 'admin/layout' });
}));

app.get('/admin/tickets/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const ticket = await dbGet(`SELECT t.*, u.name as user_name, u.email as user_email FROM tickets t JOIN users u ON t.user_id=u.id WHERE t.id=?`, [req.params.id]);
  if (!ticket) return res.status(404).send('Not found');
  const messages = await dbAll('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id', [ticket.id]);
  res.render('admin/ticket_view', { title: 'Ticket #' + ticket.id, ticket, messages, layout: 'admin/layout' });
}));

app.post('/admin/tickets/:id/reply', requireAuth, requireAdmin, ah(async (req, res) => {
  await dbRun('INSERT INTO ticket_messages (ticket_id, sender, message) VALUES (?, ?, ?)',
    [req.params.id, 'admin', req.body.message.trim()]);
  await dbRun(`UPDATE tickets SET status=? WHERE id=?`, [req.body.status || 'Answered', req.params.id]);
  res.redirect('/admin/tickets/' + req.params.id);
}));

app.get('/admin/transactions', requireAuth, requireAdmin, ah(async (req, res) => {
  const txns = await dbAll(`SELECT tr.*, u.name as user_name, u.email as user_email FROM transactions tr JOIN users u ON tr.user_id=u.id ORDER BY tr.id DESC LIMIT 300`);
  res.render('admin/transactions', { title: 'All Transactions', txns, notice: req.query.notice, noticeType: req.query.noticeType, layout: 'admin/layout' });
}));

// Admin tool: manually re-verify any customer's pending/failed UPI deposit against
// UPIGateway's real status — for cases where a customer paid but the automatic
// verification missed it (e.g. closed the browser, or a timezone/date edge case).
app.post('/admin/transactions/:id/recheck', requireAuth, requireAdmin, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE id=? AND type='deposit'`, [req.params.id]);
  if (!txn) return res.redirect('/admin/transactions?noticeType=error&notice=' + encodeURIComponent('Transaction not found.'));

  const result = await verifyAndCreditUpiPayment(txn.reference);
  if (result.success) {
    return res.redirect('/admin/transactions?noticeType=success&notice=' + encodeURIComponent(result.alreadyProcessed ? 'Already credited.' : 'Payment confirmed and wallet credited.'));
  }
  res.redirect('/admin/transactions?noticeType=error&notice=' + encodeURIComponent(result.error || 'Could not verify this payment right now.'));
}));

// ============ ADMIN: MANUAL UPI DEPOSIT REVIEW ============
// Lists every manual-QR deposit that's waiting on a human decision (customer has submitted
// a UTR) plus ones still awaiting payment, so the admin has one place to manage the whole
// manual-payment queue day-to-day.
app.get('/admin/deposits', requireAuth, requireAdmin, ah(async (req, res) => {
  const pendingReview = await dbAll(`SELECT tr.*, u.name as user_name, u.email as user_email FROM transactions tr
    JOIN users u ON tr.user_id=u.id WHERE tr.method='Manual UPI' AND tr.status='Review' ORDER BY tr.id DESC`);
  const awaitingPayment = await dbAll(`SELECT tr.*, u.name as user_name, u.email as user_email FROM transactions tr
    JOIN users u ON tr.user_id=u.id WHERE tr.method='Manual UPI' AND tr.status='Pending' ORDER BY tr.id DESC LIMIT 50`);
  const recentDecisions = await dbAll(`SELECT tr.*, u.name as user_name, u.email as user_email FROM transactions tr
    JOIN users u ON tr.user_id=u.id WHERE tr.method='Manual UPI' AND tr.status IN ('Completed','Rejected') ORDER BY tr.reviewed_at DESC LIMIT 30`);
  res.render('admin/deposits', {
    title: 'Manual UPI Deposit Review',
    pendingReview, awaitingPayment, recentDecisions,
    notice: req.query.notice, noticeType: req.query.noticeType,
    layout: 'admin/layout',
  });
}));

// One click: mark a submitted UTR as verified, credit the wallet, and email the customer.
app.post('/admin/deposits/:id/approve', requireAuth, requireAdmin, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE id=? AND method='Manual UPI'`, [req.params.id]);
  if (!txn) return res.redirect('/admin/deposits?noticeType=error&notice=' + encodeURIComponent('Transaction not found.'));
  if (txn.status === 'Completed') return res.redirect('/admin/deposits?noticeType=error&notice=' + encodeURIComponent('This payment was already approved.'));

  const user = await dbGet('SELECT * FROM users WHERE id=?', [txn.user_id]);

  await dbTransaction([
    { sql: `UPDATE transactions SET status='Completed', reviewed_by=?, reviewed_at=datetime('now'), admin_note=? WHERE id=?`,
      args: [req.user.id, (req.body.note || '').trim() || null, txn.id] },
    { sql: 'UPDATE users SET balance = balance + ? WHERE id = ?', args: [txn.amount, txn.user_id] },
  ]);

  notifyUserManualPaymentDecision({ txn, user, approved: true });

  res.redirect('/admin/deposits?noticeType=success&notice=' + encodeURIComponent(`Approved — ${user.name}'s wallet credited with ${(await getSettings()).currency}${fmtMoney(txn.amount)}.`));
}));

// One click: reject a submitted UTR (e.g. fake/duplicate/mismatched amount) with an
// optional note explaining why, which gets emailed to the customer.
app.post('/admin/deposits/:id/reject', requireAuth, requireAdmin, ah(async (req, res) => {
  const txn = await dbGet(`SELECT * FROM transactions WHERE id=? AND method='Manual UPI'`, [req.params.id]);
  if (!txn) return res.redirect('/admin/deposits?noticeType=error&notice=' + encodeURIComponent('Transaction not found.'));
  if (txn.status === 'Completed') return res.redirect('/admin/deposits?noticeType=error&notice=' + encodeURIComponent('This payment was already approved and cannot be rejected.'));

  const user = await dbGet('SELECT * FROM users WHERE id=?', [txn.user_id]);
  const note = (req.body.note || '').trim() || 'Could not be verified against our bank records.';

  await dbRun(`UPDATE transactions SET status='Rejected', reviewed_by=?, reviewed_at=datetime('now'), admin_note=? WHERE id=?`,
    [req.user.id, note, txn.id]);

  notifyUserManualPaymentDecision({ txn, user, approved: false, adminNote: note });

  res.redirect('/admin/deposits?noticeType=success&notice=' + encodeURIComponent('Payment rejected and customer notified.'));
}));

app.get('/admin/settings', requireAuth, requireAdmin, ah(async (req, res) => {
  res.render('admin/settings', { title: 'Site Settings', settings: await getSettings(), message: null, layout: 'admin/layout' });
}));

app.post('/admin/settings', requireAuth, requireAdmin, ah(async (req, res) => {
  const fields = ['site_name', 'currency', 'upi_id', 'upi_payee_name', 'min_deposit', 'max_deposit', 'support_email'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      await dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [f, req.body[f]]);
    }
  }
  // Checkboxes only appear in the submitted form data when checked, so its absence means "off".
  const manualUpiValue = req.body.manual_upi_enabled === 'on' ? 'true' : 'false';
  await dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['manual_upi_enabled', manualUpiValue]);

  res.render('admin/settings', { title: 'Site Settings', settings: await getSettings(), message: 'Settings updated successfully.', layout: 'admin/layout' });
}));

// Diagnostic tool: sends a real test email through the configured SMTP transport so you can
// see the exact success/failure reason instead of guessing why an OTP or order alert didn't
// arrive. Visit as an admin: /admin/test-email?to=your-address@example.com
app.get('/admin/test-email', requireAuth, requireAdmin, ah(async (req, res) => {
  if (!smtpEnabled) {
    return res.status(200).send('SMTP is not configured (SMTP_USER / SMTP_PASS missing) — nothing to test.');
  }
  const to = (req.query.to || req.user.email || '').trim();
  if (!to) return res.status(400).send('Add ?to=youremail@example.com to the URL.');

  try {
    await mailTransporter.verify();
  } catch (err) {
    return res.status(200).send(
      `SMTP CONNECTION FAILED before even trying to send.\n\n` +
      `Host: ${process.env.SMTP_HOST}\nPort: ${process.env.SMTP_PORT}\nSecure: ${process.env.SMTP_SECURE}\n\n` +
      `Error: ${err.message}\n\n` +
      `This usually means wrong host/port/secure combination, or wrong SMTP_USER/SMTP_PASS.`
    );
  }

  try {
    const settings = await getSettings();
    const info = await mailTransporter.sendMail({
      from: `"${settings.site_name}" <${SMTP_FROM}>`,
      to,
      subject: `Test email from ${settings.site_name}`,
      html: `<p>This is a test email to confirm SMTP is working correctly. If you received this, sending works!</p><p>From address used: <code>${SMTP_FROM}</code></p>`,
    });
    res.status(200).send(
      `SMTP ACCEPTED the message — this means sending itself worked.\n\n` +
      `From: ${SMTP_FROM}\nTo: ${to}\nMessage ID: ${info.messageId}\nServer response: ${info.response}\n\n` +
      `If it still doesn't arrive in the inbox within a couple of minutes:\n` +
      `1. Check the Spam/Junk folder.\n` +
      `2. In Brevo, go to Senders, Domains & Dedicated IPs and confirm "${SMTP_FROM}" is listed as a VERIFIED sender — ` +
      `Brevo silently drops emails from unverified senders even though the SMTP command appears to succeed.\n` +
      `3. Check Brevo's dashboard → Transactional → Logs for this exact email to see its real delivery status.`
    );
  } catch (err) {
    res.status(200).send(
      `SMTP REJECTED the message while sending.\n\n` +
      `From: ${SMTP_FROM}\nTo: ${to}\n\n` +
      `Error: ${err.message}\n\n` +
      `If this mentions the sender address, it usually means "${SMTP_FROM}" is not a verified sender in your ` +
      `Brevo account — go to Senders, Domains & Dedicated IPs in Brevo and verify it, or set SMTP_FROM to an ` +
      `address you've already verified there.`
    );
  }
}));

// ============ SEO: robots.txt & sitemap.xml ============
app.get('/robots.txt', (req, res) => {
  const base = res.locals.siteBaseUrl;
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /admin
Disallow: /dashboard
Disallow: /orders
Disallow: /transactions
Disallow: /profile
Disallow: /tickets
Disallow: /deposit
Disallow: /order/
Disallow: /api/
Disallow: /webhooks/

Sitemap: ${base}/sitemap.xml`
  );
});

app.get('/sitemap.xml', ah(async (req, res) => {
  const base = res.locals.siteBaseUrl;
  const categories = await dbAll('SELECT * FROM categories ORDER BY sort_order');

  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/services', priority: '0.9', changefreq: 'daily' },
    { loc: '/login', priority: '0.3', changefreq: 'monthly' },
    { loc: '/signup', priority: '0.5', changefreq: 'monthly' },
  ];
  const categoryUrls = categories.map(c => ({
    loc: `/services?category=${c.id}`,
    priority: '0.7',
    changefreq: 'weekly',
  }));

  const allUrls = [...staticUrls, ...categoryUrls];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => `  <url>
    <loc>${base}${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.type('application/xml').send(xml);
}));

// ============ 404 & error handling ============
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

module.exports = app;
