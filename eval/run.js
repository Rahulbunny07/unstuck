// Runs every case in eval/cases.js through a running Unstuck server (the real pipeline),
// then asks a stronger model to grade each answer against the expected cause.
//   1. Start the server on a scratch database:  PORT=3020 DB_PATH=... npm start
//   2. Run:  EVAL_BASE=http://127.0.0.1:3020 npm run eval
const fs = require('fs');
const path = require('path');
// EVAL_SET=holdout runs the second, untuned set instead.
const cases = require(process.env.EVAL_SET === 'holdout' ? './cases-holdout' : './cases');

const BASE = process.env.EVAL_BASE || 'http://127.0.0.1:3020';
const KEY = process.env.GROQ_API_KEY;
const JUDGE = process.env.EVAL_JUDGE_MODEL || process.env.GROQ_STRONG_MODEL || 'openai/gpt-oss-120b';
const GROQ = (process.env.GROQ_CHAT_URL || 'https://api.groq.com/openai/v1/chat/completions');
const only = process.argv.slice(2);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

async function ask(c, n) {
  return withRetry(async () => {
    const res = await fetch(BASE + '/api/fix', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: c.tool, platform: c.platform, error: c.error, userId: `sample_eval${String(n).padStart(4, '0')}x`, sessionId: `sess_eval_${Date.now()}_${n}` }),
    });
    const d = await res.json();
    if (res.status === 503 || res.status === 429) throw new Error(d.error || 'busy');
    return { status: res.status, body: d };
  });
}

const JUDGE_SYSTEM = `You grade troubleshooting answers. You get an error, the correct root cause written by an expert, and a proposed answer.
Grade strictly:
- "correct": the answer's cause matches the expert cause AND its fix prompt would actually fix it, with no wrong or harmful step (such as invalid syntax, disabling security, or blaming an unrelated service).
- "partial": the cause is right or close, but the fix is vague, incomplete, or includes a wrong step.
- "wrong": the cause differs from the expert cause, or the fix would not work.
Respond with ONLY JSON: {"verdict":"correct"|"partial"|"wrong","reason":"one sentence"}`;

async function judge(c, fix) {
  const user = `ERROR:\n${c.error}\n\nEXPERT ROOT CAUSE:\n${c.expected}\n\nPROPOSED ANSWER:\nCause: ${fix.cause}\nFix prompt: ${fix.fix_prompt}\nCheck: ${fix.verify_steps}`;
  return withRetry(async () => {
    const res = await fetch(GROQ, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: JUDGE, max_tokens: 3000, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error('judge http ' + res.status);
    const d = await res.json();
    const text = d.choices[0].message.content || '';
    const m = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const v = JSON.parse(m);
    if (!['correct', 'partial', 'wrong'].includes(v.verdict)) throw new Error('bad verdict');
    return v;
  });
}

function conceptCheck(c, fix) {
  const text = `${fix.cause} ${fix.fix_prompt} ${fix.title}`.toLowerCase();
  return c.concepts.every(group => group.some(w => text.includes(w.toLowerCase())));
}

(async () => {
  if (!KEY) { console.error('GROQ_API_KEY is needed for grading. Run with: node --env-file=.env eval/run.js'); process.exit(1); }
  const list = cases.filter(c => !only.length || only.includes(c.id));
  const results = [];
  let n = 0;
  for (const c of list) {
    n++;
    process.stdout.write(`[${n}/${list.length}] ${c.id.padEnd(18)} `);
    const r = { id: c.id, platform: c.platform, tool: c.tool };
    try {
      const a = await ask(c, n);
      if (a.status !== 200) { r.error = a.body.error || 'http ' + a.status; console.log('ERROR', r.error); results.push(r); continue; }
      const f = a.body.fix;
      Object.assign(r, { source: a.body.source, confidence: f.confidence, title: f.title, cause: f.cause, fix_prompt: f.fix_prompt, hinted: (a.body.trace || []).some(t => /hint/.test(t)) });
      r.concepts = conceptCheck(c, f);
      const v = await judge(c, f);
      r.verdict = v.verdict; r.reason = v.reason;
      console.log(`${r.verdict.padEnd(8)} ${r.source.padEnd(8)} conf=${r.confidence.padEnd(6)} keywords=${r.concepts ? 'yes' : 'no'}`);
    } catch (e) {
      r.error = e.message; console.log('ERROR', e.message);
    }
    results.push(r);
    await sleep(800);
  }

  const done = results.filter(r => r.verdict);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : 'n/a');
  const count = (arr, v) => arr.filter(r => r.verdict === v).length;
  const bucket = (name, arr) => `${name.padEnd(28)} ${String(arr.length).padStart(2)} cases | correct ${pct(count(arr, 'correct'), arr.length).padStart(4)} | partial ${count(arr, 'partial')} | wrong ${count(arr, 'wrong')}`;

  console.log('\n===== SUMMARY =====');
  console.log(`Cases run: ${list.length} | graded: ${done.length} | errors: ${results.length - done.length}`);
  console.log(`Judge model: ${JUDGE} (answers were produced by the app's own pipeline)`);
  console.log(bucket('ALL graded', done));
  console.log(bucket('Served from library', done.filter(r => r.source === 'library')));
  console.log(bucket('Written by AI', done.filter(r => r.source === 'ai')));
  console.log(bucket('AI, with platform hints', done.filter(r => r.source === 'ai' && r.hinted)));
  console.log(bucket('AI, no hints', done.filter(r => r.source === 'ai' && !r.hinted)));
  for (const p of [...new Set(done.map(r => r.platform))]) console.log(bucket('Platform: ' + p, done.filter(r => r.platform === p)));
  for (const cf of ['high', 'medium', 'low']) {
    const arr = done.filter(r => r.confidence === cf);
    if (arr.length) console.log(bucket(`Model said "${cf}" confidence`, arr));
  }
  const agree = done.filter(r => (r.verdict === 'correct') === r.concepts).length;
  console.log(`Keyword check agrees with the judge on ${agree}/${done.length} cases.`);

  const bad = done.filter(r => r.verdict !== 'correct');
  if (bad.length) {
    console.log('\n----- Not fully correct -----');
    for (const r of bad) console.log(`* ${r.id} [${r.verdict}, ${r.source}, conf ${r.confidence}]\n    answer: ${r.cause}\n    judge: ${r.reason}`);
  }
  const out = path.join(__dirname, 'results');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), judge: JUDGE, results }, null, 2));
  console.log('\nFull results saved to', file);
})();
