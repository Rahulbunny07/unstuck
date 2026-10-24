const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-resolve-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.ALLOW_LOCAL_MCP = '1';
delete process.env.ANTHROPIC_API_KEY;

const { detectPlatform } = require('../lib/clean');
const { checkSite } = require('../lib/sitecheck');
const app = require('../server');

let server, base, site, siteUrl;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // A broken single-page app: the script comes back as HTML and deep links 404.
  site = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>');
    }
    if (req.url === '/assets/index-abc.js') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>nope</html>'); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  await new Promise(r => { site.listen(0, '127.0.0.1', r); });
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
});
test.after(() => { server.close(); site.close(); });

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('platform is guessed from the error text', () => {
  assert.strictEqual(detectPlatform('new row violates row-level security policy'), 'supabase');
  assert.strictEqual(detectPlatform('Deployment failed on myapp.vercel.app'), 'vercel');
  assert.strictEqual(detectPlatform('something odd happened'), 'other');
});

test('live site check proves a script is served as HTML and deep links 404', async () => {
  const r = await checkSite(siteUrl);
  assert.ok(r.ok);
  assert.ok(r.findings.some(f => f.id === 'script-html'));
  assert.ok(r.findings.some(f => f.id === 'spa-404'));
  assert.ok(r.markers.includes('unstuck-finding:script-served-as-html'));
});

test('live site check refuses internal addresses', async () => {
  delete process.env.ALLOW_LOCAL_MCP;
  const r = await checkSite('https://169.254.169.254/latest/meta-data');
  process.env.ALLOW_LOCAL_MCP = '1';
  assert.strictEqual(r.ok, false);
});

test('a blank page is resolved from the site check with no AI and a trace', async () => {
  const r = await post('/api/fix', {
    tool: 'lovable', platform: 'vercel', userId: 'user_rslv_000001', sessionId: 'sess_rslv_000001',
    error: 'My published page is completely blank, nothing shows at all', siteUrl,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.source, 'library');
  assert.strictEqual(r.body.fix.title, 'Blank white page after deploy');
  assert.ok(r.body.trace.some(t => /Live site check/.test(t)));
  assert.ok(r.body.site.findings.length >= 1);
});

test('trace explains a miss and refine needs an AI answer to improve', async () => {
  const miss = await post('/api/fix', {
    tool: 'bolt', platform: 'other', userId: 'user_rslv_000002', sessionId: 'sess_rslv_000002',
    error: 'Zeta quantum module desynchronised in wibble handler',
  });
  assert.strictEqual(miss.status, 503);

  const lib = await post('/api/fix', { tool: 'bolt', platform: 'other', userId: 'user_rslv_000003', sessionId: 'sess_rslv_000003', error: 'Error: listen EADDRINUSE: address already in use :::3000' });
  assert.strictEqual(lib.status, 200);
  assert.ok(lib.body.trace.some(t => /No AI needed/.test(t)));
  const ref = await post('/api/fix', { tool: 'bolt', platform: 'other', userId: 'user_rslv_000003', sessionId: 'sess_rslv_000003', error: 'Error: listen EADDRINUSE: address already in use :::3000', refine: true, evidence: 'extra console output here' });
  assert.strictEqual(ref.status, 400);
});
