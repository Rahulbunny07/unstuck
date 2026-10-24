const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { prepare, detectPlatform, verifyEvidence } = require('./lib/clean');
const { checkSite } = require('./lib/sitecheck');
const store = require('./lib/db');
const { askModel, verifyKey, siteProvider } = require('./lib/ai');
const auth = require('./lib/auth');
const accounts = require('./lib/accounts');
const mcp = require('./lib/mcp');
const quota = require('./lib/quota');
const throttle = require('./lib/throttle');

const PORT = Number(process.env.PORT) || 3000;
const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-5-5';
const STRONG_MODEL = process.env.STRONG_MODEL || 'claude-sonnet-5-5';
const GROQ_FAST = process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b';
const GROQ_STRONG = process.env.GROQ_STRONG_MODEL || 'openai/gpt-oss-120b';
const OPENAI_FAST =process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini';
const OPENAI_STRONG = process.env.OPENAI_STRONG_MODEL || 'gpt-4o';
// A library fix is shown directly only above this score. Weaker matches go to the AI as hints.
const THRESHOLD = Number(process.env.MATCH_THRESHOLD) || 0.85;
const VERIFY_MIN = Number(process.env.VERIFY_MIN_VOTES) || 2;
const MAX_ATTEMPTS = 3;
const MAX_REFINES = 2;
const HINT_MIN = Number(process.env.HINT_MIN_SCORE) || 0.1;

const TOOLS = ['lovable', 'replit', 'bolt', 'cursor', 'other'];
const PLATFORMS = ['supabase', 'vercel', 'netlify', 'firebase', 'other'];

const seeded = store.seedIfEmpty();
if (seeded) console.log(`Seeded library with ${seeded} curated fixes`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '60kb' }));
app.use('/api', auth.sameOrigin, auth.attachUser);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

