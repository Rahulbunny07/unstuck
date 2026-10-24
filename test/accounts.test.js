const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-acct-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ALLOW_LOCAL_MCP = '1';
delete process.env.ANTHROPIC_API_KEY;

const { encrypt, decrypt } = require('../lib/crypto');
const mcp = require('../lib/mcp');
const accounts = require('../lib/accounts');
const app = require('../server');

let server, base, mock, mockUrl;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // Minimal MCP server: JSON for initialize, SSE for tools/list.
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const m = raw ? JSON.parse(raw) : {};
      if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); return res.end(); }
      if (m.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'Mock', version: '9.9' } } }));
      }
      if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (m.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = [{ name: 'get_logs', description: 'Read logs', annotations: { readOnlyHint: true } }, { name: 'delete_db', description: 'Danger' }];
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools } })}\n\n`);
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise(r => { mock.listen(0, '127.0.0.1', r); });
  mockUrl = `http://127.0.0.1:${mock.address().port}/mcp`;
});
test.after(() => { server.close(); mock.close(); });

const call = async (p, method, body, cookie, headers) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

test('encryption round-trips and is not plaintext', () => {
  const blob = encrypt('sk-ant-secret-value-1234567890');
  assert.ok(!blob.includes('secret'));
  assert.strictEqual(decrypt(blob), 'sk-ant-secret-value-1234567890');
});

test('signup validates, creates a session cookie, and /api/me sees it', async () => {
  assert.strictEqual((await call('/api/auth/signup', 'POST', { email: 'nope', password: 'longenough1' })).status, 400);
  assert.strictEqual((await call('/api/auth/signup', 'POST', { email: 'a@b.com', password: 'short' })).status, 400);
  const r = await call('/api/auth/signup', 'POST', { email: 'Test@Example.com', password: 'correct horse battery', name: 'Tess' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.cookie.startsWith('unstuck_sid='));
  const me = await call('/api/me', 'GET', null, r.cookie);
  assert.strictEqual(me.body.user.email, 'test@example.com');
  assert.strictEqual((await call('/api/me', 'GET')).body.user, null);
  assert.strictEqual((await call('/api/auth/signup', 'POST', { email: 'test@example.com', password: 'another long pw' })).status, 409);
});

test('login rejects wrong password and accepts the right one; logout ends the session', async () => {
  assert.strictEqual((await call('/api/auth/login', 'POST', { email: 'test@example.com', password: 'wrong password' })).status, 401);
  assert.strictEqual((await call('/api/auth/login', 'POST', { email: 'missing@example.com', password: 'whatever long' })).status, 401);
  const ok = await call('/api/auth/login', 'POST', { email: 'test@example.com', password: 'correct horse battery' });
  assert.strictEqual(ok.status, 200);
  await call('/api/auth/logout', 'POST', {}, ok.cookie);
  assert.strictEqual((await call('/api/me', 'GET', null, ok.cookie)).body.user, null);
});

test('account routes need sign-in and block cross-site posts', async () => {
  assert.strictEqual((await call('/api/keys', 'GET')).status, 401);
  assert.strictEqual((await call('/api/mcp', 'GET')).status, 401);
  const r = await call('/api/auth/login', 'POST', { email: 'x@y.com', password: 'password123' }, null, { origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);
});

test('stored keys never leak and are scoped to their owner', async () => {
  const a = await call('/api/auth/signup', 'POST', { email: 'a1@example.com', password: 'password-one-1' });
  const b = await call('/api/auth/signup', 'POST', { email: 'b1@example.com', password: 'password-two-2' });
  const idA = (await call('/api/me', 'GET', null, a.cookie)).body.user.id;
  const k = accounts.addKey(idA, { provider: 'anthropic', label: 'mine', key: 'sk-ant-api03-ABCDEFGHIJKLMNOP1234' });
  assert.strictEqual(k.last4, '1234');
  const list = await call('/api/keys', 'GET', null, a.cookie);
  assert.ok(!JSON.stringify(list.body).includes('ABCDEFGH'));
  assert.strictEqual(list.body.keys.length, 1);
  assert.strictEqual((await call('/api/keys', 'GET', null, b.cookie)).body.keys.length, 0);
  assert.strictEqual((await call(`/api/keys/${k.id}`, 'DELETE', null, b.cookie)).status, 404);
  assert.strictEqual(accounts.defaultKeyFor(idA).key, 'sk-ant-api03-ABCDEFGHIJKLMNOP1234');
});

test('MCP url guard blocks private and unsafe addresses', async () => {
  delete process.env.ALLOW_LOCAL_MCP;
  for (const bad of ['http://example.com/mcp', 'https://127.0.0.1/mcp', 'https://10.0.0.5/mcp', 'https://169.254.169.254/latest', 'https://[::1]/mcp', 'https://user:pw@example.com/mcp', 'file:///etc/passwd', 'not a url']) {
    await assert.rejects(() => mcp.assertSafeUrl(bad), undefined, bad);
  }
  assert.ok(mcp.isPrivateIp('192.168.1.1'));
  assert.ok(!mcp.isPrivateIp('8.8.8.8'));
  process.env.ALLOW_LOCAL_MCP = '1';
});

test('MCP handshake lists tools, reads SSE, and defaults to read-only tools', async () => {
  const r = await mcp.inspect(mockUrl, 'good-token');
  assert.strictEqual(r.server.name, 'Mock');
  assert.strictEqual(r.tools.length, 2);
  assert.strictEqual(r.tools.find(t => t.name === 'get_logs').readOnly, true);
  assert.strictEqual(r.tools.find(t => t.name === 'delete_db').readOnly, false);
  await assert.rejects(() => mcp.inspect(mockUrl, 'bad-token'), /rejected the token/);

  const a = await call('/api/auth/signup', 'POST', { email: 'm1@example.com', password: 'password-mcp-1' });
  const added = await call('/api/mcp', 'POST', { catalogId: 'custom', url: mockUrl, token: 'good-token', name: 'Mock' }, a.cookie);
  assert.strictEqual(added.status, 200);
  assert.deepStrictEqual(added.body.server.enabledTools, ['get_logs']);
  assert.ok(!JSON.stringify(added.body).includes('good-token'));
  const set = await call(`/api/mcp/${added.body.server.id}/tools`, 'POST', { enabled: ['get_logs', 'delete_db', 'made_up'] }, a.cookie);
  assert.deepStrictEqual(set.body.server.enabledTools.sort(), ['delete_db', 'get_logs']);
});
