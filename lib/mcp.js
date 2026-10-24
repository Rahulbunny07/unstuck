const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;
const PROTOCOL = '2025-03-26';

// Suggested servers. The URL is a starting point: confirm it in the provider's own docs.
const CATALOG = [
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', hint: 'Database, auth and logs. Use a Supabase access token.' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', hint: 'Deployments and build logs.' },
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', hint: 'Repos, issues and commits. Use a GitHub token.' },
  { id: 'custom', name: 'Custom server', url: '', hint: 'Any remote MCP server that speaks Streamable HTTP.' },
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
  }
  return false;
}

// Users supply these URLs, so the server must never be tricked into calling
// internal addresses (SSRF). https only, no credentials in the URL, and every
// resolved address must be public. DNS can change between this check and the
// request, so deployments should also block private ranges at the network layer.
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('That is not a valid URL.'); }
  const allowLocal = process.env.ALLOW_LOCAL_MCP === '1' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:')) throw new Error('Use an https:// URL.');
  if (u.username || u.password) throw new Error('Do not put credentials in the URL.');
  if (allowLocal) return u;
  if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) throw new Error('That address is not allowed.');
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new Error('Could not find that server.'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That address is not allowed.');
  return u;
}

async function readCapped(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('The server sent too much data.');
  return buf.toString('utf8');
}

function parseBody(text, contentType, id) {
  if (contentType.includes('text/event-stream')) {
    let found = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === id) found = msg;
      } catch { /* skip non-JSON events */ }
    }
    if (!found) throw new Error('The server gave no answer.');
    return found;
  }
  return JSON.parse(text);
}

async function rpc(url, token, sessionId, message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new Error('The server tried to redirect, which is not allowed.');
    if (res.status === 401 || res.status === 403) throw new Error('The server rejected the token. Check it and try again.');
    if (!res.ok && res.status !== 202) throw new Error(`The server answered with status ${res.status}.`);
    const sid = res.headers.get('mcp-session-id') || sessionId;
    if (message.id === undefined) { await res.arrayBuffer().catch(() => {}); return { sid }; }
    const text = await readCapped(res);
    const body = parseBody(text, res.headers.get('content-type') || '', message.id);
    if (body.error) throw new Error(String(body.error.message || 'The server returned an error.').slice(0, 200));
    return { sid, result: body.result };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long to answer.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Performs the MCP handshake and lists the tools. Does not call any tool.
async function inspect(rawUrl, token) {
  const u = await assertSafeUrl(rawUrl);
  const url = u.toString();
  const init = await rpc(url, token, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'unstuck', version: '1.0.0' } },
  });
  await rpc(url, token, init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = [];
  let cursor;
  for (let page = 0; page < 3; page++) {
    const r = await rpc(url, token, init.sid, { jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} });
    for (const t of (r.result && r.result.tools) || []) {
      tools.push({
        name: String(t.name).slice(0, 80),
        description: String(t.description || '').slice(0, 200),
        readOnly: Boolean(t.annotations && t.annotations.readOnlyHint === true),
      });
    }
    cursor = r.result && r.result.nextCursor;
    if (!cursor) break;
  }
  const info = (init.result && init.result.serverInfo) || {};
  return { server: { name: String(info.name || '').slice(0, 80), version: String(info.version || '').slice(0, 40) }, tools: tools.slice(0, 100) };
}

module.exports = { CATALOG, inspect, assertSafeUrl, isPrivateIp };
