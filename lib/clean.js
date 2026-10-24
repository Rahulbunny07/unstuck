const crypto = require('crypto');

const MAX_LOG_CHARS = 6000;
const MAX_CONTEXT_CHARS = 4000;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_KEY]'],
  [/(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|anon[_-]?key|service[_-]?role[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, '$1[REDACTED]$2'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
];

function redact(text) {
  let out = String(text || '');
  let count = 0;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      count += 1;
      return typeof rep === 'string' ? rep.replace(/\$(\d)/g, (_, i) => args[Number(i)] || '') : rep;
    });
  }
  return { text: out, redactions: count };
}

const SIGNAL = /(error|err!|exception|failed|fatal|cannot|can't|unable|denied|refused|unauthorized|forbidden|invalid|undefined|null|not found|missing|violat|timeout|cors|blocked|\b4\d\d\b|\b5\d\d\b|at\s+\S+\s+\(|^\s+at\s)/i;

// Keeps the lines most likely to explain the failure and drops the noise,
// so we send (and pay for) fewer tokens.
function trimLog(text, limit = MAX_LOG_CHARS) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const full = lines.join('\n').trim();
  if (full.length <= limit) return { text: full, trimmed: false };
  const keep = new Set();
  lines.forEach((line, i) => {
    if (i < 8 || i >= lines.length - 12 || SIGNAL.test(line)) {
      keep.add(i);
      if (SIGNAL.test(line)) { keep.add(i - 1); keep.add(i + 1); }
    }
  });
  const picked = [...keep].filter(i => i >= 0 && i < lines.length).sort((a, b) => a - b);
  let out = [];
  let last = -2;
  for (const i of picked) {
    if (i !== last + 1) out.push('...');
    out.push(lines[i].length > 400 ? lines[i].slice(0, 400) + ' [cut]' : lines[i]);
    last = i;
  }
  let joined = out.join('\n');
  if (joined.length > limit) joined = joined.slice(0, limit) + '\n[log shortened]';
  return { text: joined, trimmed: true };
}

// Removes the parts of an error that change between users (ids, paths, numbers,
// hashes, quoted values) so two people with the same problem look the same.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[a-z]:\\[^\s'"]+|(?:\/[\w.@-]+){2,}/g, ' path ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ' uuid ')
    .replace(/\b[0-9a-f]{12,}\b/g, ' hash ')
    .replace(/\[redacted[^\]]*\]/g, ' secret ')
    .replace(/"[^"]{1,60}"|'[^']{1,60}'/g, m => (/^["'][a-z_ ]{2,30}["']$/.test(m) ? m : ' val '))
    .replace(/\b\d+(\.\d+)*\b/g, ' n ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'at', 'on', 'is', 'it', 'and', 'or', 'for', 'n', 'val', 'path', 'url', 'hash', 'uuid', 'secret', 'js', 'ts', 'tsx', 'jsx', 'node', 'modules', 'src']);

function tokens(text) {
  return normalize(text).split(' ').filter(t => t.length > 1 && !STOP.has(t));
}

function shingles(toks) {
  const set = new Set(toks);
  for (let i = 0; i < toks.length - 1; i++) set.add(toks[i] + '_' + toks[i + 1]);
  return set;
}

function similarity(a, b) {
  const A = shingles(tokens(a));
  const B = shingles(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return 0.5 * jaccard + 0.5 * containment;
}

function fingerprint(text, platform = '') {
  const sig = tokens(text).slice(0, 60).join(' ');
  return crypto.createHash('sha256').update(platform + '|' + sig).digest('hex').slice(0, 24);
}

// One short line describing the error, used as the library signature.
function signature(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const best = lines.find(l => /error|exception|failed|cannot|invalid|denied|violat|not found|undefined|blocked/i.test(l)) || lines[0] || '';
  return best.slice(0, 240);
}

// The AI is asked to quote the user's log as evidence, but models sometimes paraphrase or
// invent a line. Keep only quotes that really appear in what the user supplied.
function verifyEvidence(quotes, ...sources) {
  const squash = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const hay = squash(sources.join('\n'));
  const kept = [];
  for (const q of quotes || []) {
    const t = squash(q).replace(/(\.\.\.|…)$/, '').replace(/^(\.\.\.|…)/, '').trim();
    if (t.length >= 6 && hay.includes(t)) kept.push(q);
  }
  return { kept, total: (quotes || []).length };
}

// Guesses the hosting platform from the error text so "Not sure" users still get the right fix.
function detectPlatform(text) {
  const t = String(text || '').toLowerCase();
  if (/supabase|row-level security|postgrest|pgrst\d+|\b42501\b|schema cache/.test(t)) return 'supabase';
  if (/vercel|\.vercel\.app|\bnow\.sh\b/.test(t)) return 'vercel';
  if (/netlify|\.netlify\.app/.test(t)) return 'netlify';
  if (/firebase|firestore|\.firebaseapp\.com/.test(t)) return 'firebase';
  return 'other';
}

function prepare({ error, context, prompt }) {
  const e = redact(error);
  const c = redact(context);
  const p = redact(prompt);
  const log = trimLog(e.text);
  return {
    error: log.text,
    context: c.text.slice(0, MAX_CONTEXT_CHARS),
    prompt: p.text.slice(0, 1500),
    redactions: e.redactions + c.redactions + p.redactions,
    trimmed: log.trimmed,
    signature: signature(log.text),
  };
}

module.exports = { prepare, redact, trimLog, normalize, similarity, fingerprint, signature, detectPlatform, verifyEvidence };
