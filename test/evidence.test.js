const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-evid-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AGENTICORG_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_key_1234567890';

const { verifyEvidence } = require('../lib/clean');

test('verifyEvidence keeps real quotes, ignores case, spacing and ellipses, and drops invented ones', () => {
  const log = "Uncaught ReferenceError: process is not defined\n    at Object.<anonymous> (src/config.ts:3:21)";
  const r = verifyEvidence([
    'Uncaught ReferenceError: process is not defined',
    'REFERENCEERROR:   process is not defined...',
    'TypeError: x is not a function',
    'ab',
  ], log);
  assert.deepStrictEqual(r.kept, ['Uncaught ReferenceError: process is not defined', 'REFERENCEERROR:   process is not defined...']);
  assert.strictEqual(r.total, 4);
});

let gw, server, base, replyEvidence;
const ANSWER = {
  title: 'Use import.meta.env', cause: 'process is Node-only.', fix_prompt: 'Replace process.env with import.meta.env in src/config.ts. Change nothing else.',
  verify_steps: 'Reload the site.', rollback: 'Restore the previous version.', confidence: 'high', need_more: null,
};

test.before(async () => {
  gw = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...ANSWER, evidence: replyEvidence }) } }], usage: { prompt_tokens: 900, completion_tokens: 150 } }));
    });
  });
  await new Promise(r => { gw.listen(0, '127.0.0.1', r); });
  process.env.GROQ_CHAT_URL = `http://127.0.0.1:${gw.address().port}/openai/v1/chat/completions`;
  const app = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); gw.close(); });

const post = (body) => fetch(base + '/api/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('invented quotes are removed, confidence is lowered, and real token use is recorded', async () => {
  replyEvidence = ['ReferenceError: window is undefined', 'a line that is not in the log'];
  const r = await post({ tool: 'lovable', platform: 'other', userId: 'user_evid_000001', sessionId: 'sess_evid_000001', error: 'Uncaught ReferenceError: process is not defined at src/config.ts:3 odd zeta flux' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.fix.evidence, []);
  assert.strictEqual(r.body.fix.confidence, 'medium');
  assert.match(r.body.fix.evidence_note, /None of the AI/);
  assert.deepStrictEqual(r.body.tokens, { in: 900, out: 150 });
  const stats = await fetch(base + '/api/stats').then(x => x.json());
  assert.strictEqual(stats.aiTokensUsed, 1050);
  assert.strictEqual(stats.savedBasis, 'rough estimate');
});

test('real quotes stay and the note says so', async () => {
  replyEvidence = ['Uncaught ReferenceError: process is not defined'];
  const r = await post({ tool: 'lovable', platform: 'other', userId: 'user_evid_000002', sessionId: 'sess_evid_000002', error: 'Uncaught ReferenceError: process is not defined at src/config.ts:3 odd zeta flux two' });
  assert.deepStrictEqual(r.body.fix.evidence, ['Uncaught ReferenceError: process is not defined']);
  assert.strictEqual(r.body.fix.confidence, 'high');
  assert.match(r.body.fix.evidence_note, /appears in what you pasted/);
});

test('savings use the measured average once enough AI calls are measured', async () => {
  replyEvidence = ['Uncaught ReferenceError: process is not defined'];
  await post({ tool: 'lovable', platform: 'other', userId: 'user_evid_000003', sessionId: 'sess_evid_000003', error: 'Uncaught ReferenceError: process is not defined at src/config.ts:3 odd zeta flux three' });
  const lib = await post({ tool: 'bolt', platform: 'other', userId: 'user_evid_000004', sessionId: 'sess_evid_000004', error: 'Error: listen EADDRINUSE: address already in use :::3000' });
  assert.strictEqual(lib.body.source, 'library');
  const stats = await fetch(base + '/api/stats').then(x => x.json());
  assert.strictEqual(stats.savedBasis, 'measured average per AI call');
  assert.strictEqual(stats.avgTokensPerAiCall, 1050);
  assert.strictEqual(stats.estTokensSaved, 1050);
});
