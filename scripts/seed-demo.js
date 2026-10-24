// Local demo data: two accounts (a team owner and a member), a demo team and one approved record.
// Run with `npm run seed:demo`. Passwords are random and written to data/demo-accounts.txt, which
// git ignores. Refuses to run in production so demo logins can never exist on a live site.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to create demo accounts in production.'); process.exit(1); }

const auth = require('../lib/auth');
const org = require('../lib/org');
const { db } = require('../lib/db');

const accounts = [
  { email: 'demo-owner@example.test', name: 'Demo Owner' },
  { email: 'demo-member@example.test', name: 'Demo Member' },
];

(async () => {
  const lines = [];
  const ids = {};
  for (const a of accounts) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(a.email);
    if (existing) { ids[a.email] = existing.id; lines.push(`${a.email}  (already existed: use the password from when it was created)`); continue; }
    const password = crypto.randomBytes(9).toString('base64url');
    const u = await auth.createUser({ email: a.email, password, name: a.name });
    ids[a.email] = u.id;
    lines.push(`${a.email}  password: ${password}`);
  }
  const owner = ids['demo-owner@example.test'];
  const member = ids['demo-member@example.test'];
  let team = org.membership(owner);
  if (!team) team = org.createOrg(owner, 'Demo Platform Team').team;
  if (!org.membership(member)) org.joinOrg(member, team.join_code);
  if (!org.listRecords(owner).records.length) {
    org.addRecord(owner, {
      title: 'JSON functions fail on the old SQLite build',
      signature: 'SqliteError: no such function: json_extract',
      environment: 'SQLite older than 3.38 without the JSON extension',
      cause: 'The deployed SQLite build has no JSON functions.',
      resolution: 'Upgrade SQLite or compile it with the JSON extension, then retest.',
      verification: "SELECT json_valid('{}'); returns 1.",
    });
  }
  const file = path.join(__dirname, '..', 'data', 'demo-accounts.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['Unstuck demo accounts (local only, never use on a live site)', '', ...lines, '', `Team: ${team.name}   join code: ${team.join_code}`, 'Try: sign in as the member, then paste on the home page:', '  SqliteError: no such function: json_extract at db.query', ''].join('\n'), { mode: 0o600 });
  console.log('Demo accounts ready. Passwords are in', file);
})();
