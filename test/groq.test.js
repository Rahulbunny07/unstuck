const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-groq-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AGENTICORG_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_key_1234567890';

const ANSWER = {
  title: 'Use the browser env object', cause: 'process is Node-only and does not exist in the browser build.',
  evidence: ['process is not defined'], fix_prompt: 'Replace process.env in src/config.ts with import.meta.env. Change nothing else.',
  verify_steps: 'Publish again and open the site.', rollback: 'Restore the previous version.', confidence: 'high', need_more: null,
};

let gw, app, server, base;
const seen = [];
test.before(async () => {
  gw = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, model: body.model, format: 'response_format' in body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(ANSWER) + '\n```' } }] }));
    });
  });
  await new Promise(r => { gw.listen(0, '127.0.0.1', r); });
  process.env.GROQ_CHAT_URL = `http://127.0.0.1:${gw.address().port}/openai/v1/chat/completions`;
  app = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); gw.close(); });

const post = (body) => fetch(base + '/api/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const vote = (b) => fetch(base + '/api/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

test('a Groq key on the server answers new errors, fast model first then strong model on retry', async () => {
  const health = await fetch(base + '/api/health').then(r => r.json());
  assert.strictEqual(health.aiProvider, 'groq');

  const ids = { userId: 'user_groq_000001', sessionId: 'sess_groq_000001' };
  const error = 'Uncaught ReferenceError: process is not defined at src/config.ts:3 weird flux';
  const one = await post({ tool: 'lovable', platform: 'other', error, ...ids });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.source, 'ai');
  assert.strictEqual(one.body.model, 'openai/gpt-oss-20b');
  assert.strictEqual(one.body.fix.title, 'Use the browser env object');
  let call = seen.pop();
  assert.strictEqual(call.auth, 'Bearer gsk_test_key_1234567890');
  assert.strictEqual(call.format, false);

  await vote({ attemptId: one.body.attemptId, userId: ids.userId, vote: 'failed' });
  const two = await post({ tool: 'lovable', platform: 'other', error, ...ids });
  assert.strictEqual(two.status, 200);
  assert.strictEqual(two.body.model, 'openai/gpt-oss-120b');
  call = seen.pop();
  assert.strictEqual(call.model, 'openai/gpt-oss-120b');
});
