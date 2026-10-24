const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const KEY_ID = 'rzp_live_testkey1234';
const SECRET = 'rzp_secret_for_tests_only';
const HOOK = 'whsec_for_tests_only';

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-rzp-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENTICORG_API_KEY; delete process.env.GROQ_API_KEY;
delete process.env.PINE_CLIENT_ID; delete process.env.PINE_CLIENT_SECRET;
process.env.RAZORPAY_KEY_ID = KEY_ID;
process.env.RAZORPAY_KEY_SECRET = SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = HOOK;
process.env.DB_PERSISTENT = '1';

// A pretend Razorpay: orders and payments, with Basic auth like the real one.
const orders = new Map(); // id -> { amount, receipt, notes }
const payments = new Map(); // id -> { id, order_id, status, amount, currency }
const seen = { creates: [] };
let rzpSrv, server, base;
const pay = (id, orderId, patch = {}) => { const o = orders.get(orderId); const p = { id, order_id: orderId, status: 'captured', amount: o.amount, currency: 'INR', ...patch }; payments.set(id, p); return p; };
const sign = (orderId, paymentId, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

test.before(async () => {
  rzpSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const want = 'Basic ' + Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64');
      if (req.headers.authorization !== want) return json(401, { error: { description: 'Authentication failed' } });
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const b = JSON.parse(raw);
        seen.creates.push(b);
        const id = 'order_' + (orders.size + 1) + 'ABCdef';
        orders.set(id, { amount: b.amount, receipt: b.receipt, notes: b.notes });
        return json(200, { id, amount: b.amount, currency: b.currency, status: 'created', receipt: b.receipt });
      }
      let m = req.url.match(/^\/v1\/payments\/([^/]+)$/);
      if (m) return payments.has(m[1]) ? json(200, payments.get(m[1])) : json(404, { error: { description: 'not found' } });
      m = req.url.match(/^\/v1\/orders\/([^/]+)\/payments$/);
      if (m) return json(200, { items: [...payments.values()].filter(p => p.order_id === m[1]) });
      json(404, {});
    });
  });
  await new Promise(r => { rzpSrv.listen(0, '127.0.0.1', r); });
  process.env.RAZORPAY_BASE_URL = `http://127.0.0.1:${rzpSrv.address().port}/v1`;
  const app = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); rzpSrv.close(); });

const call = async (p, method, body, cookie, extra = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(extra.headers || {}) }, body: extra.raw !== undefined ? extra.raw : (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};
const signup = async email => {
  const r = await call('/api/auth/signup', 'POST', { email, password: 'razorpay-password-1' });
  const me = await call('/api/me', 'GET', null, r.cookie);
  return { cookie: r.cookie, id: me.body.user.id };
};
// The sign-up limit is 8 a minute, so later tests sign in to an account made earlier.
const login = async email => {
  const r = await call('/api/auth/login', 'POST', { email, password: 'razorpay-password-1' });
  return { cookie: r.cookie };
};
const balance = async u =>(await call('/api/billing/me', 'GET', null, u.cookie)).body.balance;
const buy = async (u, packId = 'starter') => (await call('/api/billing/checkout', 'POST', { packId }, u.cookie)).body;
const verify = (u, o, paymentId, signature) => call('/api/billing/razorpay/verify', 'POST', { razorpay_order_id: o.order_id, razorpay_payment_id: paymentId, razorpay_signature: signature }, u.cookie);

test('checkout needs sign-in, takes the price from the server, and never exposes the secret', async () => {
  assert.strictEqual((await call('/api/billing/checkout', 'POST', { packId: 'starter' })).status, 401);
  const u = await signup('rz1@example.com');
  assert.strictEqual((await call('/api/billing/checkout', 'POST', { packId: 'nope' }, u.cookie)).status, 400);
  const r = await call('/api/billing/checkout', 'POST', { packId: 'starter', amount: 1, paise: 1 }, u.cookie);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.provider, 'razorpay');
  assert.strictEqual(r.body.key, KEY_ID);
  assert.strictEqual(r.body.amount, 4900);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  const sent = seen.creates[seen.creates.length - 1];
  assert.strictEqual(sent.amount, 4900);
  assert.strictEqual(sent.currency, 'INR');
  assert.ok(sent.receipt.length <= 40);
});

