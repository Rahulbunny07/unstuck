const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encrypts user-supplied secrets (their API keys, MCP tokens) at rest with AES-256-GCM.
// Production must set ENCRYPTION_KEY (32 random bytes, base64). In development a key
// file is generated under data/ so the app runs without setup.
function loadKey() {
  const env = process.env.ENCRYPTION_KEY;
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    return buf;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is required in production');
  const file = path.join(__dirname, '..', 'data', '.dev-enc-key');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

let KEY;
const key = () => (KEY ||= loadKey());

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, ct] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
