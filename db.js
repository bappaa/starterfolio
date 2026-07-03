const { createClient } = require('@libsql/client');
const path = require('path');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');

// ---------- Database connection ----------
// Production (Netlify + live site): set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
// (free cloud SQLite from https://turso.tech) so data survives restarts/redeploys/cold starts.
// Local development without those set: falls back to a local file database, so you can
// still run/test everything on your own machine with zero extra setup.
//
// IMPORTANT: Netlify Functions run on a read-only filesystem — a local file database
// can NEVER work there. If this code is running inside a Netlify Function (detected via
// the AWS_LAMBDA_FUNCTION_NAME env var Netlify sets under the hood) and TURSO_DATABASE_URL
// is missing, we fail immediately with a clear message instead of crashing with a
// confusing low-level SQLite error.
const isServerless = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

if (isServerless && !process.env.TURSO_DATABASE_URL) {
  throw new Error(
    'TURSO_DATABASE_URL is not set. This site is running on Netlify, which cannot use a local ' +
    'file database. Go to Netlify → Site configuration → Environment variables, add ' +
    'TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (from your turso.tech dashboard), then go to ' +
    'Deploys → Trigger deploy → Clear cache and deploy site.'
  );
}

const client = process.env.TURSO_DATABASE_URL
  ? createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  : createClient({ url: `file:${path.join(__dirname, 'data', 'starterfolio.db')}` });


// ---------- Thin async helpers (mimic the old better-sqlite3 shape) ----------
async function dbRun(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
}
async function dbGet(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  return result.rows[0] || null;
}
async function dbAll(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  return result.rows;
}
// Run several statements atomically (all-or-nothing) — used for balance +/- alongside inserts.
async function dbTransaction(statements) {
  // statements: array of { sql, args }
  await client.batch(statements.map(s => ({ sql: s.sql, args: s.args || [] })), 'write');
}

