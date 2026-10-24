const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-claims-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 31).toString('base64');
delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENTICORG_API_KEY; delete process.env.GROQ_API_KEY;
delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; delete process.env.PINE_CLIENT_ID;
const TOKEN = 'admin-token-for-tests-1234567890';
process.env.ADMIN_TOKEN = TOKEN;

const app = require('../server');
let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const call = async (p, method, body, cookie, admin) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(admin !== undefined ? { 'x-admin-token': admin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};
const signup = async email => { const r = await call('/api/auth/signup', 'POST', { email, password: 'claims-password-1' }); return { cookie: r.cookie }; };
const balance = async u => (await call('/api/billing/claims', 'GET', null, u.cookie)).body.balance;

test('claiming needs sign-in and a payment id that looks like a Razorpay one', async () => {
  assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: 'pay_AbCdEf123456' })).status, 401);
  const u = await signup('claim1@example.com');
  for (const bad of ['', 'order_AbCdEf123456', 'pay_', 'pay_short', 'pay_ has space 123456', "pay_'; DROP TABLE users;--", 12345]) {
    assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: bad }, u.cookie)).status, 400, String(bad));
  }
  const ok = await call('/api/billing/claim', 'POST', { paymentId: 'pay_AbCdEf123456', note: 'Paid Rs 49' }, u.cookie);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.claim.status, 'PENDING');
});

test('the same payment id cannot be claimed twice, even by another person, and users only see their own', async () => {
  const a = await signup('claim2@example.com');
  const b = await signup('claim3@example.com');
  assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: 'pay_ShareMe123456' }, a.cookie)).status, 200);
  assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: 'pay_ShareMe123456' }, a.cookie)).status, 409);
  assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: 'pay_ShareMe123456' }, b.cookie)).status, 409);
  assert.strictEqual((await call('/api/billing/claims', 'GET', null, b.cookie)).body.claims.length, 0);
  assert.strictEqual((await call('/api/billing/claims', 'GET', null, a.cookie)).body.claims.length, 1);
});

test('a person cannot pile up more than 5 waiting claims', async () => {
  const u = await signup('claim4@example.com');
  for (let i = 0; i < 5; i++) assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: `pay_Pile${i}Pile${i}Pile${i}` }, u.cookie)).status, 200);
  assert.strictEqual((await call('/api/billing/claim', 'POST', { paymentId: 'pay_OneTooMany123456' }, u.cookie)).status, 429);
});

test('admin actions need the exact admin token, and are off if it is missing or too short', async () => {
  assert.strictEqual((await call('/api/admin/claims', 'GET')).status, 401);
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, null, 'wrong')).status, 401);
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, null, TOKEN + 'x')).status, 401);
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, null, TOKEN)).status, 200);
  const saved = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'short';
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, null, 'short')).status, 401);
  delete process.env.ADMIN_TOKEN;
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, null, '')).status, 401);
  process.env.ADMIN_TOKEN = saved;
  // A signed-in user's cookie is not admin access.
  const u = await signup('claim5@example.com');
  assert.strictEqual((await call('/api/admin/claims', 'GET', null, u.cookie)).status, 401);
});

test('approving grants credits once, rejecting grants none, and bad amounts are refused', async () => {
  const u = await signup('claim6@example.com');
  await call('/api/billing/claim', 'POST', { paymentId: 'pay_Approve123456' }, u.cookie);
  await call('/api/billing/claim', 'POST', { paymentId: 'pay_Reject1234567' }, u.cookie);
  const list = (await call('/api/admin/claims', 'GET', null, null, TOKEN)).body.claims;
  const mine = list.filter(c => c.email === 'claim6@example.com');
  const approve = mine.find(c => c.payment_ref === 'pay_Approve123456');
  const reject = mine.find(c => c.payment_ref === 'pay_Reject1234567');
  assert.ok(approve && reject);

  assert.strictEqual((await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 0 }, null, TOKEN)).status, 400);
  assert.strictEqual((await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 1.5 }, null, TOKEN)).status, 400);
  assert.strictEqual((await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 999999 }, null, TOKEN)).status, 400);
  assert.strictEqual((await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 20 }, null, 'nope')).status, 401);
  assert.strictEqual(await balance(u), 0);

  const ok = await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 20 }, null, TOKEN);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.balance, 20);
  assert.strictEqual((await call(`/api/admin/claims/${approve.id}/approve`, 'POST', { credits: 20 }, null, TOKEN)).status, 409);
  assert.strictEqual(await balance(u), 20, 'a second approval must not add more');

  assert.strictEqual((await call(`/api/admin/claims/${reject.id}/reject`, 'POST', {}, null, TOKEN)).status, 200);
  assert.strictEqual((await call(`/api/admin/claims/${reject.id}/approve`, 'POST', { credits: 20 }, null, TOKEN)).status, 409);
  assert.strictEqual(await balance(u), 20);
  const after = (await call('/api/billing/claims', 'GET', null, u.cookie)).body.claims;
  assert.deepStrictEqual(after.map(c => c.status).sort(), ['APPROVED', 'REJECTED']);
});

test('the pay page and admin page are served, and the Razorpay button script is allowed by the page policy', async () => {
  const pay = await fetch(base + '/pay.html');
  assert.strictEqual(pay.status, 200);
  const html = await pay.text();
  assert.match(html, /checkout\.razorpay\.com\/v1\/payment-button\.js/);
  assert.match(html, /pl_GYkDXxW4V0Z3pZ/);
  assert.match(pay.headers.get('content-security-policy'), /script-src[^;]*checkout\.razorpay\.com/);
  // The relaxed policy is only for the pay page: Razorpay's button needs eval, nothing else does.
  assert.match(pay.headers.get('content-security-policy'), /'unsafe-eval'/);
  for (const strict of ['/', '/account.html', '/admin.html', '/auth.html']) {
    const r = await fetch(base + strict);
    assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-eval|unsafe-inline/, strict);
  }
  assert.strictEqual((await fetch(base + '/admin.html')).status, 200);
});
