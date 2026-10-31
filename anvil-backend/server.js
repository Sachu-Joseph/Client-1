'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Config. Values come from environment variables, or from a local .env file.
// ---------------------------------------------------------------------------
loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 12;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'trials.db');

if (ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD is missing or shorter than 8 characters. Set it in .env or the environment.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Admin logins will reset every time the server restarts.');
}
if (!ALLOWED_ORIGINS.length) {
  console.warn('ALLOWED_ORIGINS is not set. The enquiry form will accept requests from any website.');
}

const GOALS = ['Build strength', 'Lose fat', 'Prepare for a meet', 'Get started, not sure yet'];
const BATCHES = [
  'Early Lift, 5:30 AM',
  'Morning Circuit, 7:30 AM',
  "Women's Batch, 9:30 AM",
  'Evening Strength, 4 PM',
  'Prime Time, 7 PM',
  'Sunday Open, 6 AM',
];
const STATUSES = ['new', 'contacted', 'trial_booked', 'visited', 'joined', 'not_interested'];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS trials (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    goal       TEXT NOT NULL,
    batch      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trials_status ON trials(status);
  CREATE INDEX IF NOT EXISTS idx_trials_created ON trials(created_at);
  CREATE INDEX IF NOT EXISTS idx_trials_phone ON trials(phone);
`);

const q = {
  insert: db.prepare(`INSERT INTO trials (name, phone, goal, batch, created_at, updated_at)
                      VALUES (@name, @phone, @goal, @batch, @now, @now)`),
  recentByPhone: db.prepare('SELECT id FROM trials WHERE phone = ? AND created_at > ? LIMIT 1'),
  get: db.prepare('SELECT * FROM trials WHERE id = ?'),
  update: db.prepare('UPDATE trials SET status = @status, notes = @notes, updated_at = @now WHERE id = @id'),
  remove: db.prepare('DELETE FROM trials WHERE id = ?'),
  counts: db.prepare('SELECT status, COUNT(*) AS n FROM trials GROUP BY status'),
};

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---------------------------------------------------------------------------
// Public endpoint: free-trial enquiry from the gym website
// ---------------------------------------------------------------------------
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    const normalizedOrigin = origin.replace(/\/$/, '');
    const requestHost = req.headers.host;
    const sameHost = requestHost && (
      normalizedOrigin === `http://${requestHost}` ||
      normalizedOrigin === `https://${requestHost}`
    );
    const allowed = sameHost || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(normalizedOrigin);
    if (!allowed) return res.status(403).json({ error: 'This website is not allowed to send enquiries.' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Accepts 10-digit Indian mobile numbers, with or without +91 / 91 / 0 in front.
function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

app.options('/api/trials', cors);
app.post('/api/trials', cors, submitLimiter, (req, res) => {
  const body = req.body || {};

  // Hidden "website" field: real visitors leave it empty, bots fill it in.
  if (cleanText(body.website, 200)) return res.status(201).json({ ok: true });

  const name = cleanText(body.name, 80);
  const phone = normalizePhone(body.phone);
  const goal = cleanText(body.goal, 60);
  const batch = cleanText(body.batch, 60);

  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.', field: 'name' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.', field: 'phone' });
  if (!GOALS.includes(goal)) return res.status(400).json({ error: 'Choose a goal from the list.', field: 'goal' });
  if (!BATCHES.includes(batch)) return res.status(400).json({ error: 'Choose a batch from the list.', field: 'batch' });

  // Same number within 24 hours counts as the same enquiry.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (q.recentByPhone.get(phone, dayAgo)) return res.status(200).json({ ok: true, duplicate: true });

  q.insert.run({ name, phone, goal, batch, now: new Date().toISOString() });
  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin auth: password -> signed, httpOnly cookie
// ---------------------------------------------------------------------------
const COOKIE = 'anvil_admin';

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeSession() {
  const expires = String(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  return `${expires}.${sign(expires)}`;
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isLoggedIn(req) {
  const token = readCookie(req, COOKIE);
  const [expires, mac] = token.split('.');
  if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return safeEqual(mac, sign(expires));
}
function requireAdmin(req, res, next) {
  if (isLoggedIn(req)) return next();
  res.status(401).json({ error: 'Please log in.' });
}
function setCookie(res, value, maxAgeSeconds) {
  const flags = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (IS_PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = String((req.body || {}).password ?? '');
  if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password.' });
  setCookie(res, makeSession(), SESSION_HOURS * 3600);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
app.get('/api/admin/trials', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const search = cleanText(req.query.q, 80);
  const where = [];
  const params = {};
  if (STATUSES.includes(status)) { where.push('status = @status'); params.status = status; }
  if (search) {
    where.push('(name LIKE @like ESCAPE \'\\\' OR phone LIKE @like ESCAPE \'\\\')');
    params.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  }
  const sql = `SELECT * FROM trials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
  const rows = db.prepare(sql).all(params);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of q.counts.all()) counts[r.status] = r.n;
  res.json({ trials: rows, counts, statuses: STATUSES });
});

app.patch('/api/admin/trials/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? q.get.get(id) : null;
  if (!row) return res.status(404).json({ error: 'Enquiry not found.' });

  const body = req.body || {};
  let status = row.status;
  let notes = row.notes;
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'Unknown status.' });
    status = body.status;
  }
  if (body.notes !== undefined) notes = String(body.notes).replace(/\u0000/g, '').slice(0, 1000);

  q.update.run({ id, status, notes, now: new Date().toISOString() });
  res.json({ ok: true, trial: q.get.get(id) });
});

app.delete('/api/admin/trials/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = Number.isInteger(id) ? q.remove.run(id) : { changes: 0 };
  if (!info.changes) return res.status(404).json({ error: 'Enquiry not found.' });
  res.json({ ok: true });
});

// Spreadsheet formulas typed into a form could run when the CSV is opened in Excel,
// so cells that start with = + - @ are prefixed with an apostrophe.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM trials ORDER BY created_at DESC').all();
  const header = ['ID', 'Received (IST)', 'Name', 'Phone', 'Goal', 'Batch', 'Status', 'Notes'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const received = new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    lines.push([r.id, received, r.name, r.phone, r.goal, r.batch, r.status, r.notes].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="free-trial-enquiries.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ---------------------------------------------------------------------------
// Admin page (static files) and health check
// ---------------------------------------------------------------------------
app.get('/site/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'anvil-strength-club.html'));
});

const adminCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use('/admin', (req, res, next) => {
  res.setHeader('Content-Security-Policy', adminCsp);
  res.setHeader('Cache-Control', 'no-store');
  next();
}, express.static(path.join(__dirname, 'public'), { index: 'admin.html', redirect: true }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'anvil-strength-club.html')));

// JSON error responses
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`Anvil backend running on port ${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin/`);
});

// ---------------------------------------------------------------------------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
