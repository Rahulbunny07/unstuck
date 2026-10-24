const crypto = require('crypto');
const { promisify } = require('util');
const { db } = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'unstuck_sid';
const SESSION_DAYS = 14;

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}

function validateSignup({ email, password, name }) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(e)) return { error: 'Enter a valid email address.' };
  const p = String(password || '');
  if (p.length < 8) return { error: 'Use a password with at least 8 characters.' };
  if (p.length > 128) return { error: 'That password is too long (128 characters max).' };
  return { email: e, password: p, name: String(name || '').trim().slice(0, 60) };
}

async function createUser({ email, password, name }) {
  const hash = await hashPassword(password);
  try {
    const info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(email, name, hash);
    return { id: Number(info.lastInsertRowid), email, name };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: 'exists' };
    throw e;
  }
}

async function checkLogin(email, password) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Always run a hash so a missing account takes about as long as a wrong password.
  const ok = await verifyPassword(String(password || ''), row ? row.password_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64'));
  return row && ok ? { id: row.id, email: row.email, name: row.name } : null;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function endSession(req, res) {
  const t = readCookie(req, COOKIE);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha(t));
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function userFromRequest(req) {
  const t = readCookie(req, COOKIE);
  if (!t) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?').get(sha(t));
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha(t)); return null; }
  return db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(s.user_id) || null;
}

function attachUser(req, res, next) { req.user = userFromRequest(req); next(); }
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to do that.' });
  next();
}

// Blocks cross-site form posts: browsers send Origin on POST/DELETE, and it must match this host.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* bad origin */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Blocked cross-site request.' });
  }
  next();
}

module.exports = { validateSignup, createUser, checkLogin, startSession, endSession, attachUser, requireUser, sameOrigin };
