const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { similarity, fingerprint } = require('./clean');
const SEEDS = require('./seeds');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'unstuck.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,
    signature TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'any',
    title TEXT NOT NULL,
    cause TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    fix_prompt TEXT NOT NULL,
    verify_steps TEXT NOT NULL,
    rollback TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'medium',
    match_rules TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'ai',
    worked INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fixes_fp ON fixes(fingerprint);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    fix_id INTEGER,
    attempt INTEGER NOT NULL,
    served_from TEXT NOT NULL,
    model TEXT,
    est_tokens_saved INTEGER NOT NULL DEFAULT 0,
    vote TEXT,
    voted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
`);
// Real token counts reported by the AI provider. Older databases lack these columns.
for (const col of ['tokens_in', 'tokens_out']) {
  try { db.exec(`ALTER TABLE attempts ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch { /* already there */ }
}

const j = v => JSON.stringify(v ?? []);
const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

function rowToFix(r) {
  if (!r) return null;
  return { ...r, evidence: parse(r.evidence, []) };
}

// Keeps curated seeds in sync with lib/seeds.js on every start: new ones are added,
// edited ones are updated. Vote counts and user-confirmed fixes are never touched.
function seedIfEmpty() {
  const find = db.prepare("SELECT id FROM fixes WHERE source = 'seed' AND title = ?");
  const ins = db.prepare(`INSERT INTO fixes
    (fingerprint, signature, platform, title, cause, evidence, fix_prompt, verify_steps, rollback, confidence, match_rules, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'seed')`);
  const upd = db.prepare(`UPDATE fixes SET fingerprint=?, signature=?, platform=?, cause=?, evidence=?, fix_prompt=?,
    verify_steps=?, rollback=?, confidence=?, match_rules=? WHERE id=?`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const s of SEEDS) {
      const fp = fingerprint(s.signature, s.platform);
      const row = find.get(s.title);
      if (row) {
        upd.run(fp, s.signature, s.platform, s.cause, j(s.evidence), s.fix_prompt, s.verify_steps, s.rollback, s.confidence || 'high', j(s.match), row.id);
      } else {
        ins.run(fp, s.signature, s.platform, s.title, s.cause, j(s.evidence), s.fix_prompt, s.verify_steps, s.rollback, s.confidence || 'high', j(s.match));
        added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return added;
}

// Finds the best stored fix for an error. Fixes that already failed for this
// session are excluded so the user never sees the same answer twice.
function findFix({ signature, errorText, platform, excludeIds = [], threshold = 0.62 }) {
  const fp = fingerprint(signature, platform);
  const exclude = new Set(excludeIds);
  // Only curated seeds and fixes that users confirmed are served from the
  // library. A fresh AI answer with no "worked" vote is never reused.
  const eligible = r => r.source === 'seed' || r.worked > r.failed;
  const exact = db.prepare('SELECT * FROM fixes WHERE fingerprint = ? ORDER BY (worked - failed) DESC').all(fp)
    .find(r => !exclude.has(r.id) && eligible(r));
  if (exact) return { fix: rowToFix(exact), score: 1 };

  const haystack = errorText.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const rows = db.prepare('SELECT * FROM fixes').all().filter(eligible);
  let best = null;
  const near = [];
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    if (r.platform !== 'any' && platform && platform !== 'any' && platform !== 'other' && r.platform !== platform) continue;
    // Hints compare against the fix's cause too, so a paraphrased error can still surface the right neighbour.
    near.push({ fix: rowToFix(r), score: Math.max(similarity(errorText.slice(0, 1200), r.signature), similarity(errorText.slice(0, 1200), `${r.title} ${r.cause}`)) });
    let score = Math.max(similarity(signature, r.signature), similarity(errorText.slice(0, 800), r.signature) * 0.95);
    // match_rules is either a plain list of phrase groups (old format) or { groups, not }.
    const parsed = parse(r.match_rules, []);
    const groups = Array.isArray(parsed) ? parsed : (parsed.groups || []);
    const not = Array.isArray(parsed) ? [] : (parsed.not || []);
    if (groups.some(group => group.every(p => haystack.includes(p)))) score = Math.max(score, 0.95);
    // A broad fix must not answer an error that names a more specific problem.
    if (not.some(group => group.every(p => haystack.includes(p)))) score = Math.min(score, 0.3);
    if (r.worked + r.failed > 0) score += Math.min(0.05, (r.worked - r.failed) * 0.01);
    if (r.failed > r.worked + 1) score -= 0.15;
    if (!best || score > best.score) best = { fix: r, score };
  }
  near.sort((a, b) => b.score - a.score);
  if (best && best.score >= threshold) return { fix: rowToFix(best.fix), score: best.score, considered: rows.length };
  return { fix: null, score: best ? best.score : 0, title: best ? best.fix.title : null, considered: rows.length, near };
}

// A refined answer replaces the one it improves on. The old attempt is kept for the
// record but never counts as a vote or as an attempt.
function supersede(attemptId) {
  db.prepare("UPDATE attempts SET vote = 'superseded' WHERE id = ? AND vote IS NULL").run(attemptId);
}

function saveAiFix({ signature, platform, title, cause, evidence, fix_prompt, verify_steps, rollback, confidence }) {
  const info = db.prepare(`INSERT INTO fixes
    (fingerprint, signature, platform, title, cause, evidence, fix_prompt, verify_steps, rollback, confidence, source)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'ai')`)
    .run(fingerprint(signature, platform), signature, platform, title, cause, j(evidence), fix_prompt, verify_steps, rollback, confidence || 'medium');
  return getFix(Number(info.lastInsertRowid));
}

function getFix(id) {
  return rowToFix(db.prepare('SELECT * FROM fixes WHERE id = ?').get(id));
}

function ensureSession(sessionId, userId) {
  db.prepare('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)').run(sessionId, userId);
}

function sessionAttempts(sessionId) {
  return db.prepare('SELECT * FROM attempts WHERE session_id = ? ORDER BY attempt').all(sessionId);
}

function logAttempt({ sessionId, userId, fixId, attempt, servedFrom, model, tokensSaved, tokensIn, tokensOut }) {
  const info = db.prepare(`INSERT INTO attempts (session_id, user_id, fix_id, attempt, served_from, model, est_tokens_saved, tokens_in, tokens_out)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(sessionId, userId, fixId, attempt, servedFrom, model || null, tokensSaved || 0, tokensIn || 0, tokensOut || 0);
  return Number(info.lastInsertRowid);
}

function recordVote(attemptId, userId, vote) {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!a || a.user_id !== userId) return { error: 'not_found' };
  if (a.vote) return { error: 'already_voted', vote: a.vote };
  db.prepare("UPDATE attempts SET vote = ?, voted_at = datetime('now') WHERE id = ?").run(vote, attemptId);
  if (a.fix_id && !a.user_id.startsWith('sample_')) {
    const col = vote === 'worked' ? 'worked' : 'failed';
    db.prepare(`UPDATE fixes SET ${col} = ${col} + 1 WHERE id = ?`).run(a.fix_id);
  }
  return { ok: true, fix: a.fix_id ? getFix(a.fix_id) : null };
}

function stats() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const fixes = one('SELECT COUNT(*) AS n FROM fixes').n;
  const community = one("SELECT COUNT(*) AS n FROM fixes WHERE worked >= 1").n;
  // Sample runs (user ids starting "sample_") are never counted as real usage.
  const real = "user_id NOT LIKE 'sample\\_%' ESCAPE '\\' AND (vote IS NULL OR vote != 'superseded')";
  const totalAttempts = one(`SELECT COUNT(*) AS n FROM attempts WHERE ${real}`).n;
  const fromLibrary = one(`SELECT COUNT(*) AS n FROM attempts WHERE served_from = 'library' AND ${real}`).n;
  const fromAi = one(`SELECT COUNT(*) AS n FROM attempts WHERE served_from = 'ai' AND ${real}`).n;
  const worked = one(`SELECT COUNT(*) AS n FROM attempts WHERE vote = 'worked' AND ${real}`).n;
  const failed = one(`SELECT COUNT(*) AS n FROM attempts WHERE vote = 'failed' AND ${real}`).n;
  // Anonymous browser ids are self-made and can be scripted, so people = signed-up accounts only.
  let users = 0;
  try { users = one('SELECT COUNT(*) AS n FROM users').n; } catch { users = 0; }
  const completedUsers = one(`SELECT COUNT(DISTINCT user_id) AS n FROM attempts WHERE vote IS NOT NULL AND ${real}`).n;
  const guess = one(`SELECT COALESCE(SUM(est_tokens_saved),0) AS n FROM attempts WHERE ${real}`).n;
  // Tokens actually billed by providers. Includes re-checked answers, which still cost tokens.
  const sample = "user_id NOT LIKE 'sample\\_%' ESCAPE '\\'";
  const spent = one(`SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS n, COUNT(CASE WHEN tokens_in > 0 THEN 1 END) AS calls FROM attempts WHERE served_from = 'ai' AND ${sample}`);
  // With at least 3 measured AI calls, each library answer is credited with the measured
  // average cost of an AI call. Before that it falls back to a rough character-count guess.
  const measured = spent.calls >= 3;
  const saved = measured ? Math.round((spent.n / spent.calls) * fromLibrary) : guess;
  const voted = worked + failed;
  return {
    fixesInLibrary: fixes,
    fixesConfirmedByUsers: community,
    totalAnswers: totalAttempts,
    servedFromLibrary: fromLibrary,
    servedByAi: fromAi,
    libraryHitRate: totalAttempts ? Math.round((fromLibrary / totalAttempts) * 100) : 0,
    votesWorked: worked,
    votesFailed: failed,
    workedRate: voted ? Math.round((worked / voted) * 100) : null,
    uniqueUsers: users,
    usersWhoCompletedFlow: completedUsers,
    estTokensSaved: saved,
    savedBasis: measured ? 'measured average per AI call' : 'rough estimate',
    aiTokensUsed: spent.n,
    aiCallsMeasured: spent.calls,
    avgTokensPerAiCall: spent.calls ? Math.round(spent.n / spent.calls) : null,
  };
}

module.exports = { db, supersede, seedIfEmpty, findFix, saveAiFix, getFix, ensureSession, sessionAttempts, logAttempt, recordVote, stats };
