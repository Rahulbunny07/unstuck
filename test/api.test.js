const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-test-${Date.now()}.db`);
delete process.env.ANTHROPIC_API_KEY;

const { redact, trimLog, similarity } = require('../lib/clean');
const app = require('../server');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('redact removes keys, jwts and emails', () => {
  const { text, redactions } = redact('key=sk-abcdefghijklmnopqrstuvwx token: eyJabcdefgh.eyJabcdefgh.abcdefghijk mail me@x.com');
  assert.ok(!text.includes('sk-abcdef'));
  assert.ok(!text.includes('eyJabcdefgh'));
  assert.ok(!text.includes('me@x.com'));
  assert.ok(redactions >= 3);
});

test('trimLog keeps error lines in long logs', () => {
  const noise = Array.from({ length: 400 }, (_, i) => `info line number ${i} everything fine`).join('\n');
  const log = noise + '\nTypeError: Cannot read properties of undefined\n' + noise;
  const t = trimLog(log, 1500);
  assert.ok(t.trimmed);
  assert.ok(t.text.includes('TypeError'));
  assert.ok(t.text.length <= 1600);
});

test('similarity is high for same error with different names', () => {
  const a = 'new row violates row-level security policy for table "orders"';
  const b = 'new row violates row-level security policy for table "todos"';
  assert.ok(similarity(a, b) > 0.7);
  assert.ok(similarity(a, 'ECONNREFUSED 127.0.0.1:5432') < 0.2);
});

test('known error is served from the library with no AI', async () => {
  const r = await post('/api/fix', {
    tool: 'lovable', platform: 'supabase', userId: 'user_test_000001', sessionId: 'sess_test_000001',
    error: 'Error: new row violates row-level security policy for table "invoices"\ncode: 42501',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.source, 'library');
  assert.ok(r.body.fix.fix_prompt.length > 20);
  assert.strictEqual(r.body.fix.badge.kind, 'curated');
});

test('unknown error without an AI key returns a clear message', async () => {
  const r = await post('/api/fix', {
    tool: 'bolt', platform: 'other', userId: 'user_test_000002', sessionId: 'sess_test_000002',
    error: 'Totally unusual quantum flux capacitor misalignment detected in module zeta',
  });
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /no AI key is set up/);
});

test('too short input is rejected', async () => {
  const r = await post('/api/fix', { userId: 'user_test_000003', sessionId: 'sess_test_000003', error: 'oops' });
  assert.strictEqual(r.status, 400);
});

test('vote updates the fix and the stats, retry avoids the failed fix', async () => {
  const body = { tool: 'lovable', platform: 'supabase', userId: 'user_test_000004', sessionId: 'sess_test_000004', error: 'CORS policy: No Access-Control-Allow-Origin header is present on the requested resource' };
  const first = await post('/api/fix', body);
  assert.strictEqual(first.status, 200);
  const v = await post('/api/vote', { attemptId: first.body.attemptId, userId: body.userId, vote: 'failed' });
  assert.strictEqual(v.status, 200);
  const dup = await post('/api/vote', { attemptId: first.body.attemptId, userId: body.userId, vote: 'worked' });
  assert.strictEqual(dup.status, 409);
  const second = await post('/api/fix', body);
  if (second.status === 200) assert.notStrictEqual(second.body.fix.id, first.body.fix.id);
  const stats = await fetch(base + '/api/stats').then(r => r.json());
  assert.ok(stats.votesFailed >= 1);
});

test('someone else cannot vote on another user attempt', async () => {
  const first = await post('/api/fix', { tool: 'lovable', platform: 'vercel', userId: 'user_test_000005', sessionId: 'sess_test_000005', error: 'TypeError: Cannot read properties of undefined (reading \'map\')' });
  assert.strictEqual(first.status, 200);
  const v = await post('/api/vote', { attemptId: first.body.attemptId, userId: 'user_test_999999', vote: 'worked' });
  assert.strictEqual(v.status, 404);
});

test('sample runs are excluded from stats', async () => {
  const before = await fetch(base + '/api/stats').then(r => r.json());
  await post('/api/fix', { tool: 'lovable', platform: 'other', userId: 'sample_abcdefgh', sessionId: 'sess_sample_01', error: 'Error: Port 3000 EADDRINUSE address already in use' });
  const after = await fetch(base + '/api/stats').then(r => r.json());
  assert.strictEqual(after.totalAnswers, before.totalAnswers);
});
