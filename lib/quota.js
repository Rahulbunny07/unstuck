const { db } = require('./db');

// Daily limits on AI answers paid for by the site's own key. Answers from the library cost
// nothing and are never counted, and people using their own key are not limited here.
// Limits are read at call time so they can be changed through the environment.
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, scope, key)
  );
`);

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

// Defaults fit a free Groq key: about 200,000 tokens a day per model and roughly 1,200 tokens
// per answer, so about 150 AI answers a day. Raise them if you use a paid key.
const limits = () => ({
  anon: num('DAILY_AI_LIMIT_ANON', 4),
  user: num('DAILY_AI_LIMIT_USER', 10),
  ip: num('DAILY_AI_LIMIT_IP', 150),
  globalCalls: num('GLOBAL_DAILY_AI_CALLS', 150),
  globalTokens: num('GLOBAL_DAILY_AI_TOKENS', 180000),
});

let clock = () => new Date();
const setClock = fn => { clock = fn || (() => new Date()); };
const today = () => clock().toISOString().slice(0, 10);

const isLoopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const disabled = () => process.env.QUOTA_DISABLED === '1';

const get = (day, scope, key) => db.prepare('SELECT calls, tokens FROM usage_daily WHERE day = ? AND scope = ? AND key = ?').get(day, scope, key) || { calls: 0, tokens: 0 };
const bump = (day, scope, key, calls, tokens) => db.prepare(`
  INSERT INTO usage_daily (day, scope, key, calls, tokens) VALUES (?,?,?,?,?)
  ON CONFLICT(day, scope, key) DO UPDATE SET calls = MAX(0, calls + excluded.calls), tokens = MAX(0, tokens + excluded.tokens)`)
  .run(day, scope, key, calls, tokens);

// Reserves one AI answer before the call is made, so a burst of parallel requests cannot
// slip past the limit. Returns { ok, ... } and, when ok, a ticket to settle or refund.
function reserve({ userKey, signedIn, ip }) {
  if (disabled()) return { ok: true, ticket: null, remaining: null, limit: null };
  const L = limits();
  const day = today();
  const userLimit = signedIn ? L.user : L.anon;
  const g = get(day, 'global', 'all');
  if (g.calls >= L.globalCalls || g.tokens >= L.globalTokens) return { ok: false, reason: 'global' };
  const u = get(day, 'user', userKey);
  if (u.calls >= userLimit) return { ok: false, reason: 'user', limit: userLimit };
  const useIp = ip && !isLoopback(ip);
  if (useIp && get(day, 'ip', ip).calls >= L.ip) return { ok: false, reason: 'ip' };
  bump(day, 'global', 'all', 1, 0);
  bump(day, 'user', userKey, 1, 0);
  if (useIp) bump(day, 'ip', ip, 1, 0);
  return { ok: true, ticket: { day, userKey, ip: useIp ? ip : null }, remaining: userLimit - (u.calls + 1), limit: userLimit };
}

// The provider answered: record the tokens it really used.
function settle(ticket, tokens) {
  if (!ticket || !tokens) return;
  bump(ticket.day, 'global', 'all', 0, tokens);
  bump(ticket.day, 'user', ticket.userKey, 0, tokens);
}

// The provider failed and the person got nothing, so they do not lose an answer.
function refund(ticket) {
  if (!ticket) return;
  bump(ticket.day, 'global', 'all', -1, 0);
  bump(ticket.day, 'user', ticket.userKey, -1, 0);
  if (ticket.ip) bump(ticket.day, 'ip', ticket.ip, -1, 0);
}

function remainingFor({ userKey, signedIn }) {
  const L = limits();
  const limit = signedIn ? L.user : L.anon;
  return { limit, remaining: Math.max(0, limit - get(today(), 'user', userKey).calls) };
}

function snapshot() {
  const L = limits();
  const g = get(today(), 'global', 'all');
  return { day: today(), callsToday: g.calls, tokensToday: g.tokens, callCap: L.globalCalls, tokenCap: L.globalTokens, perPerson: { anonymous: L.anon, signedIn: L.user } };
}

const MESSAGES = {
  user: limit => `You have used your ${limit} free AI answers for today. Answers for known errors still work. Come back tomorrow, or sign in and add your own API key in Account to keep going.`,
  ip: () => 'This network has used its free AI answers for today. Known-error answers still work. Sign in and add your own API key in Account, or try again tomorrow.',
  global: () => 'The site has reached its free AI limit for today. Known-error answers still work. You can sign in and add your own API key in Account, or come back tomorrow.',
};

module.exports = { reserve, settle, refund, remainingFor, snapshot, setClock, MESSAGES };
