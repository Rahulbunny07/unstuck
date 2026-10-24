const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT = '3f2a9c1e-5b7d-4e8a-9c3f-1a2b3c4d5e6f';
process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-agent-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.ALLOW_LOCAL_MCP = '1';
delete process.env.ANTHROPIC_API_KEY;

const ANSWER = {
  title: 'Use the browser env object', cause: 'process is a Node-only global and does not exist in the browser build.',
  evidence: ['ReferenceError: process is not defined'],
  fix_prompt: 'Replace process.env in src/config.ts with import.meta.env and prefix the variable with VITE_. Change nothing else.',
  verify_steps: 'Publish again and open the site.', rollback: 'Restore the previous version in history.', confidence: 'high', need_more: null,
};

let mode = 'ok';
const seen = [];
let agentSrv;
test.before(async () => {
  agentSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Bearer agent-key-12345678') { res.writeHead(401); return res.end('{}'); }
      if (req.url !== `/api/v1/agents/${AGENT}/run`) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.inputs.task.startsWith('Reply with the word ok')) return res.end(JSON.stringify({ status: 'completed', output: 'ok' }));
      if (mode === 'hitl') return res.end(JSON.stringify({ status: 'hitl_triggered' }));
      if (mode === 'wrapped') return res.end(JSON.stringify({ status: 'completed', confidence: 0.9, output: { response: JSON.stringify(ANSWER) } }));
      res.end(JSON.stringify({ status: 'completed', confidence: 0.9, output: JSON.stringify(ANSWER) }));
    });
  });
  await new Promise(r => { agentSrv.listen(0, '127.0.0.1', r); });
  process.env.AGENTICORG_BASE_URL = `http://127.0.0.1:${agentSrv.address().port}`;
});
test.after(() => agentSrv.close());

test('AgenticOrg agent is called with the right route, auth and body, and its answer is parsed', async () => {
  const { askModel } = require('../lib/ai');
  const r = await askModel('x', { tool: 'lovable', platform: 'other', error: 'ReferenceError: process is not defined' }, { provider: 'agenticorg', key: 'agent-key-12345678', model: AGENT });
  assert.strictEqual(r.fix.title, 'Use the browser env object');
  const call = seen.filter(s => !s.body.inputs.task.startsWith('Reply')).pop();
  assert.strictEqual(call.url, `/api/v1/agents/${AGENT}/run`);
  assert.strictEqual(call.auth, 'Bearer agent-key-12345678');
  assert.strictEqual(call.body.action, 'process');
  assert.ok(call.body.inputs.task.includes('ReferenceError: process is not defined'));
  assert.ok(call.body.inputs.task.includes('<user_data'));
});

test('an answer nested inside another output field is still found', async () => {
  mode = 'wrapped';
  const { askModel } = require('../lib/ai');
  const r = await askModel('x', { tool: 'bolt', platform: 'other', error: 'something broke here' }, { provider: 'agenticorg', key: 'agent-key-12345678', model: AGENT });
  assert.strictEqual(r.fix.confidence, 'high');
  mode = 'ok';
});

test('approval waits, bad keys and unknown agents map to clear errors', async () => {
  const { askModel } = require('../lib/ai');
  mode = 'hitl';
  await assert.rejects(() => askModel('x', { error: 'e e e e e e e e' }, { provider: 'agenticorg', key: 'agent-key-12345678', model: AGENT }), e => e.code === 'AGENT_WAIT');
  mode = 'ok';
  await assert.rejects(() => askModel('x', { error: 'e e e e e e e e' }, { provider: 'agenticorg', key: 'bad-key-0000000000', model: AGENT }), e => e.code === 'BAD_KEY');
  await assert.rejects(() => askModel('x', { error: 'e e e e e e e e' }, { provider: 'agenticorg', key: 'agent-key-12345678', model: '00000000-0000-0000-0000-000000000000' }), e => e.code === 'BAD_AGENT');
});

test('saving an AgenticOrg key checks the agent, and a full diagnosis runs through it', async () => {
  const app = require('../server');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body, cookie) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const u = await call('/api/auth/signup', { email: 'agent@example.com', password: 'agent-password-1' });
    assert.strictEqual((await call('/api/keys', { provider: 'agenticorg', model: 'not-a-uuid', key: 'agent-key-12345678' }, u.cookie)).status, 400);
    assert.match((await call('/api/keys', { provider: 'agenticorg', model: AGENT, key: 'wrong-key-00000000' }, u.cookie)).body.error, /rejected/);
    const ok = await call('/api/keys', { provider: 'agenticorg', model: AGENT, key: 'agent-key-12345678', label: 'Pine' }, u.cookie);
    assert.strictEqual(ok.status, 200);
    assert.ok(!JSON.stringify(ok.body).includes('agent-key'));
    const fix = await call('/api/fix', { tool: 'lovable', platform: 'other', userId: 'user_agnt_000001', sessionId: 'sess_agnt_000001', error: 'Uncaught ReferenceError: process is not defined at src/config.ts:3' }, u.cookie);
    assert.strictEqual(fix.status, 200);
    assert.strictEqual(fix.body.source, 'ai');
    assert.strictEqual(fix.body.usedOwnKey, true);
  } finally { server.close(); }
});
