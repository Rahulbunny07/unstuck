const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-billing-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AGENTICORG_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_key_1234567890';
process.env.PINE_CLIENT_ID = 'test-client-id';
process.env.PINE_CLIENT_SECRET = 'test-client-secret';
process.env.PUBLIC_URL = 'https://unstuck.example';
process.env.DAILY_AI_LIMIT_ANON = '1';
process.env.DAILY_AI_LIMIT_USER = '1';
process.env.THROTTLE_TOKENS_PER_MIN = '0';

const ANSWER = {
  title: 'Fix', cause: 'A cause.', evidence: [], fix_prompt: 'Do the one small thing. Change nothing else.',
  verify_steps: 'Reload.', rollback: 'Restore the previous version.', confidence: 'high', need_more: null,
};

// A tiny pretend Pine Labs: token, create checkout, and get-order-by-reference.
const orders = new Map(); // reference -> { status, value }
const seen = { tokenCalls: 0, created: [] };
let aiMode = 'ok';
let pineSrv, aiSrv, server, base;

test.before(async () => {
  pineSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/auth/v1/token') {
        seen.tokenCalls++;
        if (body.client_id !== 'test-client-id' || body.client_secret !== 'test-client-secret' || body.grant_type !== 'client_credentials') return json(401, { message: 'bad credentials' });
        return json(200, { access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 });
      }
      if (req.headers.authorization !== 'Bearer tok-123') return json(401, { message: 'no token' });
      if (req.url === '/api/checkout/v1/orders') {
        seen.created.push(body);
        const id = 'v1-order-' + orders.size;
        orders.set(body.merchant_order_reference, { status: 'CREATED', value: body.order_amount.value, id });
        return json(200, { order_id: id, redirect_url: 'https://api.pluralonline.com/checkout?token=abc', response_code: 200 });
      }
      const m = req.url.match(/^\/api\/pay\/v1\/orders\/reference\/(.+)$/);
      if (m) {
        const o = orders.get(decodeURIComponent(m[1]));
        if (!o) return json(404, { message: 'not found' });
        return json(200, { data: { order_id: o.id, merchant_order_reference: decodeURIComponent(m[1]), status: o.status, order_amount: { value: o.value, currency: 'INR' } } });
      }
      json(404, {});
    });
  });
  await new Promise(r => { pineSrv.listen(0, '127.0.0.1', r); });
  process.env.PINE_BASE_URL = `http://127.0.0.1:${pineSrv.address().port}/api`;

  aiSrv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (aiMode === 'fail') { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 500, completion_tokens: 100 } }));
    });
  });
  await new Promise(r => { aiSrv.listen(0, '127.0.0.1', r); });
  process.env.GROQ_CHAT_URL = `http://127.0.0.1:${aiSrv.address().port}/openai/v1/chat/completions`;

  const app = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); pineSrv.close(); aiSrv.close(); });

const call = async (p, method, body, cookie, extra = {}) => {
  const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(extra.headers || {}) }, body: body ? JSON.stringify(body) : extra.rawBody });
  return { status: res.status, location: res.headers.get('location'), body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};
const signup = async email => {
  const r = await call('/api/auth/signup', 'POST', { email, password: 'billing-password-1' });
  const me = await call('/api/me', 'GET', null, r.cookie);
  return { cookie: r.cookie, id: me.body.user.id };
};
let n = 0;
const fix = (cookie, userId) => call('/api/fix', 'POST', { tool: 'lovable', platform: 'other', userId, sessionId: 'sess_' + userId + '_' + ++n, error: `unseen billing test error ${n} zeta wibble flux handler` }, cookie);

test('buying needs sign-in, and the price comes from the server, not the browser', async () => {
  assert.strictEqual((await call('/api/billing/checkout', 'POST', { packId: 'starter' })).status, 401);
  const u = await signup('buyer1@example.com');
  assert.strictEqual((await call('/api/billing/checkout', 'POST', { packId: 'free-for-all' }, u.cookie)).status, 400);
  const r = await call('/api/billing/checkout', 'POST', { packId: 'starter', amount: 1, paise: 1, credits: 9999 }, u.cookie);
  assert.strictEqual(r.status, 200);
  assert.match(r.body.url, /^https:\/\/api\.pluralonline\.com\//);
  const sent = seen.created[seen.created.length - 1];
  assert.deepStrictEqual(sent.order_amount, { value: 4900, currency: 'INR' });
  assert.strictEqual(sent.callback_url, 'https://unstuck.example/api/billing/return');
  assert.strictEqual(sent.purchase_details.customer.email_id, 'buyer1@example.com');
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 0);
});

test('a forged return link cannot add credits: only Pine Labs saying PROCESSED does', async () => {
  const u = await signup('buyer2@example.com');
  await call('/api/billing/checkout', 'POST', { packId: 'plus' }, u.cookie);
  const ref = [...orders.keys()].pop();
  const o = orders.get(ref);
  // The attacker's link claims success, but Pine Labs still says CREATED.
  const forged = await call(`/api/billing/return?order_id=${o.id}&status=PROCESSED&payment_status=PROCESSED`, 'GET');
  assert.strictEqual(forged.status, 303);
  assert.match(forged.location, /payment=pending/);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 0);
  // An order id we never issued is ignored.
  assert.match((await call('/api/billing/return?order_id=made-up&status=PROCESSED', 'GET')).location, /payment=unknown/);
});

