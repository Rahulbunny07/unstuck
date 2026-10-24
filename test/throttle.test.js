const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-throttle-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AGENTICORG_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_key_1234567890';
// Small, fast numbers: a 3,000-token budget per 500 ms window.
process.env.THROTTLE_TOKENS_PER_MIN = '3000';
process.env.THROTTLE_WINDOW_MS = '500';
process.env.THROTTLE_MAX_WAIT_SECONDS = '30';
process.env.THROTTLE_MAX_QUEUE = '40';
process.env.QUOTA_DISABLED = '1';

const throttle = require('../lib/throttle');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('requests under the budget go straight through', async () => {
  throttle.reset();
  const a = await throttle.acquire();
  assert.ok(a.waitedMs < 50);
  throttle.settle(a.ticket, 1000);
  const b = await throttle.acquire();
  assert.ok(b.waitedMs < 50);
});

test('a request over the budget waits until the window frees room, in order', async () => {
  throttle.reset();
  const order = [];
  const t0 = Date.now();
  const mk = async name => {
    const r = await throttle.acquire();
    order.push(name);
    throttle.settle(r.ticket, 1500);
    return { name, waited: Date.now() - t0 };
  };
  // Two fit (3000), the next two must wait for the window to pass.
  const results = await Promise.all([mk('a'), mk('b'), mk('c'), mk('d')]);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']);
  assert.ok(results[2].waited >= 400, `c waited ${results[2].waited}ms`);
  assert.ok(results[0].waited < 100);
});

test('real token use replaces the guess and frees room', async () => {
  throttle.reset();
  const a = await throttle.acquire();
  throttle.settle(a.ticket, 100);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) { const r = await throttle.acquire(); throttle.settle(r.ticket, 100); }
  assert.ok(Date.now() - t0 < 200, 'small answers should not wait');
});

test('a failed call gives its room back', async () => {
  throttle.reset();
  const a = await throttle.acquire();
  throttle.release(a.ticket);
  const t0 = Date.now();
  const b = await throttle.acquire();
  const c = await throttle.acquire();
  assert.ok(Date.now() - t0 < 100);
  throttle.settle(b.ticket, 100); throttle.settle(c.ticket, 100);
});

test('a request that cannot be served in time is turned away early with a retry time', async () => {
  throttle.reset();
  process.env.THROTTLE_MAX_WAIT_SECONDS = '0.05';
  const first = await throttle.acquire();
  throttle.settle(first.ticket, 3000);
  const t0 = Date.now();
  await assert.rejects(() => throttle.acquire(), e => e.code === 'BUSY' && e.retryAfter >= 1);
  assert.ok(Date.now() - t0 < 100, 'should fail fast, not wait out the cap');
  process.env.THROTTLE_MAX_WAIT_SECONDS = '30';
});

test('nobody is turned away while earlier answers are still running and may free room', async () => {
  throttle.reset();
  process.env.THROTTLE_WINDOW_MS = '60000'; // a long window: waiting for it to pass would take a minute
  process.env.THROTTLE_MAX_WAIT_SECONDS = '2';
  const a = await throttle.acquire();
  const b = await throttle.acquire();
  const c = throttle.acquire(); // does not fit at the guessed 2 x 1,300 + 1,300 > 3,000
  await sleep(100);
  assert.strictEqual(throttle.snapshot().waiting, 1, 'c should be waiting, not rejected');
  throttle.settle(a.ticket, 400); // a finishes and used far less than the guess
  const got = await c;
  assert.ok(got.waitedMs < 1000, `c waited ${got.waitedMs}ms`);
  throttle.settle(b.ticket, 400); throttle.settle(got.ticket, 400);
  process.env.THROTTLE_WINDOW_MS = '500';
  process.env.THROTTLE_MAX_WAIT_SECONDS = '30';
});

test('if nothing running can free room in time, the waiting person is turned away at the cap', async () => {
  throttle.reset();
  process.env.THROTTLE_WINDOW_MS = '60000';
  process.env.THROTTLE_MAX_WAIT_SECONDS = '0.4';
  const a = await throttle.acquire();
  const b = await throttle.acquire();
  const t0 = Date.now();
  await assert.rejects(() => throttle.acquire(), e => e.code === 'BUSY');
  const took = Date.now() - t0;
  assert.ok(took >= 300 && took < 1500, `rejected after ${took}ms`);
  throttle.settle(a.ticket, 1500); throttle.settle(b.ticket, 1500);
  process.env.THROTTLE_WINDOW_MS = '500';
  process.env.THROTTLE_MAX_WAIT_SECONDS = '30';
});

test('someone who leaves the line is removed and the next person moves up', async () => {
  throttle.reset();
  const first = await throttle.acquire();
  throttle.settle(first.ticket, 3000);
  const leaver = throttle.acquire();
  const stayer = throttle.acquire();
  assert.strictEqual(throttle.snapshot().waiting, 2);
  leaver.cancel();
  assert.strictEqual(throttle.snapshot().waiting, 1);
  const r = await stayer;
  assert.ok(r.waitedMs >= 300);
});

test('the line has a length limit', async () => {
  throttle.reset();
  process.env.THROTTLE_MAX_QUEUE = '2';
  const first = await throttle.acquire();
  throttle.settle(first.ticket, 3000);
  const w1 = throttle.acquire();
  const w2 = throttle.acquire();
  await assert.rejects(() => throttle.acquire(), e => e.code === 'BUSY');
  w1.cancel(); w2.cancel();
  process.env.THROTTLE_MAX_QUEUE = '40';
});

test('a burst of requests through the real server all succeed, some after waiting', async () => {
  throttle.reset();
  const ANSWER = {
    title: 'Fix', cause: 'A cause.', evidence: [], fix_prompt: 'Do the one small thing. Change nothing else.',
    verify_steps: 'Reload.', rollback: 'Restore the previous version.', confidence: 'high', need_more: null,
  };
  const gw = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 900, completion_tokens: 600 } }));
    });
  });
  await new Promise(r => { gw.listen(0, '127.0.0.1', r); });
  process.env.GROQ_CHAT_URL = `http://127.0.0.1:${gw.address().port}/openai/v1/chat/completions`;
  const app = require('../server');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const go = i => fetch(base + '/api/fix', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'lovable', platform: 'other', error: `unseen burst error number ${i} in wibble handler zeta`, userId: `user_burst_${String(i).padStart(5, '0')}`, sessionId: `sess_burst_${String(i).padStart(5, '0')}` }),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => go(i)));
    assert.ok(out.every(r => r.status === 200), JSON.stringify(out.map(r => r.status)));
    const waited = out.filter(r => r.body.waitedMs >= 200);
    assert.ok(waited.length >= 1, 'with a 3,000-token budget, 6 answers of 1,500 tokens must queue: ' + JSON.stringify(out.map(r => r.body.waitedMs)));
    assert.ok(out.some(r => r.body.waitedMs < 100), 'the first ones should not wait');
    const q = await fetch(base + '/api/queue').then(r => r.json());
    assert.strictEqual(q.enabled, true);
    assert.strictEqual(q.waiting, 0);
  } finally { server.close(); gw.close(); }
});
