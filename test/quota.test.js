const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-quota-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
process.env.ALLOW_LOCAL_MCP = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AGENTICORG_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_key_1234567890';
process.env.DAILY_AI_LIMIT_ANON = '2';
process.env.DAILY_AI_LIMIT_USER = '3';
process.env.GLOBAL_DAILY_AI_CALLS = '6';
process.env.GLOBAL_DAILY_AI_TOKENS = '100000';

const ANSWER = {
  title: 'Use import.meta.env', cause: 'process is Node-only.', evidence: [], fix_prompt: 'Replace process.env with import.meta.env in src/config.ts. Change nothing else.',
  verify_steps: 'Reload.', rollback: 'Restore the previous version.', confidence: 'high', need_more: null,
};

let gw, app, server, base, mode = 'ok', calls = 0;
test.before(async () => {
  gw = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      calls++;
      if (req.headers.authorization === 'Bearer own-key-12345678') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }
      if (mode === 'fail') { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 400, completion_tokens: 100 } }));
    });
  });
  await new Promise(r => { gw.listen(0, '127.0.0.1', r); });
  process.env.GROQ_CHAT_URL = `http://127.0.0.1:${gw.address().port}/openai/v1/chat/completions`;
  app = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); gw.close(); });

let n = 0;
const fresh = () => `unseen zeta flux error number ${++n} in module wibble handler`;
const post = (userId, body = {}, cookie) => fetch(base + '/api/fix', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ tool: 'lovable', platform: 'other', error: fresh(), userId, sessionId: 'sess_' + userId + '_' + n, ...body }),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('an anonymous person gets their daily AI answers, then a clear message, and library answers still work', async () => {
  const a = await post('user_quota_a0001');
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.body.quota, { remaining: 1, limit: 2, signedIn: false, usedCredit: false, credits: 0 });
  assert.strictEqual((await post('user_quota_a0001')).body.quota.remaining, 0);
  const blocked = await post('user_quota_a0001');
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.body.quotaBlocked, 'user');
  assert.match(blocked.body.error, /2 free AI answers/);
  const lib = await post('user_quota_a0001', { error: 'Error: listen EADDRINUSE: address already in use :::3000' });
  assert.strictEqual(lib.status, 200);
  assert.strictEqual(lib.body.source, 'library');
  const q = await fetch(base + '/api/quota?userId=user_quota_a0001').then(r => r.json());
  assert.deepStrictEqual([q.limit, q.remaining], [2, 0]);
});

test('a failed AI call is refunded and does not use up an answer', async () => {
  mode = 'fail';
  const f = await post('user_quota_b0001');
  assert.strictEqual(f.status, 503);
  mode = 'ok';
  const q = await fetch(base + '/api/quota?userId=user_quota_b0001').then(r => r.json());
  assert.strictEqual(q.remaining, 2);
});

test('the whole site stops at its daily cap, even for new people', async () => {
  // Used so far: 2 (person A) + 0 (refunded). Spend the rest of the 6 allowed calls.
  for (const id of ['user_quota_c0001', 'user_quota_c0002', 'user_quota_c0003']) {
    for (let i = 0; i < 2 && true; i++) {
      const r = await post(id);
      if (r.status === 429) break;
    }
  }
  const snap = await fetch(base + '/api/stats').then(r => r.json());
  assert.strictEqual(snap.aiToday.callsToday, 6);
  const late = await post('user_quota_d0001');
  assert.strictEqual(late.status, 429);
  assert.strictEqual(late.body.quotaBlocked, 'global');
});

test('someone using their own key is not limited, and a new day resets the counts', async () => {
  const { setClock } = require('../lib/quota');
  const accounts = require('../lib/accounts');
  const su = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'quota@example.com', password: 'quota-password-1' }) });
  const cookie = (su.headers.get('set-cookie') || '').split(';')[0];
  const me = await fetch(base + '/api/me', { headers: { cookie } }).then(r => r.json());
  accounts.addKey(me.user.id, { provider: 'custom', label: 'mine', key: 'own-key-12345678', baseUrl: `http://127.0.0.1:${gw.address().port}/v1`, model: 'm' });
  const own = await post('user_quota_e0001', {}, cookie);
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.body.usedOwnKey, true);
  assert.strictEqual(own.body.quota, null);

  setClock(() => new Date(Date.now() + 24 * 3600 * 1000));
  const next = await post('user_quota_d0001');
  setClock(null);
  assert.strictEqual(next.status, 200);
  assert.strictEqual(next.body.quota.remaining, 1);
});
