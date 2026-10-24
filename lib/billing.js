const crypto = require('crypto');
const { db } = require('./db');
const pine = require('./pine');
const razorpay = require('./razorpay');

// Credits are an append-only ledger: purchases add, answers subtract, failed answers give one back.
// A purchase is credited at most once per order because (reason, ref) must be unique.
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    merchant_ref TEXT NOT NULL UNIQUE,
    pine_order_id TEXT,
    pack_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_user ON payment_orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_pine ON payment_orders(pine_order_id);
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (reason, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);
`);

// Older databases lack the provider column. Orders made before it existed were Pine Labs orders.
try { db.exec("ALTER TABLE payment_orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'pine'"); } catch { /* already there */ }

// PLACEHOLDER prices. Set them from the real cost of an answer (measured at roughly 1,100 to
// 1,900 tokens) plus payment fees and tax, and have them reviewed before charging real money.
// The server decides the price: the browser only ever sends a pack id.
const PACKS = [
  { id: 'starter', credits: 20, paise: 4900, label: '20 AI answers' },
  { id: 'plus', credits: 100, paise: 19900, label: '100 AI answers' },
  { id: 'pro', credits: 300, paise: 49900, label: '300 AI answers' },
];

const balance = userId => db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE user_id = ?').get(userId).n;

function addCredits(userId, delta, reason, ref) {
  try {
    db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?,?,?,?)').run(userId, delta, reason, ref);
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false; // already recorded
    throw e;
  }
}

// Takes one credit, only if there is one. Safe against two answers racing for the last credit.
function spend(userId, ref) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (balance(userId) < 1) { db.exec('ROLLBACK'); return false; }
    addCredits(userId, -1, 'spend', ref);
    db.exec('COMMIT');
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const refundSpend = (userId, ref) => addCredits(userId, 1, 'refund', ref);

function createOrder(userId, pack, provider = 'pine') {
  const ref = `unstuck-${userId}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const info = db.prepare('INSERT INTO payment_orders (user_id, merchant_ref, pack_id, credits, amount_paise, provider) VALUES (?,?,?,?,?,?)')
    .run(userId, ref, pack.id, pack.credits, pack.paise, provider);
  return db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(Number(info.lastInsertRowid));
}

const setPineOrder = (id, pineOrderId) => db.prepare("UPDATE payment_orders SET pine_order_id = ?, status = 'PENDING', updated_at = datetime('now') WHERE id = ?").run(pineOrderId, id);
const setStatus = (id, status) => db.prepare("UPDATE payment_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
const findByPineOrderId = pineId => db.prepare('SELECT * FROM payment_orders WHERE pine_order_id = ?').get(pineId);
const openOrdersFor = userId => db.prepare("SELECT * FROM payment_orders WHERE user_id = ? AND status IN ('CREATED','PENDING') AND pine_order_id IS NOT NULL AND created_at > datetime('now','-1 day')").all(userId);
const recentOrders = userId => db.prepare('SELECT id, pack_id, credits, amount_paise, status, created_at FROM payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId);

// Credits an order once, inside a transaction, and marks it paid. Safe to call again.
function creditOrder(order) {
  db.exec('BEGIN IMMEDIATE');
  try {
    addCredits(order.user_id, order.credits, 'purchase', order.merchant_ref); // no-op if already credited
    setStatus(order.id, 'PAID');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Razorpay: asks Razorpay about one payment and credits the order only if that payment belongs to
// this order, is captured, and is for exactly the amount we asked for.
async function settleRazorpayPayment(order, paymentId) {
  if (order.status === 'PAID') return 'success';
  let p;
  try { p = await razorpay.fetchPayment(paymentId); } catch (e) { console.error('Razorpay payment lookup failed:', e.code, e.message); return 'pending'; }
  if (!p || p.order_id !== order.pine_order_id) return 'failed'; // a payment for some other order
  const status = String(p.status || '').toLowerCase();
  if (status === 'captured') {
    if (Number(p.amount) !== order.amount_paise || String(p.currency || '').toUpperCase() !== 'INR') {
      console.error('Payment amount mismatch for', order.merchant_ref);
      setStatus(order.id, 'MISMATCH');
      return 'failed';
    }
    creditOrder(order);
    return 'success';
  }
  if (status === 'failed') return 'failed';
  return 'pending'; // created or authorized: not money in yet
}

// Asks the provider what really happened to an order and credits it once if it was paid in full.
// Returns 'success', 'failed' or 'pending'.
async function verifyAndSettle(order) {
  if (order.status === 'PAID') return 'success';
  if (order.provider === 'razorpay') {
    let items;
    try { items = await razorpay.fetchOrderPayments(order.pine_order_id); } catch (e) { console.error('Razorpay lookup failed:', e.code, e.message); return 'pending'; }
    const done = items.find(p => String(p.status).toLowerCase() === 'captured');
    if (done) return settleRazorpayPayment(order, done.id);
    return items.length && items.every(p => String(p.status).toLowerCase() === 'failed') ? 'failed' : 'pending';
  }
  let data;
  try {
    data = await pine.getOrderByReference(order.merchant_ref);
  } catch (e) {
    console.error('Pine Labs lookup failed:', e.code, e.message);
    return 'pending';
  }
  if (!data) return 'pending';
  const status = String(data.status || '').toUpperCase();
  const amount = data.order_amount || {};
  if (status === 'PROCESSED') {
    // Only credit when the amount matches what we asked for. A different amount means something is off.
    if (Number(amount.value) !== order.amount_paise || String(amount.currency || 'INR').toUpperCase() !== 'INR') {
      console.error('Payment amount mismatch for', order.merchant_ref);
      setStatus(order.id, 'MISMATCH');
      return 'failed';
    }
    creditOrder(order);
    return 'success';
  }
  if (['FAILED', 'CANCELLED'].includes(status)) { setStatus(order.id, status); return 'failed'; }
  return 'pending';
}

// Which provider takes payments right now. Razorpay wins if both are configured.
const activeProvider = () => (razorpay.configured() ? 'razorpay' : pine.configured() ? 'pine' : null);
const findByProviderOrder = (provider, id) => db.prepare('SELECT * FROM payment_orders WHERE provider = ? AND pine_order_id = ?').get(provider, id);

module.exports = { PACKS, balance, spend, refundSpend, createOrder, setPineOrder, setStatus, findByPineOrderId, findByProviderOrder, openOrdersFor, recentOrders, verifyAndSettle, settleRazorpayPayment, activeProvider };
