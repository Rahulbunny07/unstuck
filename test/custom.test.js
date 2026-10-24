const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-custom-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.ALLOW_LOCAL_MCP = '1';
delete process.env.ANTHROPIC_API_KEY;

const app = require('../server');

const ANSWER = {
  title: 'Define the environment variable', cause: 'The process variable does not exist in the browser build.',
  evidence: ['ReferenceError: process is not defined'],
  fix_prompt: 'Replace process.env usage in src/config.ts with import.meta.env and prefix the variable with VITE_. Change nothing else.',
  verify_steps: 'Publish again and open the site. The page should render.', rollback: 'Restore the previous version in history.',
  confidence: 'high', need_more: null,
};

let server, base, gw, gwUrl;
const seen = [];
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  gw = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, model: body.model, hasFormat: 'response_format' in body });
      if (req.headers.authorization !== 'Bearer org-key-12345678') { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      const content = body.max_tokens === 5 ? 'ok' : JSON.stringify(ANSWER);
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(r => { gw.listen(0, '127.0.0.1', r); });
  gwUrl = `http://127.0.0.1:${gw.address().port}/v1`;
});
test.after(() => { server.close(); gw.close(); });

const call = async (p, method, body, cookie) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

test('a custom OpenAI-compatible key is verified, stored, and used for a real analysis', async () => {
  const u = await call('/api/auth/signup', 'POST', { email: 'org@example.com', password: 'org-password-123' });

  const bad = await call('/api/keys', 'POST', { provider: 'custom', baseUrl: gwUrl, model: 'agent-1', key: 'wrong-key-12345678' }, u.cookie);
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /rejected/);
  const noModel = await call('/api/keys', 'POST', { provider: 'custom', baseUrl: gwUrl, key: 'org-key-12345678' }, u.cookie);
  assert.strictEqual(noModel.status, 400);

  const ok = await call('/api/keys', 'POST', { provider: 'custom', baseUrl: gwUrl, model: 'agent-1', key: 'org-key-12345678', label: 'Org' }, u.cookie);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.key.last4, '5678');
  assert.ok(!JSON.stringify(ok.body).includes('org-key'));

  const fix = await fetch(base + '/api/fix', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: u.cookie },
    body: JSON.stringify({ tool: 'lovable', platform: 'other', userId: 'user_cust_000001', sessionId: 'sess_cust_000001', error: 'Uncaught ReferenceError: process is not defined at src/config.ts:3' }),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(fix.body.source, 'ai');
  assert.strictEqual(fix.body.usedOwnKey, true);
  assert.strictEqual(fix.body.model, 'agent-1');
  assert.strictEqual(fix.body.fix.badge.kind, 'unverified');
  const real = seen.filter(s => s.url === '/v1/chat/completions').pop();
  assert.strictEqual(real.model, 'agent-1');
  assert.strictEqual(real.hasFormat, false);
});

test('custom endpoints cannot point at internal addresses', async () => {
  delete process.env.ALLOW_LOCAL_MCP;
  const u = await call('/api/auth/signup', 'POST', { email: 'org2@example.com', password: 'org-password-456' });
  const r = await call('/api/keys', 'POST', { provider: 'custom', baseUrl: 'https://169.254.169.254/v1', model: 'm', key: 'org-key-12345678' }, u.cookie);
  process.env.ALLOW_LOCAL_MCP = '1';
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not allowed/);
});