test('a correctly signed, captured payment for the right amount adds credits exactly once', async () => {
  const u = await signup('rz2@example.com');
  const o = await buy(u, 'plus');
  pay('pay_good1', o.order_id);
  const r = await verify(u, o, 'pay_good1', sign(o.order_id, 'pay_good1'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.outcome, 'success');
  assert.strictEqual(await balance(u), 100);
  await verify(u, o, 'pay_good1', sign(o.order_id, 'pay_good1'));
  await call('/api/billing/reconcile', 'POST', {}, u.cookie);
  assert.strictEqual(await balance(u), 100, 'replays must not credit twice');
});

test('a forged signature, or one made with the wrong secret, adds nothing', async () => {
  const u = await signup('rz3@example.com');
  const o = await buy(u);
  pay('pay_forge1', o.order_id);
  assert.strictEqual((await verify(u, o, 'pay_forge1', 'deadbeef')).status, 400);
  assert.strictEqual((await verify(u, o, 'pay_forge1', sign(o.order_id, 'pay_forge1', 'attacker-secret'))).status, 400);
  assert.strictEqual((await verify(u, o, 'pay_forge1', undefined)).status, 400);
  assert.strictEqual(await balance(u), 0);
});

test('a payment belonging to a different order, or for the wrong amount, adds nothing', async () => {
  const u = await signup('rz4@example.com');
  const a = await buy(u, 'starter');
  const b = await buy(u, 'pro');
  pay('pay_cheap1', a.order_id); // a captured Rs 49 payment
  // Claim the cheap payment against the expensive order: signature is valid for the pair we send,
  // but the payment's own order id does not match.
  const swapped = await verify(u, b, 'pay_cheap1', sign(b.order_id, 'pay_cheap1'));
  assert.strictEqual(swapped.body.outcome, 'failed');
  pay('pay_short1', b.order_id, { amount: 100 }); // Razorpay says only Rs 1 was taken
  const short = await verify(u, b, 'pay_short1', sign(b.order_id, 'pay_short1'));
  assert.strictEqual(short.body.outcome, 'failed');
  assert.strictEqual(await balance(u), 0);
});

test('an authorized but not captured payment is pending, and credits arrive once it is captured', async () => {
  const u = await signup('rz5@example.com');
  const o = await buy(u);
  const p = pay('pay_auth1', o.order_id, { status: 'authorized' });
  const first = await verify(u, o, 'pay_auth1', sign(o.order_id, 'pay_auth1'));
  assert.strictEqual(first.body.outcome, 'pending');
  assert.strictEqual(await balance(u), 0);
  p.status = 'captured';
  const rec = await call('/api/billing/reconcile', 'POST', {}, u.cookie);
  assert.strictEqual(rec.body.credited, 1);
  assert.strictEqual(await balance(u), 20);
});

test('nobody can claim another person\'s order, even with a valid signature', async () => {
  const owner = await signup('rz6@example.com');
  const thief = await signup('rz7@example.com');
  const o = await buy(owner);
  pay('pay_owner1', o.order_id);
  const r = await verify(thief, o, 'pay_owner1', sign(o.order_id, 'pay_owner1'));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(await balance(thief), 0);
  assert.strictEqual(await balance(owner), 0);
});

test('the webhook credits a closed-tab payment, but only when signed and only if Razorpay confirms it', async () => {
  const u = await signup('rz8@example.com');
  const o = await buy(u);
  pay('pay_hook1', o.order_id);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_hook1', order_id: o.order_id } } } });
  const hookSig = secret => crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.strictEqual((await call('/api/billing/razorpay/webhook', 'POST', null, null, { raw: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hookSig('wrong') } })).status, 400);
  assert.strictEqual((await call('/api/billing/razorpay/webhook', 'POST', null, null, { raw: body, headers: { 'content-type': 'application/json' } })).status, 400);
  assert.strictEqual(await balance(u), 0);
  assert.strictEqual((await call('/api/billing/razorpay/webhook', 'POST', null, null, { raw: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hookSig(HOOK) } })).status, 200);
  assert.strictEqual(await balance(u), 20);

  // A signed notice that claims a payment which Razorpay has not captured credits nothing.
  const o2 = await buy(u);
  const lie = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: o2.order_id } } } });
  await call('/api/billing/razorpay/webhook', 'POST', null, null, { raw: lie, headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', HOOK).update(lie).digest('hex') } });
  assert.strictEqual(await balance(u), 20);
});

test('live keys are locked until the owner confirms permanent storage; test keys are not', async () => {
  const u = await login('rz1@example.com');
  delete process.env.DB_PERSISTENT;
  const locked = await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie);
  const me = await call('/api/billing/me', 'GET', null, u.cookie);
  assert.strictEqual(locked.status, 503);
  assert.match(locked.body.error, /permanent storage/);
  assert.strictEqual(me.body.configured, false);
  assert.strictEqual(me.body.reason, 'storage');
  // A test key is not real money, so it works without the lock.
  const liveId = process.env.RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
  const meTest = await call('/api/billing/me', 'GET', null, u.cookie);
  process.env.RAZORPAY_KEY_ID = liveId;
  assert.strictEqual(meTest.body.configured, true);
  assert.strictEqual(meTest.body.testMode, true);
  process.env.DB_PERSISTENT = '1';
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.configured, true);
});

test('wrong Razorpay credentials fail safely and nothing is charged', async () => {
  const u = await login('rz2@example.com');
  const saved = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = 'wrong-secret';
  const bad = await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie);
  process.env.RAZORPAY_KEY_SECRET = saved;
  assert.strictEqual(bad.status, 502);
  assert.match(bad.body.error, /misconfigured|Nothing was charged/);
});
