const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `unstuck-team-${Date.now()}.db`);
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 37).toString('base64');
delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENTICORG_API_KEY; delete process.env.GROQ_API_KEY;
const app = require('../server');
let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const call = async (p, method, body, cookie) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};
const signup = async email => ({ cookie: (await call('/api/auth/signup', 'POST', { email, password: 'team-password-1' })).cookie });
let n = 0;
const fix = (u, error) => call('/api/fix', 'POST', { tool: 'other', platform: 'other', error, userId: 'user_team_' + String(++n).padStart(6, '0'), sessionId: 'sess_team_' + String(n).padStart(6, '0') }, u && u.cookie);

const REC = { title: 'JSON functions fail on the old SQLite build', signature: 'SqliteError: no such function: json_extract at db.query', environment: 'SQLite older than 3.38 without the JSON extension', cause: 'The deployed SQLite build has no JSON functions.', resolution: 'Upgrade SQLite or compile it with the JSON extension, then retest.', verification: 'SELECT json_valid(\'{}\') returns 1.' };

test('teams need sign-in; owner and members get the right powers', async () => {
  assert.strictEqual((await call('/api/team', 'GET')).status, 401);
  const owner = await signup('owner@example.com');
  const member = await signup('member@example.com');
  const outsider = await signup('outsider@example.com');
  assert.strictEqual((await call('/api/team', 'POST', { name: 'x' }, owner.cookie)).status, 400);
  const made = await call('/api/team', 'POST', { name: 'Platform team' }, owner.cookie);
  assert.strictEqual(made.status, 200);
  assert.strictEqual((await call('/api/team', 'POST', { name: 'Second team' }, owner.cookie)).status, 400);
  const code = made.body.team.join_code;
  assert.strictEqual((await call('/api/team/join', 'POST', { code: 'WRONGCODE1' }, member.cookie)).status, 400);
  assert.strictEqual((await call('/api/team/join', 'POST', { code: code.toLowerCase() }, member.cookie)).status, 200);

  // A member's record waits; the owner's is approved at once; the outsider sees nothing.
  assert.strictEqual((await call('/api/team/records', 'POST', { title: 'x' }, member.cookie)).status, 400);
  const mine = await call('/api/team/records', 'POST', REC, member.cookie);
  assert.strictEqual(mine.body.status, 'PENDING');
  assert.strictEqual((await call(`/api/team/records/${mine.body.id}/approve`, 'POST', {}, member.cookie)).status, 403);
  assert.strictEqual((await call('/api/team/records', 'POST', REC, outsider.cookie)).status, 404);
  assert.strictEqual((await call('/api/team', 'GET', null, outsider.cookie)).body.records.length, 0);
  const asOwner = (await call('/api/team', 'GET', null, owner.cookie)).body.records;
  assert.strictEqual(asOwner.length, 1);

  // Pending records are not used for answers yet.
  const err = 'Error: SqliteError: no such function: json_extract at db.query (service.js:41)';
  assert.notStrictEqual((await fix(member, err)).body.source, 'team');
  assert.strictEqual((await call(`/api/team/records/${mine.body.id}/approve`, 'POST', {}, owner.cookie)).status, 200);
  assert.strictEqual((await call(`/api/team/records/${mine.body.id}/approve`, 'POST', {}, owner.cookie)).status, 400);

  // Now a teammate gets the team's record first, with its environment, and no AI.
  const hit = await fix(member, err);
  assert.strictEqual(hit.status, 200);
  assert.strictEqual(hit.body.source, 'team');
  assert.strictEqual(hit.body.fix.badge.kind, 'team');
  assert.match(hit.body.fix.env_note, /SQLite older than 3\.38/);
  assert.match(hit.body.fix.fix_prompt, /Upgrade SQLite/);

  // The outsider and signed-out visitors never see the team's record.
  assert.notStrictEqual((await fix(outsider, err)).body.source, 'team');
  assert.notStrictEqual((await fix(null, err)).body.source, 'team');
  // An unrelated error does not match.
  assert.notStrictEqual((await fix(member, 'TypeError: Cannot read properties of undefined (reading map)')).body.source, 'team');
});

test('a rejected record is never used', async () => {
  const owner = await signup('owner2@example.com');
  await call('/api/team', 'POST', { name: 'Second company' }, owner.cookie);
  const member = await signup('member2@example.com');
  const team = (await call('/api/team', 'GET', null, owner.cookie)).body.team;
  await call('/api/team/join', 'POST', { code: team.join_code }, member.cookie);
  const rec = await call('/api/team/records', 'POST', { ...REC, signature: 'Totally different error text about flux capacitors failing' }, member.cookie);
  assert.strictEqual((await call(`/api/team/records/${rec.body.id}/reject`, 'POST', {}, owner.cookie)).status, 200);
  assert.notStrictEqual((await fix(member, 'Totally different error text about flux capacitors failing')).body.source, 'team');
});