// Adds a column to an existing table only if it doesn't already exist — safe to run on
// every startup, so a live database can pick up new columns without a manual migration step.
async function ensureColumn(table, column, type) {
  const info = await dbAll(`PRAGMA table_info(${table})`);
  const exists = info.some(col => col.name === column);
  if (!exists) {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

let ready = null;
function init() {
  if (ready) return ready;
  ready = (async () => {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'user',
        api_key TEXT UNIQUE,
        google_id TEXT,
        avatar_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        icon TEXT,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        service_code TEXT UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        rate_per_1000 REAL NOT NULL,
        min_order INTEGER NOT NULL DEFAULT 100,
        max_order INTEGER NOT NULL DEFAULT 10000,
        avg_time TEXT DEFAULT 'Instant',
        quality TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        featured INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        service_id INTEGER NOT NULL,
        link TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        charge REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        remains INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        method TEXT,
        status TEXT NOT NULL DEFAULT 'Pending',
        reference TEXT,
        note TEXT,
        gateway_order_id TEXT,
        gateway_payment_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        order_id INTEGER,
        status TEXT NOT NULL DEFAULT 'Open',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS signup_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // ---------- Safe column migrations for existing databases ----------
    // (Can't use "CREATE TABLE IF NOT EXISTS ... new column" once a table already exists
    // in a live database, so new columns get added here, guarded by a table_info check.)
    await ensureColumn('transactions', 'admin_note', 'TEXT');
    await ensureColumn('transactions', 'reviewed_by', 'INTEGER');
    await ensureColumn('transactions', 'reviewed_at', 'TEXT');

    // ---------- Seed default settings ----------
    const defaultSettings = {
      site_name: 'Starterfolio',
      currency: '₹',
      upi_id: 'BHARATPE2Y0E014M7A58993@unitype',
      upi_payee_name: 'Starterfolio',
      min_deposit: '50',
      max_deposit: '50000',
      support_email: 'support@starterfolio.com',
      manual_upi_enabled: 'true',
    };
    for (const [k, v] of Object.entries(defaultSettings)) {
      const existing = await dbGet('SELECT value FROM settings WHERE key = ?', [k]);
      if (!existing) await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
    }

    // ---------- Seed admin user ----------
    const userCount = (await dbGet('SELECT COUNT(*) c FROM users')).c;
    if (userCount === 0) {
      const hash = bcrypt.hashSync('Admin@123', 10);
      await dbRun(
        `INSERT INTO users (name, email, password_hash, balance, role, api_key) VALUES (?, ?, ?, ?, 'admin', ?)`,
        ['Admin', 'admin@starterfolio.com', hash, 1000, nanoid(32)]
      );
    }

    // ---------- Seed categories & services ----------
    const catCount = (await dbGet('SELECT COUNT(*) c FROM categories')).c;
    if (catCount === 0) {
      await seedCatalog();
    }
  })();
  return ready;
}

async function seedCatalog() {
  const categories = [
    { key: 'ig_best', name: 'Instagram Best Services', icon: '⭐' },
    { key: 'ig_reels', name: 'Instagram Reels Views', icon: '🎬' },
    { key: 'ig_reels_country', name: 'Instagram Reels Views (Country Targeted)', icon: '🌍' },
    { key: 'ig_reels_extra', name: 'Instagram Reels Views (Extra Delivery)', icon: '🔥' },
    { key: 'ig_likes', name: 'Instagram Likes', icon: '❤️' },
    { key: 'ig_likes_in', name: 'Instagram Indian Likes', icon: '🇮🇳' },
    { key: 'ig_likes_tr', name: 'Instagram Turkey Likes Package', icon: '🇹🇷' },
    { key: 'ig_post_views', name: 'Instagram Post Views', icon: '👁️' },
    { key: 'ig_followers', name: 'Instagram Followers', icon: '👥' },
    { key: 'ig_followers_extra', name: 'Instagram Followers (Extra Delivery)', icon: '🚀' },
    { key: 'ig_followers_in', name: 'Instagram Indian Followers', icon: '🇮🇳' },
    { key: 'ig_comments', name: 'Instagram Comments', icon: '💬' },
    { key: 'ig_story', name: 'Instagram Story Views', icon: '📸' },
    { key: 'ig_share', name: 'Instagram Share', icon: '📤' },
    { key: 'ig_repost', name: 'Instagram Repost', icon: '🔁' },
    { key: 'ig_save', name: 'Instagram Save', icon: '💾' },
    { key: 'yt', name: 'YouTube Services', icon: '▶️' },
    { key: 'fb', name: 'Facebook Services', icon: '📘' },
    { key: 'tg', name: 'Telegram Services', icon: '✈️' },
    { key: 'tw', name: 'X / Twitter Services', icon: '🐦' },
    { key: 'tt', name: 'TikTok Services', icon: '🎵' },
  ];
  const catIds = {};
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    const info = await dbRun('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)', [c.name, c.icon, i]);
    catIds[c.key] = info.lastInsertRowid;
  }

  const services = [
    { cat: 'ig_best', code: 'IG-4951', name: 'Instagram Views [Max Unlimited]', description: 'All Link | Instant Start | Day 10M | ULTRA FAST', rate: 0.24, min: 100, max: 2147483647, time: '06 minutes', featured: 1 },
    { cat: 'ig_best', code: 'IG-4950', name: 'Instagram Likes [Max 5M]', description: 'HQ + Real Accounts | Non Drop | Cancel Enable | Lifetime | Instant Start | Day 100K', rate: 6.25, min: 1, max: 10000000, time: '32 minutes', featured: 1 },
    { cat: 'ig_best', code: 'IG-4952', name: 'Instagram Followers [Max 3M]', description: 'HQ Accounts | Instant Start | Cancel Enable | 90 Days | 20% Extra Delivery | Speed 500K/Day', rate: 70.85, min: 10, max: 3000000, time: '01 hour 42 min', featured: 1 },

    { cat: 'ig_reels', code: 'IG-4021', name: 'Instagram Reels Views', description: '5 Million/Day | Instant | Celebrities Favourite', rate: 0.28, min: 100, max: 10000000, time: '09 minutes' },
    { cat: 'ig_reels', code: 'IG-4214', name: 'Instagram Views [Max Unlimited]', description: 'All Link | Instant Start | Day 10M | ULTRA FAST', rate: 0.24, min: 100, max: 2147483647, time: '04 minutes' },
    { cat: 'ig_reels', code: 'IG-4118', name: 'Instagram Video Views [Max Unlimited]', description: 'All Link | Instant Start | Cancel Button | FAST COMPLETED', rate: 0.30, min: 100, max: 2147483647, time: '23 minutes' },
    { cat: 'ig_reels', code: 'IG-4215', name: 'Instagram Views [Max Unlimited] Cheap', description: 'All Link | Instant Start | Day 1M | ULTRA FAST', rate: 0.24, min: 100, max: 2147483647, time: '07 hours 11 min' },
    { cat: 'ig_reels', code: 'IG-4206', name: 'Instagram Views [Max Unlimited] Cheap', description: 'All Link | Instant Start | Day 500K | ULTRA FAST', rate: 0.25, min: 100, max: 2147483647, time: '08 minutes' },
    { cat: 'ig_reels', code: 'IG-4089', name: 'Instagram Video Views [Max Unlimited]', description: 'All Link | Cancel Enable | Day 1M', rate: 0.24, min: 10, max: 2147483647, time: '11 minutes' },

    { cat: 'ig_reels_country', code: 'IG-4939', name: '🇮🇳 Instagram Video Views [India]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '06 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4938', name: '🌍 Instagram Video Views [World Wide]', description: 'Max Unlimited | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '02 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4940', name: '🇹🇷 Instagram Video Views [Turkey]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '59 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4941', name: '🇮🇩 Instagram Video Views [Indonesia]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: 'Varies' },
    { cat: 'ig_reels_country', code: 'IG-4942', name: '🇦🇪 Instagram Video Views [UAE]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '36 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4943', name: '🇺🇸 Instagram Video Views [USA]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '08 hours 13 min' },
    { cat: 'ig_reels_country', code: 'IG-4944', name: '🇵🇰 Instagram Video Views [Pakistan]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '43 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4945', name: '🇧🇷 Instagram Video Views [Brazil]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '02 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4946', name: '🇨🇴 Instagram Video Views [Colombia]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '02 minutes' },
    { cat: 'ig_reels_country', code: 'IG-4947', name: '🇸🇦 Instagram Video Views [Saudi Arabia]', description: 'Max 1M | All Link | Ultrafast | ALWAYS STABLE', rate: 0.24, min: 10, max: 2147483647, time: '05 minutes' },

    { cat: 'ig_reels_extra', code: 'IG-4924', name: 'Instagram Video Views +30% Overflow', description: 'Max Unlimited | All Link - Video + Reels + IGTV | Day 200K | Ultrafast Complete', rate: 0.31, min: 100, max: 2147483647, time: '33 minutes' },
    { cat: 'ig_reels_extra', code: 'IG-4925', name: 'Instagram Video Views +40% Overflow', description: 'Max Unlimited | All Link - Video + Reels + IGTV | Day 200K | Ultrafast Complete', rate: 0.32, min: 100, max: 2147483647, time: '13 minutes' },
    { cat: 'ig_reels_extra', code: 'IG-4926', name: 'Instagram Video Views +50% Overflow', description: 'Max Unlimited | All Link - Video + Reels + IGTV | Day 200K | Ultrafast Complete', rate: 0.36, min: 100, max: 2147483647, time: '03 minutes' },
    { cat: 'ig_reels_extra', code: 'IG-4923', name: 'Instagram Video Views + Random Overflow', description: 'Max Unlimited | All Link - Video + Reels + IGTV | Speed 200K/Day | Ultrafast Complete', rate: 0.28, min: 100, max: 2147483647, time: '02 minutes' },

    { cat: 'ig_likes', code: 'IG-4114', name: 'Instagram Likes, Mix Quality', description: '30 Days refill | 500K/day', rate: 7.86, min: 10, max: 100000000, time: '08 minutes' },
    { cat: 'ig_likes', code: 'IG-4184', name: 'Instagram Likes [Max 5M]', description: 'HQ + Real Accounts | Non Drop | Cancel Enable | Lifetime | Instant Start | Day 100K', rate: 6.25, min: 1, max: 10000000, time: '24 minutes' },
    { cat: 'ig_likes', code: 'IG-4173', name: 'Instagram Likes [Max 1M]', description: 'Old Accounts | Low Drop | Cancel Enable | 30 Days | Instant Start | Day 50K', rate: 10.90, min: 100, max: 1000000, time: '17 minutes' },
    { cat: 'ig_likes', code: 'IG-4129', name: 'Instagram Likes [Max 5M]', description: 'HQ + Real Accounts | Non Drop | Cancel Enable | Lifetime | Instant Start | Day 100K', rate: 6.25, min: 1, max: 10000000, time: '31 minutes' },
    { cat: 'ig_likes', code: 'IG-4174', name: 'Instagram Likes [Max 20K]', description: 'HQ Accounts | Cancel Enable | Low Drop | No Refill | Instant Start | Day 100K', rate: 7.27, min: 10, max: 1000000, time: '03 hours 51 min' },
    { cat: 'ig_likes', code: 'IG-4209', name: 'Instagram Likes [Max 500K]', description: 'HQ Real Accounts | Cancel Enable | Low Drop | No Refill | Instant Start | Day 50K', rate: 11.45, min: 10, max: 500000, time: '06 hours 31 min' },

    { cat: 'ig_likes_in', code: 'IG-4096', name: 'Instagram Likes [100% India]', description: 'Max 500K | Old Accounts + Stories | No Drop | Instant Start | 30 Days | Speed 300K/Day', rate: 18.17, min: 50, max: 500000, time: '01 hour 17 min' },

    { cat: 'ig_likes_tr', code: 'IG-4936', name: 'Instagram Real Likes 100% Turkish', description: 'Quality | Maximum 1K', rate: 50.87, min: 1000, max: 1000, time: '03 hours 10 min' },

    { cat: 'ig_post_views', code: 'IG-4189', name: 'Instagram Views For Photos From Explorer', description: 'Max Unlimited | Instant Start | Cancel Enable | No Refill | Speed 200K/Day', rate: 1.63, min: 100, max: 10000000, time: '07 minutes' },

    { cat: 'ig_followers', code: 'IG-4207', name: 'Instagram Followers [Max 10M]', description: 'HQ Accounts With +6 Posts Account | Non Drop | 30 Days | Instant Start | Day 200K', rate: 65.40, min: 1, max: 10000000, time: '01 hour 21 min' },
    { cat: 'ig_followers', code: 'IG-4208', name: 'Instagram Followers [Max 10M]', description: 'HQ Accounts With +6 Posts Account | Non Drop | 90 Days | Instant Start | Day 200K', rate: 70.85, min: 1, max: 10000000, time: '12 minutes' },

    { cat: 'ig_followers_extra', code: 'IG-4927', name: 'Instagram Followers [Max 3M]', description: 'HQ Accounts | Instant Start | Cancel Enable | 30 Days | 20% Extra Delivery | Speed 500K/Day', rate: 61.76, min: 10, max: 3000000, time: '20 minutes' },
    { cat: 'ig_followers_extra', code: 'IG-4928', name: 'Instagram Followers [Max 3M]', description: 'HQ Accounts | Instant Start | Cancel Enable | 90 Days | 20% Extra Delivery | Speed 500K/Day', rate: 70.85, min: 10, max: 3000000, time: '29 minutes' },

    { cat: 'ig_followers_in', code: 'IG-4922', name: 'Instagram Followers [India]', description: 'Max 300K | 100% Old Accounts with Stories (Perfect Quality) | Low Drop | Instant Start | 30 Days | Speed 100K/Day', rate: 69.02, min: 10, max: 300000, time: '05 hours 26 min' },

    { cat: 'ig_comments', code: 'IG-4191', name: 'Instagram Comments [India] Random', description: 'Max 10K | HQ Profiles | Drop 0% | Lifetime | Start 0-1 Hour | Day 10K', rate: 89.02, min: 10, max: 10000, time: '03 hours 34 min' },
    { cat: 'ig_comments', code: 'IG-4192', name: 'Instagram Custom Comments', description: 'Max 10K | 100% Real Accounts | No Refill | Instant Start | Day 10K', rate: 89.02, min: 10, max: 10000, time: '02 hours 48 min' },

    { cat: 'ig_story', code: 'IG-4205', name: 'Instagram Story Views [Old Account With PP]', description: 'Day / 10K', rate: 45.42, min: 20, max: 10000, time: '01 hour 35 min' },
    { cat: 'ig_story', code: 'IG-4204', name: 'Instagram Story Views | OLD Mixed Accounts', description: '', rate: 31.06, min: 50, max: 1000000, time: '54 minutes' },
    { cat: 'ig_story', code: 'IG-5025', name: 'Instagram Story Views [Max 15K]', description: 'All Stories | No Refill | Instant Start | Day 15K', rate: 16.34, min: 10, max: 15000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5026', name: 'Instagram Story Views [Max 200K]', description: 'All Stories | No Refill | Instant Start | Day 200K', rate: 18.17, min: 100, max: 200000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5027', name: 'Instagram Story Views | HQ Real', description: 'Super Instant | Cancel Enable | No Refill | Speed 200K/Day', rate: 12.72, min: 100, max: 200000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5028', name: 'Instagram Story Views [Male]', description: 'Max 100K | HQ Real | Super Instant | No Refill | Day 100K', rate: 18.17, min: 100, max: 200000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5029', name: 'Instagram Story Views [All Stories]', description: 'Max 1M | High Quality | Instant | No Refill | Speed 200K/Day', rate: 27.25, min: 100, max: 10000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5030', name: 'Instagram Story Views [All Stories]', description: 'Max 10M | High Quality | Instant | Speed 500K/Day', rate: 36.34, min: 100, max: 10000, time: 'N/A' },
    { cat: 'ig_story', code: 'IG-5031', name: 'Instagram Story Views [Max 200K]', description: 'Real Accounts | Super Instant | Cancel Enable | No Refill | Speed 100K/Day', rate: 29.06, min: 100, max: 100000, time: 'N/A' },

    { cat: 'ig_share', code: 'IG-4183', name: 'Instagram Shares [Max 5M]', description: 'Super Fast | 30 Days | Cancel Enabled | 500K/Day', rate: 1.81, min: 100, max: 10000000, time: '35 minutes' },

    { cat: 'ig_repost', code: 'IG-4382', name: 'Instagram Repost + Reach [Worldwide]', description: 'Max 50K | 100% Real Accounts | Cancel Enable | Instant Start', rate: 78.11, min: 10, max: 50000, time: '04 hours 58 min' },
    { cat: 'ig_repost', code: 'IG-4380', name: 'Instagram Repost [Worldwide]', description: 'Max 10M | 100% Real Accounts | Cancel Enable | Instant Start', rate: 52.68, min: 100, max: 10000000, time: '35 minutes' },
    { cat: 'ig_repost', code: 'IG-4381', name: 'Instagram Repost [Worldwide]', description: 'Max 50K | 100% Real Accounts | Cancel Enable | Instant Start', rate: 69.02, min: 1, max: 50000, time: '05 hours 33 min' },
    { cat: 'ig_repost', code: 'IG-4383', name: 'Instagram Repost [Worldwide]', description: 'Max 1M | 100% Real Accounts | 30 Days | Instant Start', rate: 74.48, min: 1, max: 1000000, time: '08 hours 22 min' },
    { cat: 'ig_repost', code: 'IG-4384', name: 'Instagram Repost [Worldwide]', description: 'Max 1M | 100% Real Accounts | 30 Days | Instant Start', rate: 83.57, min: 10, max: 1000000, time: '05 hours 39 min' },

    { cat: 'ig_save', code: 'IG-4180', name: 'Instagram Save [Max 1M]', description: 'Instant', rate: 10.90, min: 10, max: 50000, time: '02 hours 04 min' },

    { cat: 'yt', code: 'YT-1001', name: 'YouTube Subscribers', description: 'Non Drop | Instant Start | Lifetime Guarantee', rate: 144.00, min: 10, max: 100000, time: '1 hour' },
    { cat: 'yt', code: 'YT-1002', name: 'YouTube Likes [Drop 0%]', description: 'High Quality Provider | Fast Start', rate: 22.20, min: 20, max: 500000, time: '30 minutes' },
    { cat: 'yt', code: 'YT-1003', name: 'YouTube Likes [Cheapest]', description: 'Fast | Real Users', rate: 11.88, min: 20, max: 500000, time: '20 minutes' },
    { cat: 'yt', code: 'YT-1004', name: 'YouTube Shorts / Video Views [India]', description: 'Instant Start | High Retention', rate: 6.72, min: 100, max: 1000000, time: '15 minutes' },
    { cat: 'yt', code: 'YT-1005', name: 'YouTube Shorts / Video Views', description: 'Worldwide | High Retention', rate: 5.04, min: 100, max: 5000000, time: '10 minutes' },
    { cat: 'yt', code: 'YT-1006', name: 'YouTube Live Stream Views', description: '100% Concurrent | Super Fast', rate: 300.00, min: 100, max: 10000, time: 'Instant' },

    { cat: 'fb', code: 'FB-2001', name: 'Facebook Page Followers', description: 'Fast Speed | Real Accounts', rate: 54.00, min: 100, max: 200000, time: '1 hour' },
    { cat: 'fb', code: 'FB-2002', name: 'Facebook Post Likes', description: 'High Quality | Fast', rate: 38.40, min: 50, max: 100000, time: '45 minutes' },
    { cat: 'fb', code: 'FB-2003', name: 'Facebook Video Views', description: 'Fast Working | Instant Start', rate: 4.20, min: 100, max: 1000000, time: '20 minutes' },
    { cat: 'fb', code: 'FB-2004', name: 'Facebook Post Reactions', description: 'High Quality | Fast', rate: 36.00, min: 50, max: 100000, time: '30 minutes' },
    { cat: 'fb', code: 'FB-2005', name: 'Facebook Shares', description: 'Real Users | Fast', rate: 30.00, min: 50, max: 50000, time: '1 hour' },

    { cat: 'tg', code: 'TG-3001', name: 'Telegram Channel Members', description: 'Real + Active | Cheapest', rate: 33.60, min: 100, max: 500000, time: '2 hours' },
    { cat: 'tg', code: 'TG-3002', name: 'Telegram Post Views', description: 'Instant Start | Fast', rate: 3.00, min: 100, max: 1000000, time: '10 minutes' },
    { cat: 'tg', code: 'TG-3003', name: 'Telegram Premium Members', description: 'Big Base VIP + Cheapest', rate: 39.60, min: 100, max: 200000, time: '2 hours' },

    { cat: 'tw', code: 'TW-4001', name: 'X / Twitter Followers', description: 'Real Accounts | Non Drop', rate: 78.00, min: 50, max: 100000, time: '1 hour' },
    { cat: 'tw', code: 'TW-4002', name: 'X / Twitter Tweet Views', description: 'Instant Start | Fast', rate: 2.16, min: 100, max: 5000000, time: '15 minutes' },
    { cat: 'tw', code: 'TW-4003', name: 'X / Twitter Likes', description: 'Fast | Real Users', rate: 24.00, min: 20, max: 100000, time: '30 minutes' },

    { cat: 'tt', code: 'TT-5001', name: 'TikTok Followers [Best Price]', description: 'Real Accounts | Non Drop', rate: 48.00, min: 50, max: 500000, time: '1 hour' },
    { cat: 'tt', code: 'TT-5002', name: 'TikTok Video Views', description: 'Super Fast | Instant Start', rate: 0.36, min: 100, max: 10000000, time: '5 minutes' },
    { cat: 'tt', code: 'TT-5003', name: 'TikTok Likes', description: 'Fast | HQ Accounts', rate: 9.60, min: 20, max: 500000, time: '20 minutes' },
  ];

  for (const s of services) {
    await dbRun(
      `INSERT INTO services (category_id, service_code, name, description, rate_per_1000, min_order, max_order, avg_time, quality, active, featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?)`,
      [catIds[s.cat], s.code, s.name, s.description || '', s.rate, s.min, s.max, s.time, s.featured || 0]
    );
  }
}

module.exports = { init, dbRun, dbGet, dbAll, dbTransaction, client };
