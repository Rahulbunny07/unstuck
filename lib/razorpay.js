const crypto = require('crypto');

// Razorpay Standard Checkout. The server creates the order and later verifies the payment. The
// browser only ever receives the public key id, never the secret.
const base = () => (process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
const configured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const keyId = () => process.env.RAZORPAY_KEY_ID;
// Test keys start with rzp_test_ and live keys with rzp_live_.
const isTestMode = () => String(process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_');

const failure = (code, message, status) => Object.assign(new Error(message), { code, status });

async function call(method, path, body) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${base()}${path}`, {
      method, redirect: 'manual', signal: ctrl.signal,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Keep only the status and Razorpay's own description. Never the request, which holds the secret.
      const msg = String((data.error && data.error.description) || '').slice(0, 160);
      throw failure(res.status === 401 ? 'RZP_AUTH' : 'RZP_HTTP', msg || `Razorpay answered with status ${res.status}`, res.status);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw failure('RZP_TIMEOUT', 'Razorpay took too long to answer.');
    if (e.code) throw e;
    throw failure('RZP_NETWORK', 'Could not reach Razorpay.');
  } finally {
    clearTimeout(timer);
  }
}

// `paise` is the smallest unit: 4900 is Rs 49. The receipt is our own reference (40 characters at most).
async function createOrder({ paise, receipt, notes }) {
  const o = await call('POST', '/orders', { amount: paise, currency: 'INR', receipt, notes });
  if (!o.id) throw failure('RZP_HTTP', 'Razorpay did not return an order.');
  return { id: String(o.id), amount: o.amount, currency: o.currency };
}

const fetchPayment = id => call('GET', `/payments/${encodeURIComponent(id)}`);
const fetchOrderPayments = async orderId => (await call('GET', `/orders/${encodeURIComponent(orderId)}/payments`)).items || [];

// HMAC-SHA256 of "order_id|payment_id" with the key secret, as hex. The order id must be the one
// our server stored, not the one the browser sends back.
function verifySignature(orderId, paymentId, signature) {
  if (!process.env.RAZORPAY_KEY_SECRET || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, keyId, isTestMode, createOrder, fetchPayment, fetchOrderPayments, verifySignature };
