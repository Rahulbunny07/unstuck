const crypto = require('crypto');

// Pine Labs Online hosted checkout, called only from this server. The browser never sees the
// client secret or a Pine Labs access token. Defaults to the UAT (test) environment.
const base = () => (process.env.PINE_BASE_URL || 'https://pluraluat.v2.pinepg.in/api').replace(/\/+$/, '');
const configured = () => Boolean(process.env.PINE_CLIENT_ID && process.env.PINE_CLIENT_SECRET);
const isTestMode = () => /pinepg\.in|uat/i.test(base());

const failure = (code, message, status) => Object.assign(new Error(message), { code, status });

const headers = token => ({
  accept: 'application/json',
  'content-type': 'application/json',
  'Request-ID': crypto.randomUUID(),
  'Request-Timestamp': new Date().toISOString(),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function call(method, url, token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { method, headers: headers(token), body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      // Only the status and Pine Labs' own message are kept. Never the request, which holds secrets.
      const msg = String(data.message || data.error_message || data.response_message || '').slice(0, 160);
      throw failure(res.status === 401 ? 'PINE_AUTH' : 'PINE_HTTP', msg || `Pine Labs answered with status ${res.status}`, res.status);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw failure('PINE_TIMEOUT', 'Pine Labs took too long to answer.');
    if (e.code) throw e;
    throw failure('PINE_NETWORK', 'Could not reach Pine Labs.');
  } finally {
    clearTimeout(timer);
  }
}

let cached = null;
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.value;
  const d = await call('POST', `${base()}/auth/v1/token`, null, {
    client_id: process.env.PINE_CLIENT_ID,
    client_secret: process.env.PINE_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  if (!d.access_token) throw failure('PINE_AUTH', 'Pine Labs did not return an access token.');
  cached = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return cached.value;
}

// Creates a hosted checkout. `paise` is the amount in the smallest unit (50000 = Rs 500).
async function createCheckout({ reference, paise, email, customerId, callbackUrl }) {
  const d = await call('POST', `${base()}/checkout/v1/orders`, await token(), {
    merchant_order_reference: reference,
    order_amount: { value: paise, currency: 'INR' },
    integration_mode: 'REDIRECT',
    pre_auth: false,
    allowed_payment_methods: ['CARD', 'UPI', 'NETBANKING', 'WALLET'],
    callback_url: callbackUrl,
    failure_callback_url: callbackUrl,
    purchase_details: { customer: { email_id: email, customer_id: customerId } },
  });
  if (!d.order_id || !d.redirect_url) throw failure('PINE_HTTP', 'Pine Labs did not return a checkout link.');
  return { orderId: String(d.order_id), redirectUrl: String(d.redirect_url) };
}

// The source of truth for whether a payment happened: ask Pine Labs, never trust the browser.
async function getOrderByReference(reference) {
  const d = await call('GET', `${base()}/pay/v1/orders/reference/${encodeURIComponent(reference)}`, await token());
  return d.data || null;
}

// A checkout link must be https and on a Pine Labs host before we send a customer there.
function safeCheckoutUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const allowed = (process.env.PINE_CHECKOUT_HOSTS || 'pluralonline.com,pinepg.in,pluralpay.in,pinelabs.com').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.some(h => u.hostname === h || u.hostname.endsWith('.' + h)) ? u.toString() : null;
}

const resetTokenCache = () => { cached = null; };

module.exports = { configured, isTestMode, createCheckout, getOrderByReference, safeCheckoutUrl, resetTokenCache };
