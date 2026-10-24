const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL,
    last4 TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    catalog_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    token TEXT,
    server_info TEXT NOT NULL DEFAULT '{}',
    tools TEXT NOT NULL DEFAULT '[]',
    enabled_tools TEXT NOT NULL DEFAULT '[]',
    last_checked TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id);
`);

// Older databases lack these columns; adding them is a no-op once present.
for (const col of ['base_url', 'model']) {
  try { db.exec(`ALTER TABLE api_keys ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
}

const PROVIDERS = ['anthropic', 'openai', 'groq', 'custom', 'agenticorg'];
const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

function keyView(r) {
  return { id: r.id, provider: r.provider, label: r.label, last4: r.last4, baseUrl: r.base_url || null, model: r.model || null, isDefault: Boolean(r.is_default), createdAt: r.created_at };
}

function listKeys(userId) {
  return db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id').all(userId).map(keyView);
}

function addKey(userId, { provider, label, key, baseUrl, model }) {
  const hasAny = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(userId).n;
  const info = db.prepare('INSERT INTO api_keys (user_id, provider, label, secret, last4, base_url, model, is_default) VALUES (?,?,?,?,?,?,?,?)')
    .run(userId, provider, String(label || '').slice(0, 40), encrypt(key), key.slice(-4), baseUrl || null, model || null, hasAny ? 0 : 1);
  return keyView(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function setDefaultKey(userId, id) {
  const row = db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  db.prepare('UPDATE api_keys SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE api_keys SET is_default = 1 WHERE id = ?').run(id);
  return true;
}

function deleteKey(userId, id) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  if (row.is_default) {
    const next = db.prepare('SELECT id FROM api_keys WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
    if (next) db.prepare('UPDATE api_keys SET is_default = 1 WHERE id = ?').run(next.id);
  }
  return true;
}

// Decrypted only inside the server, only to make the user's own AI call.
function defaultKeyFor(userId) {
  const row = db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND is_default = 1').get(userId);
  return row ? { id: row.id, provider: row.provider, key: decrypt(row.secret), baseUrl: row.base_url, model: row.model } : null;
}

function mcpView(r) {
  return {
    id: r.id, catalogId: r.catalog_id, name: r.name, url: r.url, hasToken: Boolean(r.token),
    server: parse(r.server_info, {}), tools: parse(r.tools, []), enabledTools: parse(r.enabled_tools, []), lastChecked: r.last_checked,
  };
}

function listMcp(userId) {
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY id').all(userId).map(mcpView);
}

function addMcp(userId, { catalogId, name, url, token, inspected }) {
  // Only tools the server marks read-only are switched on by default.
  const enabled = inspected.tools.filter(t => t.readOnly).map(t => t.name);
  const info = db.prepare(`INSERT INTO mcp_servers (user_id, catalog_id, name, url, token, server_info, tools, enabled_tools, last_checked)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))`)
    .run(userId, catalogId, name, url, token ? encrypt(token) : null, JSON.stringify(inspected.server), JSON.stringify(inspected.tools), JSON.stringify(enabled));
  return mcpView(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function getMcp(userId, id) {
  const r = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(id, userId);
  return r ? { ...r, tokenPlain: r.token ? decrypt(r.token) : '' } : null;
}

function refreshMcp(userId, id, inspected) {
  const names = new Set(inspected.tools.map(t => t.name));
  const cur = getMcp(userId, id);
  const enabled = parse(cur.enabled_tools, []).filter(n => names.has(n));
  db.prepare("UPDATE mcp_servers SET server_info = ?, tools = ?, enabled_tools = ?, last_checked = datetime('now') WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(inspected.server), JSON.stringify(inspected.tools), JSON.stringify(enabled), id, userId);
  return mcpView(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id));
}

function setMcpTools(userId, id, names) {
  const cur = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(id, userId);
  if (!cur) return null;
  const valid = new Set(parse(cur.tools, []).map(t => t.name));
  const clean = [...new Set(names.filter(n => typeof n === 'string' && valid.has(n)))];
  db.prepare('UPDATE mcp_servers SET enabled_tools = ? WHERE id = ?').run(JSON.stringify(clean), id);
  return mcpView(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id));
}

function deleteMcp(userId, id) {
  return db.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

module.exports = { PROVIDERS, listKeys, addKey, setDefaultKey, deleteKey, defaultKeyFor, listMcp, addMcp, getMcp, refreshMcp, setMcpTools, deleteMcp };