const hits = new Map();
function limit(max, windowMs = 60000, keyOf) {
  return (req, res, next) => {
    const key = (keyOf ? keyOf(req) : req.ip) + '|' + req.path;
    const now = Date.now();
    const rec = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    rec.push(now);
    hits.set(key, rec);
    next();
  };
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

const idOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

function badge(fix) {
  if (!fix) return { kind: 'unverified', label: 'AI-generated, not verified yet' };
  if (fix.worked >= VERIFY_MIN && fix.worked > fix.failed) return { kind: 'verified', label: `Verified by ${fix.worked} people`, count: fix.worked };
  if (fix.worked >= 1 && fix.worked > fix.failed) return { kind: 'confirmed', label: `Worked for ${fix.worked} ${fix.worked === 1 ? 'person' : 'people'}`, count: fix.worked };
  if (fix.source === 'seed') return { kind: 'curated', label: 'Curated by the Unstuck team' };
  return { kind: 'unverified', label: 'AI-generated, not verified yet' };
}

function publicFix(fix) {
  return {
    id: fix.id,
    title: fix.title,
    cause: fix.cause,
    evidence: fix.evidence,
    fix_prompt: fix.fix_prompt,
    verify_steps: fix.verify_steps,
    rollback: fix.rollback,
    confidence: fix.confidence,
    badge: badge(fix),
    worked: fix.worked,
    failed: fix.failed,
  };
}

function resetSummary(tool, platform, attempts, failedFixes) {
  const lines = [
    `Fresh start. I am building an app with ${tool || 'an AI builder'}${platform && platform !== 'other' ? ' on ' + platform : ''}.`,
    'Earlier in another chat these fixes did NOT work, so do not suggest them again:',
    ...failedFixes.map((f, i) => `${i + 1}. ${f.title}: ${f.cause}`),
    'Please read the current code and the latest error, then propose ONE minimal change and explain why before editing. Do not change anything unrelated.',
  ];
  return lines.join('\n');
}

// Many people share one Wi-Fi address at an event, so the per-address cap is generous and
// the tight cap is per browser user. Each person still gets 15 analyses a minute.
const fixPerIp = limit(300, 60000, req => 'ip:' + req.ip);
const fixPerUser = limit(15, 60000, req => 'u:' + (req.body && idOk(req.body.userId) ? req.body.userId : req.ip));
app.post('/api/fix', fixPerIp, fixPerUser, async (req, res) => {
  try {
    const b = req.body || {};
    const tool = TOOLS.includes(b.tool) ? b.tool : 'other';
    const platformChoice = PLATFORMS.includes(b.platform) ? b.platform : 'other';
    const rawError = typeof b.error === 'string' ? b.error : '';
    if (rawError.trim().length < 8) return res.status(400).json({ error: 'Paste the error message or log first. It looks too short to analyse.' });
    if (rawError.length > 20000) return res.status(400).json({ error: 'That log is very long. Paste just the part around the error.' });
    if (!idOk(b.userId) || !idOk(b.sessionId)) return res.status(400).json({ error: 'Session problem. Refresh the page and try again.' });

    store.ensureSession(b.sessionId, b.userId);
    const history = store.sessionAttempts(b.sessionId);
    if (history.length && history[0].user_id !== b.userId) return res.status(400).json({ error: 'Session problem. Refresh the page and try again.' });
    const active = history.filter(a => a.vote !== 'superseded');
    const refine = b.refine === true;
    const evidence = refine && typeof b.evidence === 'string' ? b.evidence.trim().slice(0, 4000) : '';
    if (refine) {
      // Extra evidence re-checks the same attempt instead of burning one of the three.
      const last = active[active.length - 1];
      if (!evidence) return res.status(400).json({ error: 'Paste the extra evidence first.' });
      if (!last || last.vote || last.served_from !== 'ai') return res.status(400).json({ error: 'There is nothing to re-check. Start a new problem.' });
      if (history.length - active.length >= MAX_REFINES) return res.status(400).json({ error: 'You have added evidence twice already. Try the fix, then tell us if it worked.' });
      store.supersede(last.id);
    } else {
      const unvoted = active.find(a => !a.vote);
      if (unvoted) {
        // Treat asking again without voting as "did not work" so the same fix is not served twice.
        store.recordVote(unvoted.id, b.userId, 'failed');
      }
    }
    const attemptHistory = store.sessionAttempts(b.sessionId).filter(a => a.vote !== 'superseded');
    const failedFixes = attemptHistory.filter(a => a.vote === 'failed' && a.fix_id).map(a => store.getFix(a.fix_id));
    const attemptNo = attemptHistory.length + 1;

    const prep = prepare({ error: rawError, context: [b.context, evidence && `Extra evidence from the user:\n${evidence}`].filter(Boolean).join('\n\n'), prompt: b.prompt });
    const platform = platformChoice === 'other' ? detectPlatform(prep.error + '\n' + prep.context) : platformChoice;
    const trace = [`Cleaned the log${prep.redactions ? ` and removed ${prep.redactions} secret${prep.redactions === 1 ? '' : 's'}` : ''}${prep.trimmed ? ', kept the useful lines' : ''}.`];
    if (platformChoice === 'other' && platform !== 'other') trace.push(`Recognised the platform as ${platform} from the error text.`);

    let site = null;
    const siteUrl = typeof b.siteUrl === 'string' ? b.siteUrl.trim() : '';
    if (siteUrl) {
      site = await checkSite(siteUrl);
      if (!site.ok) trace.push(`Live site check: ${site.error}`);
      else trace.push(`Live site check found ${site.findings.length ? site.findings.length + ' problem' + (site.findings.length === 1 ? '' : 's') : 'no obvious problems'} (no AI used).`);
    }
    const matchText = prep.error + (site && site.ok ? '\n' + site.markers.join('\n') : '');

    if (attemptNo > MAX_ATTEMPTS) {
      return res.json({
        status: 'reset',
        attempt: attemptNo - 1,
        summary: resetSummary(tool, platform, attemptNo - 1, failedFixes),
        message: 'Three fixes have not worked. Another try in the same chat usually makes things worse.',
      });
    }

    const siteView = site ? { ok: site.ok, error: site.error, facts: site.facts, findings: site.findings.map(f => f.text) } : null;
    const meta = { redactions: prep.redactions, trimmed: prep.trimmed, attempt: attemptNo, maxAttempts: MAX_ATTEMPTS, site: siteView };

    const found = store.findFix({
      signature: prep.signature,
      errorText: matchText,
      platform,
      excludeIds: failedFixes.map(f => f.id),
      threshold: THRESHOLD,
    });
    const hit = found.fix && !refine ? found : null;

    if (hit) {
      trace.push(`Checked ${found.considered} known fixes and found a match (${Math.round(found.score * 100)}% similar). No AI needed.`);
      const saved = Math.ceil((prep.error.length + prep.context.length) / 4) + 700;
      const attemptId = store.logAttempt({ sessionId: b.sessionId, userId: b.userId, fixId: hit.fix.id, attempt: attemptNo, servedFrom: 'library', tokensSaved: saved });
      return res.json({ status: 'ok', source: 'library', match: Math.round(hit.score * 100), attemptId, fix: publicFix(hit.fix), trace, ...meta });
    }
    trace.push(refine
      ? 'Re-checked with your extra evidence using the stronger AI.'
      : found.title
        ? `Checked ${found.considered} known fixes. Closest was "${found.title}" at ${Math.round(found.score * 100)}%, below the ${Math.round(THRESHOLD * 100)}% needed, so the AI took over.`
        : `Checked ${found.considered} known fixes and none were close, so the AI took over.`);

    // The closest curated fixes go to the AI as hints, so a paraphrased error still benefits from them.
    const near = found.near || [];
    const hints = near.filter(n => n.score >= HINT_MIN).slice(0, 2).map(n => n.fix);
    if (platform !== 'other') {
      // Wording rarely matches exactly, so a known platform brings in its own curated fixes too.
      for (const n of near) {
        if (hints.length >= 5) break;
        if (n.fix.platform === platform && n.fix.source === 'seed' && !hints.some(h => h.id === n.fix.id)) hints.push(n.fix);
      }
    }
    if (hints.length) trace.push(`Gave the AI ${hints.length === 1 ? 'a close known fix' : hints.length + ' close known fixes'} as ${hints.length === 1 ? 'a hint' : 'hints'}: ${hints.map(h => '"' + h.title + '"').join(', ')}.`);

    // A signed-in user's own default key is used for their AI calls, so it costs us nothing.
    const own = req.user ? accounts.defaultKeyFor(req.user.id) : null;
    const first = attemptNo === 1 && !refine;
    const via = own ? own.provider : siteProvider();
    const model = own && (own.provider === 'custom' || own.provider === 'agenticorg') ? own.model
      : via === 'openai' ? (first ? OPENAI_FAST : OPENAI_STRONG)
        : via === 'groq' ? (first ? GROQ_FAST : GROQ_STRONG)
          : (first ? FAST_MODEL : STRONG_MODEL);
    // The site's own AI is limited per person, per network and for the whole site each day.
    // Known-error answers above never reach this point, and people using their own key skip it.
    let ticket = null;
    let quotaInfo = null;
    if (!own && siteProvider()) {
      const q = quota.reserve({ userKey: req.user ? 'u:' + req.user.id : 'a:' + b.userId, signedIn: Boolean(req.user), ip: req.ip });
      if (!q.ok) return res.status(429).json({ error: quota.MESSAGES[q.reason](q.limit), quotaBlocked: q.reason });
      ticket = q.ticket;
      if (q.limit != null) quotaInfo = { remaining: q.remaining, limit: q.limit, signedIn: Boolean(req.user) };
    }
    // Wait for a turn under the provider's per-minute limit (the site's key only). People who
    // leave while waiting give their place and their free answer back.
    let slot = null;
    let waitedMs = 0;
    if (!own && siteProvider()) {
      const turn = throttle.acquire();
      let waiting = true;
      res.on('close', () => { if (waiting) { turn.cancel(); quota.refund(ticket); } });
      try {
        ({ ticket: slot, waitedMs } = await turn);
      } catch (e) {
        waiting = false;
        quota.refund(ticket);
        return res.status(503).json({
          error: `Lots of people are using Unstuck right now. Try again in about ${e.retryAfter || 30} seconds. Answers for known errors still work.`,
          busy: true, retryAfter: e.retryAfter || 30,
        });
      }
      waiting = false;
      if (waitedMs >= 1500) trace.push(`Waited ${Math.round(waitedMs / 1000)} seconds in line because many people were using the AI.`);
    }
    let ai;
    try {
      ai = await askModel(model, {
        tool, platform, error: prep.error,
        context: [prep.context, site && site.ok && `Live site check (measured by the server, treat as facts):\n${[...site.facts, ...site.findings.map(f => 'PROBLEM: ' + f.text)].join('\n')}`].filter(Boolean).join('\n\n'),
        prompt: prep.prompt, hints,
        failed: failedFixes.map(f => ({ cause: f.cause, fix_prompt: f.fix_prompt })),
      }, own ? { provider: own.provider, key: own.key, baseUrl: own.baseUrl, model: own.model } : undefined);
    } catch (e) {
      console.error('AI error:', e.code || '', e.message);
      const msg = {
        NO_KEY: 'This error is not in the library yet and no AI key is set up. Sign in and add your own API key in Account, or ask the site owner to add one.',
        BAD_KEY: own ? 'Your API key was rejected. Update it in Account.' : 'The AI key was rejected. Check ANTHROPIC_API_KEY on the server.',
        UPSTREAM: 'The AI is busy right now. Try again in a few seconds.',
        BAD_OUTPUT: 'The AI gave an answer we could not use. Try again.',
        BAD_AGENT: 'The AgenticOrg agent was not found. Check the agent ID in Account.',
        AGENT_WAIT: 'The AgenticOrg agent is waiting for approval in its own dashboard. Approve it there, then try again.',
        AGENT_BUDGET: 'The AgenticOrg agent has used up its budget.',
      }[e.code] || 'Something went wrong while analysing. Try again.';
      quota.refund(ticket);
      throttle.release(slot);
      return res.status(503).json({ error: msg });
    }
    quota.settle(ticket, ai.usage ? ai.usage.in + ai.usage.out : 0);
    throttle.settle(slot, ai.usage ? ai.usage.in + ai.usage.out : 0);

    // Only quotes that really appear in the user's input count as evidence.
    const ev = verifyEvidence(ai.fix.evidence, prep.error, prep.context, prep.prompt);
    ai.fix.evidence = ev.kept;
    let evidenceNote;
    if (ev.total === 0) {
      evidenceNote = 'The AI gave no quotes from your log, so this answer rests on its experience with this kind of error.';
    } else if (ev.kept.length === ev.total) {
      evidenceNote = `Checked: ${ev.total === 1 ? 'the quote appears' : 'all ' + ev.total + ' quotes appear'} in what you pasted.`;
    } else if (ev.kept.length) {
      evidenceNote = `${ev.total - ev.kept.length} of ${ev.total} quotes were not in your log and were removed.`;
    } else {
      evidenceNote = 'None of the AI\'s quotes were found in your log, so they were removed. Treat this answer with extra care.';
    }
    if (!ev.kept.length && ai.fix.confidence === 'high') ai.fix.confidence = 'medium';
    trace.push(`${model} wrote a new answer. ${evidenceNote} It stays "not verified" until someone confirms it worked.`);
    const saved = store.saveAiFix({ signature: prep.signature, platform, ...ai.fix });
    const attemptId = store.logAttempt({
      sessionId: b.sessionId, userId: b.userId, fixId: saved.id, attempt: attemptNo, servedFrom: 'ai', model,
      tokensIn: ai.usage && ai.usage.in, tokensOut: ai.usage && ai.usage.out,
    });
    return res.json({
      status: 'ok', source: 'ai', model, usedOwnKey: Boolean(own), attemptId,
      fix: { ...publicFix(saved), need_more: ai.fix.need_more, evidence_note: evidenceNote },
      tokens: ai.usage ? { in: ai.usage.in, out: ai.usage.out } : null,
      quota: quotaInfo,
      waitedMs,
      trace,
      ...meta,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  }
});

app.post('/api/vote', limit(60), (req, res) => {
  const { attemptId, userId, vote } = req.body || {};
  if (!Number.isInteger(attemptId) || !idOk(userId) || !['worked', 'failed'].includes(vote)) {
    return res.status(400).json({ error: 'Bad vote.' });
  }
  const r = store.recordVote(attemptId, userId, vote);
  if (r.error === 'not_found') return res.status(404).json({ error: 'Vote not found.' });
  if (r.error === 'already_voted') return res.status(409).json({ error: 'You already voted on this one.', vote: r.vote });
  res.json({ ok: true, fix: r.fix ? publicFix(r.fix) : null });
});

const publicUser = u => ({ id: u.id, email: u.email, name: u.name });

app.post('/api/auth/signup', limit(8), async (req, res) => {
  try {
    const v = auth.validateSignup(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const u = await auth.createUser(v);
    if (u.error) return res.status(409).json({ error: 'An account with that email already exists. Try signing in.' });
    auth.startSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create the account. Try again.' }); }
});

app.post('/api/auth/login', limit(10), async (req, res) => {
  try {
    const u = await auth.checkLogin((req.body || {}).email, (req.body || {}).password);
    if (!u) return res.status(401).json({ error: 'Email or password is not right.' });
    auth.startSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not sign in. Try again.' }); }
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.get('/api/keys', auth.requireUser, (req, res) => {
  res.json({ keys: accounts.listKeys(req.user.id), providers: accounts.PROVIDERS });
});

app.post('/api/keys', auth.requireUser, limit(10), async (req, res) => {
  const { provider, label } = req.body || {};
  const key = String((req.body || {}).key || '').trim();
  if (!accounts.PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Pick a provider.' });
  const custom = provider === 'custom';
  const agent = provider === 'agenticorg';
  if (key.length < (custom || agent ? 8 : 20) || key.length > 500 || /\s/.test(key)) return res.status(400).json({ error: 'That does not look like an API key.' });
  if (accounts.listKeys(req.user.id).length >= 5) return res.status(400).json({ error: 'You can store up to 5 keys. Remove one first.' });
  const baseUrl = custom ? String(req.body.baseUrl || '').trim() : '';
  const model = custom || agent ? String(req.body.model || '').trim().slice(0, 100) : '';
  if (custom && (!baseUrl || !/^[\w.:/-]{1,100}$/.test(model))) return res.status(400).json({ error: 'Enter the endpoint address and the model name for your custom provider.' });
  if (agent && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model)) return res.status(400).json({ error: 'Enter the agent ID. It is a long code like 3f2a9c1e-5b7d-4e8a-9c3f-1a2b3c4d5e6f.' });
  const check = await verifyKey(provider, key, { baseUrl, model });
  if (!check.ok) {
    const msg = {
      rejected: 'The provider rejected that key. Check it and try again.',
      bad_url: check.message,
      bad_request: 'The endpoint answered but did not accept the request. Check the address (it should end before /chat/completions) and the model name.',
      bad_agent: 'The key was accepted but that agent ID was not found. Check the agent ID.',
    }[check.reason] || 'Could not reach the provider to check the key. Try again.';
    return res.status(400).json({ error: msg });
  }
  res.json({ key: accounts.addKey(req.user.id, { provider, label, key, baseUrl, model }) });
});

app.post('/api/keys/:id/default', auth.requireUser, (req, res) => {
  if (!accounts.setDefaultKey(req.user.id, Number(req.params.id))) return res.status(404).json({ error: 'Key not found.' });
  res.json({ keys: accounts.listKeys(req.user.id) });
});

app.delete('/api/keys/:id', auth.requireUser, (req, res) => {
  if (!accounts.deleteKey(req.user.id, Number(req.params.id))) return res.status(404).json({ error: 'Key not found.' });
  res.json({ keys: accounts.listKeys(req.user.id) });
});

app.get('/api/mcp/catalog', (req, res) => res.json({ catalog: mcp.CATALOG }));

app.get('/api/mcp', auth.requireUser, (req, res) => {
  res.json({ servers: accounts.listMcp(req.user.id) });
});

app.post('/api/mcp', auth.requireUser, limit(10), async (req, res) => {
  const b = req.body || {};
  const entry = mcp.CATALOG.find(c => c.id === b.catalogId);
  if (!entry) return res.status(400).json({ error: 'Pick a server from the list.' });
  const url = String(b.url || entry.url).trim();
  const token = String(b.token || '').trim().slice(0, 500);
  if (accounts.listMcp(req.user.id).length >= 6) return res.status(400).json({ error: 'You can connect up to 6 servers. Remove one first.' });
  try {
    const inspected = await mcp.inspect(url, token);
    const name = String(b.name || '').trim().slice(0, 40) || entry.name;
    res.json({ server: accounts.addMcp(req.user.id, { catalogId: entry.id, name, url, token, inspected }) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not connect to that server.' });
  }
});

app.post('/api/mcp/:id/test', auth.requireUser, limit(10), async (req, res) => {
  const row = accounts.getMcp(req.user.id, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Server not found.' });
  try {
    res.json({ server: accounts.refreshMcp(req.user.id, row.id, await mcp.inspect(row.url, row.tokenPlain)) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not connect to that server.' });
  }
});

app.post('/api/mcp/:id/tools', auth.requireUser, (req, res) => {
  const names = Array.isArray((req.body || {}).enabled) ? req.body.enabled : [];
  const s = accounts.setMcpTools(req.user.id, Number(req.params.id), names);
  if (!s) return res.status(404).json({ error: 'Server not found.' });
  res.json({ server: s });
});

app.delete('/api/mcp/:id', auth.requireUser, (req, res) => {
  if (!accounts.deleteMcp(req.user.id, Number(req.params.id))) return res.status(404).json({ error: 'Server not found.' });
  res.json({ servers: accounts.listMcp(req.user.id) });
});

app.get('/api/stats', limit(120), (req, res) => {
  res.json({ ...store.stats(), aiToday: quota.snapshot() });
});

// How busy the AI line is right now, so the page can tell waiting people what to expect.
app.get('/api/queue', limit(120), (req, res) => {
  const s = throttle.snapshot();
  res.json({ enabled: s.enabled, waiting: s.waiting, etaSeconds: s.etaSeconds });
});

// How many free AI answers this person has left today (not counting known-error answers).
app.get('/api/quota', limit(60), (req, res) => {
  if (siteProvider() === null) return res.json({ available: false });
  const uid = String(req.query.userId || '');
  if (!req.user && !idOk(uid)) return res.json({ available: true, unknown: true });
  res.json({ available: true, signedIn: Boolean(req.user), ...quota.remainingFor({ userKey: req.user ? 'u:' + req.user.id : 'a:' + uid, signedIn: Boolean(req.user) }) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai: Boolean(siteProvider()), aiProvider: siteProvider(), library: store.stats().fixesInLibrary });
});

app.get('/api/new-id', (req, res) => {
  res.json({ id: crypto.randomBytes(12).toString('base64url') });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Unstuck running on http://localhost:${PORT}`);
    const sp = siteProvider();
    console.log(sp ? `Site AI: ${sp}` : 'Note: no site AI key is set (ANTHROPIC_API_KEY, GROQ_API_KEY). Library answers work, new errors will not.');
  });
}

module.exports = app;
