// Time-based one-time passwords (RFC 6238), compatible with Google Authenticator,
// Microsoft Authenticator, 1Password, Authy, etc. No external service needed.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

const STEP = 30;
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// Accepts the code for the previous, current or next 30-second window (clock drift).
// Returns the matched step, or null. Steps <= lastStep are rejected so a code can't be reused.
function verify(secretB32, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const s = currentStep(now);
  for (const d of [0, -1, 1]) {
    const step = s + d;
    if (step <= lastStep) continue;
    const a = Buffer.from(hotp(secretB32, step)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

// Secrets are stored encrypted with a key derived from SESSION_SECRET.
const key = () => crypto.createHash('sha256').update(`teamdrive-totp:${process.env.SESSION_SECRET}`).digest();
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { hotp, verify, newSecret, currentStep, seal, open, base32Encode, base32Decode };