test('a real payment adds credits once, whether the return comes as GET, POST, or is replayed', async () => {
  const u = await signup('buyer3@example.com');
  await call('/api/billing/checkout', 'POST', { packId: 'plus' }, u.cookie);
  const ref = [...orders.keys()].pop();
  const o = orders.get(ref);
  o.status = 'PROCESSED';
  const first = await call(`/api/billing/return?order_id=${o.id}`, 'GET');
  assert.match(first.location, /payment=success/);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 100);
  // Pine Labs posting a form from its own site (no session cookie, other origin) is accepted too.
  const post = await call('/api/billing/return', 'POST', null, null, { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://api.pluralonline.com' }, rawBody: `order_id=${o.id}&status=PROCESSED` });
  assert.match(post.location, /payment=success/);
  await call(`/api/billing/return?order_id=${o.id}`, 'GET');
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 100, 'replays must not credit twice');
});

test('a payment of the wrong amount is not credited', async () => {
  const u = await signup('buyer4@example.com');
  await call('/api/billing/checkout', 'POST', { packId: 'pro' }, u.cookie);
  const ref = [...orders.keys()].pop();
  const o = orders.get(ref);
  o.status = 'PROCESSED';
  o.value = 100; // Pine Labs says only Rs 1 was paid
  assert.match((await call(`/api/billing/return?order_id=${o.id}`, 'GET')).location, /payment=failed/);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 0);
});

test('someone who closed the tab is credited by the reconcile check, and nobody else is touched', async () => {
  const u = await signup('buyer5@example.com');
  const other = await signup('buyer6@example.com');
  await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie);
  orders.get([...orders.keys()].pop()).status = 'PROCESSED';
  assert.strictEqual((await call('/api/billing/reconcile', 'POST', {}, other.cookie)).body.credited, 0);
  const r = await call('/api/billing/reconcile', 'POST', {}, u.cookie);
  assert.strictEqual(r.body.credited, 1);
  assert.strictEqual(r.body.balance, 20);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, other.cookie)).body.balance, 0);
});

test('credits pay for AI answers after the free allowance, and a failed answer gives the credit back', async () => {
  const u = await signup('buyer7@example.com');
  const uid = 'user_bill_' + u.id + '0000';
  const free = await fix(u.cookie, uid);
  assert.strictEqual(free.status, 200);
  assert.strictEqual(free.body.quota.usedCredit, false);
  // Free allowance (1) is used up and there are no credits: blocked.
  const blocked = await fix(u.cookie, uid);
  assert.strictEqual(blocked.status, 429);
  assert.match(blocked.body.error, /buy credits/);
  // Buy credits.
  await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie);
  orders.get([...orders.keys()].pop()).status = 'PROCESSED';
  await call('/api/billing/reconcile', 'POST', {}, u.cookie);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 20);
  const paid = await fix(u.cookie, uid);
  assert.strictEqual(paid.status, 200);
  assert.strictEqual(paid.body.quota.usedCredit, true);
  assert.strictEqual(paid.body.quota.credits, 19);
  // The provider fails: the credit comes back.
  aiMode = 'fail';
  const failed = await fix(u.cookie, uid);
  aiMode = 'ok';
  assert.strictEqual(failed.status, 503);
  assert.strictEqual((await call('/api/billing/me', 'GET', null, u.cookie)).body.balance, 19);
});

test('payments that are not configured say so, and checkout failures never charge', async () => {
  const pine = require('../lib/pine');
  const u = await signup('buyer8@example.com');
  process.env.PINE_CLIENT_SECRET = 'wrong-secret';
  pine.resetTokenCache();
  const bad = await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie);
  process.env.PINE_CLIENT_SECRET = 'test-client-secret';
  pine.resetTokenCache();
  assert.strictEqual(bad.status, 502);
  assert.match(bad.body.error, /misconfigured|Nothing was charged/);
  const saved = process.env.PINE_CLIENT_ID;
  delete process.env.PINE_CLIENT_ID;
  assert.strictEqual((await call('/api/billing/checkout', 'POST', { packId: 'starter' }, u.cookie)).status, 503);
  process.env.PINE_CLIENT_ID = saved;
});

test('checkout links must be https and on a Pine Labs host', () => {
  const { safeCheckoutUrl } = require('../lib/pine');
  assert.ok(safeCheckoutUrl('https://api.pluralonline.com/api/v3/checkout-bff/redirect/checkout?token=x'));
  assert.ok(safeCheckoutUrl('https://pluraluat.v2.pinepg.in/pay'));
  assert.strictEqual(safeCheckoutUrl('http://api.pluralonline.com/x'), null);
  assert.strictEqual(safeCheckoutUrl('https://evil.example/pluralonline.com'), null);
  assert.strictEqual(safeCheckoutUrl('https://pluralonline.com.evil.example/x'), null);
  assert.strictEqual(safeCheckoutUrl('javascript:alert(1)'), null);
});
