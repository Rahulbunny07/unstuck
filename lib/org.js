const crypto = require('crypto');
const { db } = require('./db');
const { similarity } = require('./clean');

// A team workspace. Members add what they learned fixing a problem; the owner approves it; later
// matching errors are answered from that record first, with the recorded environment shown so the
// reader checks the same cause applies. One team per person keeps this simple.
db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS org_members (
    user_id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS org_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, created_by INTEGER NOT NULL,
    title TEXT NOT NULL, signature TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '',
    cause TEXT NOT NULL, resolution TEXT NOT NULL, verification TEXT NOT NULL DEFAULT '',
    rollback TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_orgrec_org ON org_records(org_id, status);
`);

const clip = (v, n) => String(v || '').trim().slice(0, n);
const code = () => crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 characters

const membership = userId => db.prepare(`SELECT m.org_id, m.role, o.name, o.join_code FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?`).get(userId) || null;

function createOrg(userId, name) {
  const n = clip(name, 60);
  if (n.length < 2) return { error: 'name' };
  if (membership(userId)) return { error: 'already' };
  const info = db.prepare('INSERT INTO orgs (name, join_code) VALUES (?,?)').run(n, code());
  db.prepare("INSERT INTO org_members (user_id, org_id, role) VALUES (?,?, 'owner')").run(userId, Number(info.lastInsertRowid));
  return { team: membership(userId) };
}

function joinOrg(userId, joinCode) {
  if (membership(userId)) return { error: 'already' };
  const o = db.prepare('SELECT id FROM orgs WHERE join_code = ?').get(clip(joinCode, 20).toUpperCase());
  if (!o) return { error: 'code' };
  db.prepare("INSERT INTO org_members (user_id, org_id, role) VALUES (?,?, 'member')").run(userId, o.id);
  return { team: membership(userId) };
}

function addRecord(userId, d) {
  const m = membership(userId);
  if (!m) return { error: 'noteam' };
  const rec = { title: clip(d.title, 120), signature: clip(d.signature, 600), environment: clip(d.environment, 300), cause: clip(d.cause, 800), resolution: clip(d.resolution, 1200), verification: clip(d.verification, 600), rollback: clip(d.rollback, 600) };
  if (!rec.title || rec.signature.length < 8 || !rec.cause || !rec.resolution) return { error: 'fields' };
  // The owner's own records are approved at once; everyone else's wait for the owner.
  const status = m.role === 'owner' ? 'APPROVED' : 'PENDING';
  const info = db.prepare(`INSERT INTO org_records (org_id, created_by, title, signature, environment, cause, resolution, verification, rollback, status, reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, ${status === 'APPROVED' ? "datetime('now')" : 'NULL'})`)
    .run(m.org_id, userId, rec.title, rec.signature, rec.environment, rec.cause, rec.resolution, rec.verification, rec.rollback, status);
  return { id: Number(info.lastInsertRowid), status };
}

function listRecords(userId) {
  const m = membership(userId);
  if (!m) return null;
  const rows = db.prepare(`SELECT r.id, r.title, r.signature, r.environment, r.cause, r.resolution, r.verification, r.rollback, r.status, r.created_at, r.created_by = ? AS mine
    FROM org_records r WHERE r.org_id = ? AND (r.status = 'APPROVED' OR r.created_by = ? OR ? = 'owner') ORDER BY r.id DESC LIMIT 100`).all(userId, m.org_id, userId, m.role);
  return { team: m, records: rows };
}

function decide(userId, recordId, approve) {
  const m = membership(userId);
  if (!m || m.role !== 'owner') return { error: 'owner' };
  const r = db.prepare("UPDATE org_records SET status = ?, reviewed_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'PENDING'")
    .run(approve ? 'APPROVED' : 'REJECTED', recordId, m.org_id);
  return r.changes ? { ok: true } : { error: 'missing' };
}

// The best APPROVED record of this person's team for an error, or null. Only a strong match counts:
// a similar-looking message is not proof of the same cause, so the answer always shows the environment.
function match(userId, errorText) {
  const m = membership(userId);
  if (!m) return null;
  const rows = db.prepare("SELECT * FROM org_records WHERE org_id = ? AND status = 'APPROVED'").all(m.org_id);
  let best = null;
  for (const r of rows) {
    const s = Math.max(similarity(errorText.slice(0, 800), r.signature), similarity(errorText.slice(0, 300), r.signature));
    if (s >= 0.7 && (!best || s > best.score)) best = { record: r, score: s, teamName: m.name };
  }
  return best;
}

module.exports = { membership, createOrg, joinOrg, addRecord, listRecords, decide, match };
