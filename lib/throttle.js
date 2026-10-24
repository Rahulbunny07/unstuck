const { siteProvider } = require('./ai');

// Keeps the site's own AI key under its per-minute token limit. Requests that would go over
// wait in a first-come, first-served line instead of being refused by the provider, and are
// turned away early (with a time to retry) if the wait would be too long.
// It applies only to answers paid for by the site's key, and only inside this one server process.
const num = (name, fallback) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? v : fallback;
};

function cfg() {
  // Default fits a free Groq key (8,000 tokens a minute) with a safety margin. Off for other providers.
  const fallback = siteProvider() === 'groq' ? 6500 : 0;
  return {
    budget: num('THROTTLE_TOKENS_PER_MIN', fallback),
    window: num('THROTTLE_WINDOW_MS', 60000),
    maxWait: num('THROTTLE_MAX_WAIT_SECONDS', 30) * 1000,
    maxQueue: num('THROTTLE_MAX_QUEUE', 40),
  };
}

const entries = []; // { t, tokens } for answers started within the window
const waiters = []; // first in, first out
const recent = []; // real token totals of the latest finished answers
let timer = null;

const busy = retryAfter => Object.assign(new Error('busy'), { code: 'BUSY', retryAfter: Math.max(1, Math.ceil(retryAfter)) });

function prune(t, window) {
  while (entries.length && entries[0].t <= t - window) entries.shift();
}
const used = () => entries.reduce((n, e) => n + e.tokens, 0);

// Expected cost of the next answer: the recent average, or a safe guess before any are measured.
function estimate(budget) {
  // Measured answers with low reasoning effort average about 1,100 tokens; use a little more until real ones arrive.
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 1300;
  return Math.max(600, Math.min(Math.round(avg), budget));
}

// Seconds until a request of `est` tokens would fit, from the entries currently counted.
function secondsUntilFits(est, c, t) {
  const u = used();
  if (u + est <= c.budget || u === 0) return 0;
  let freed = 0;
  for (const e of entries) {
    freed += e.tokens;
    if (u - freed + est <= c.budget) return Math.max(0, (e.t + c.window - t) / 1000);
  }
  return c.window / 1000;
}

function pump() {
  if (timer) { clearTimeout(timer); timer = null; }
  const c = cfg();
  while (waiters.length) {
    const t = Date.now();
    prune(t, c.window);
    const w = waiters[0];
    const wait = secondsUntilFits(w.est, c, t);
    if (t > w.deadline) { waiters.shift(); w.reject(busy(wait || 1)); continue; }
    if (wait === 0) {
      waiters.shift();
      const ticket = { t, tokens: w.est, done: false };
      entries.push(ticket);
      w.resolve({ ticket, waitedMs: t - w.enq });
      continue;
    }
    if (t + wait * 1000 > w.deadline) {
      // Answers still running are counted at a guess. When they finish they report their real
      // (usually smaller) cost, which may make room, so do not turn anyone away yet.
      if (entries.some(e => !e.done)) {
        timer = setTimeout(pump, Math.max(20, Math.min(250, w.deadline - t)));
        break;
      }
      waiters.shift(); w.reject(busy(wait)); continue;
    }
    // Not unref'd: while someone is waiting, this timer is what wakes them up.
    timer = setTimeout(pump, Math.max(20, wait * 1000 + 5));
    break;
  }
}

// Resolves to { ticket, waitedMs } when it is this request's turn, or rejects with code BUSY.
// The returned promise has a cancel() for when the visitor leaves while waiting.
function acquire() {
  const c = cfg();
  if (!c.budget) return Object.assign(Promise.resolve({ ticket: null, waitedMs: 0 }), { cancel() {} });
  if (waiters.length >= c.maxQueue) {
    const p = Promise.reject(busy(secondsUntilFits(estimate(c.budget), c, Date.now()) || 5));
    p.catch(() => {});
    return Object.assign(p, { cancel() {} });
  }
  let waiter;
  const p = new Promise((resolve, reject) => {
    const enq = Date.now();
    waiter = { est: estimate(c.budget), enq, deadline: enq + c.maxWait, resolve, reject };
    waiters.push(waiter);
  });
  p.cancel = () => {
    const i = waiters.indexOf(waiter);
    if (i >= 0) { waiters.splice(i, 1); pump(); }
  };
  pump();
  return p;
}

// The answer finished: replace the guess with the tokens actually used.
function settle(ticket, actual) {
  if (!ticket) return;
  ticket.done = true;
  if (actual > 0) {
    ticket.tokens = actual;
    recent.push(actual);
    if (recent.length > 10) recent.shift();
  }
  pump();
}

// The call failed before using tokens: give the room back.
function release(ticket) {
  if (!ticket) return;
  ticket.done = true;
  ticket.tokens = 0;
  pump();
}

function snapshot() {
  const c = cfg();
  if (!c.budget) return { enabled: false, waiting: 0, etaSeconds: 0 };
  const t = Date.now();
  prune(t, c.window);
  const head = waiters[0];
  return {
    enabled: true,
    waiting: waiters.length,
    usedLastMinute: used(),
    budgetPerMinute: c.budget,
    // Answers still running usually finish within seconds and free room sooner than the window would.
    etaSeconds: Math.ceil((() => {
      const eta = secondsUntilFits(head ? head.est : estimate(c.budget), c, t);
      return entries.some(e => !e.done) ? Math.min(eta, 5) : eta;
    })()),
  };
}

function reset() { entries.length = 0; waiters.length = 0; recent.length = 0; if (timer) { clearTimeout(timer); timer = null; } }

module.exports = { acquire, settle, release, snapshot, reset };
