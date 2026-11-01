const fs = require('fs');
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const QRCode = require('qrcode');
const { pool, q } = require('./db');
const r2 = require('./r2');
const totp = require('./totp');
const legal = require('./legal');
const demo = require('./demo');
const backup = require('./backup');
const portal = require('./portal');
// Show the Equawire marketing page at / for signed-out visitors. Set LANDING_PAGE=0 on clients' private copies.
const LANDING = !['0', 'false', 'no'].includes(String(process.env.LANDING_PAGE ?? '1').toLowerCase());

const app = express();
app.set('trust proxy', 1);
// Search engines: only the public marketing pages may be indexed. Everything else
// (the app, the API, shared-file links, the demo) is marked noindex.
const BASE = (process.env.APP_URL || '').replace(/\/$/, '');
const INDEXABLE = LANDING && !['0', 'false', 'no'].includes(String(process.env.SEARCH_INDEXING ?? '1').toLowerCase());
app.get('/robots.txt', (req, res) => res.type('text/plain').send(INDEXABLE
  ? `User-agent: *\nDisallow: /api/\nDisallow: /s/\nDisallow: /demo\nDisallow: /health\nAllow: /$\nAllow: /terms\nAllow: /privacy\n\nSitemap: ${BASE}/sitemap.xml\n`
  : 'User-agent: *\nDisallow: /\n'));
app.get('/sitemap.xml', (req, res) => {
  if (!INDEXABLE) return res.status(404).end();
  const urls = ['/', '/terms', '/privacy'].map((u) => `<url><loc>${BASE}${u}</loc></url>`).join('');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});
app.use((req, res, next) => {
  const pub = INDEXABLE && ['/', '/terms', '/privacy', '/og-image.png'].includes(req.path);
  if (!pub) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    store: new MySQLStore({}, pool),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 },
  })
);

app.use(demo.guard);

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_MB || 5120) * 1024 * 1024;
const PURGE_DAYS = Number(process.env.PURGE_DAYS || 30);
const ACTIVITY_DAYS = Number(process.env.ACTIVITY_DAYS || 365);
const GB = 1024 ** 3;

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const cleanName = (s) => String(s || '').replace(/[\/\\\0]/g, '').trim().slice(0, 255);
const idOrNull = (v) => (v === null || v === undefined || v === '' || v === 'root' ? null : Number(v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} bytes`);

// ---------- Sessions & roles ----------
// Bump SESSION_V to sign everyone out (2 = two-step login, 3 = teams).
const SESSION_V = 3;
const T = (req) => req.session.user.team_id;
// Files a client uploaded through the portal show the client's name as owner.
const OWNER = portal.ENABLED ? "COALESCE(CONCAT(cc.name, ' (client)'), u.name) AS owner" : 'u.name AS owner';
const OWNER_JOIN = portal.ENABLED ? 'LEFT JOIN client_contacts cc ON cc.id=f.contact_id' : ''; // every data query is limited to the signed-in user's team

const auth = wrap(async (req, res, next) => {
  const u = req.session.user;
  if (!u || u.v !== SESSION_V) return res.status(401).json({ error: 'Not signed in' });
  const [t] = await q('SELECT disabled FROM teams WHERE id=?', [u.team_id]);
  if (!t || t.disabled) return req.session.destroy(() => res.status(401).json({ error: 'Not signed in' }));
  // Accounts that must use two-step login can only reach the setup screens until it's on.
  if (u.must_change_password && !['/api/me', '/api/me/password'].includes(req.path))
    return res.status(403).json({ error: 'Choose a new password first', change_password: true });
  if (u.must_setup_2fa && !req.path.startsWith('/api/2fa/') && req.path !== '/api/me')
    return res.status(403).json({ error: 'Set up two-step login first', setup2fa: true });
  next();
});
const admin = (req, res, next) => (req.session.user?.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));
const owner = (req, res, next) => (req.session.user?.is_owner ? next() : res.status(403).json({ error: 'Owner only' }));

// ---------- Rate limiting (in memory) ----------
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
const tooMany = (key, max) => { const r = fails.get(key); return !!r && r.reset > Date.now() && r.count >= max; };
function addFail(key) {
  const r = fails.get(key);
  if (!r || r.reset < Date.now()) fails.set(key, { count: 1, reset: Date.now() + WINDOW });
  else r.count++;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of fails) if (r.reset < now) fails.delete(k); }, WINDOW).unref();

// ---------- Activity log ----------
// "Chrome on Mac", "Safari on iPhone"... worked out locally from the browser's user agent.
function deviceOf(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return b && o ? `${b} on ${o}` : b || o || null;
}
// log(req, action, { type, id, name }, detail, { teamId, userId }) — never throws.
async function log(req, action, target = {}, detail = '', who = {}) {
  try {
    const u = req.session?.user;
    const teamId = who.teamId ?? u?.team_id;
    if (!teamId) return;
    await q('INSERT INTO activity_log (team_id, user_id, action, target_type, target_id, target_name, detail, ip, device) VALUES (?,?,?,?,?,?,?,?,?)',
      [teamId, who.userId !== undefined ? who.userId : u?.id ?? null, action, target.type || null, target.id || null,
        target.name ? String(target.name).slice(0, 255) : null, detail ? String(detail).slice(0, 500) : null,
        u?.is_demo ? null : String(req.ip || '').slice(0, 64), // demo visitors can see the log, so never store their IPs
        u?.is_demo ? null : deviceOf(req.headers['user-agent'])]);
  } catch (e) { console.error('activity log failed:', e.message); }
}

// ---------- Access control ----------
// Folders are open to the whole team unless restricted. A restricted folder (and
// everything inside it) is visible only to admins, its creator, and listed members.
async function loadAcl(user) {
  const folders = await q('SELECT id, parent_id, name, restricted, created_by, deleted_at FROM folders WHERE team_id=?', [user.team_id]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const granted = new Set((await q('SELECT folder_id FROM folder_access WHERE user_id=?', [user.id])).map((r) => r.folder_id));
  const memo = new Map();
  const can = (id) => {
    if (id === null || id === undefined) return true;
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    let ok;
    if (!f) ok = false;
    else if (!user.is_admin && f.restricted && f.created_by !== user.id && !granted.has(f.id)) ok = false;
    else ok = can(f.parent_id);
    memo.set(id, ok);
    return ok;
  };
  const alive = (id) => {
    for (let c = id; c !== null && c !== undefined; ) {
      const f = byId.get(c);
      if (!f || f.deleted_at) return false;
      c = f.parent_id;
    }
    return true;
  };
  const visible = (id) => can(id) && alive(id);
  const canManage = (id) => { const f = byId.get(id); return !!f && (user.is_admin || f.created_by === user.id); };
  const pathOf = (id) => { const p = []; for (let c = id; c != null; ) { const f = byId.get(c); if (!f) break; p.unshift(f.name); c = f.parent_id; } return p.join(' / ') || 'top level'; };
  return { byId, can, alive, visible, canManage, pathOf };
}
async function getFile(req, id, extra = "deleted_at IS NULL AND status='ready'") {
  const [f] = await q(`SELECT * FROM files WHERE id=? AND team_id=? AND ${extra}`, [id, T(req)]);
  if (!f) throw httpErr(404, 'File not found');
  const acl = await loadAcl(req.session.user);
  if (!acl.can(f.folder_id) || (extra.includes('deleted_at IS NULL') && !acl.alive(f.folder_id))) throw httpErr(404, 'File not found');
  return f;
}
async function requireFolder(req, id) {
  const acl = await loadAcl(req.session.user);
  if (id !== null && !acl.visible(id)) throw httpErr(404, 'Folder not found');
  return acl;
}
async function teamUsage(teamId) {
  const [r] = await q(`SELECT
    (SELECT COALESCE(SUM(size),0) FROM files WHERE team_id=? AND status='ready') +
    (SELECT COALESCE(SUM(v.size),0) FROM file_versions v JOIN files f ON f.id=v.file_id WHERE f.team_id=?) AS used,
    (SELECT COUNT(*) FROM files WHERE team_id=? AND status='ready') AS files`, [teamId, teamId, teamId]);
  return { used: Number(r.used), files: Number(r.files) };
}

// ---------- Two-step login helpers ----------
// REQUIRE_2FA: "admins" (default) | "all" | "none"
const POLICY = String(process.env.REQUIRE_2FA || 'admins').toLowerCase();
const requires2fa = (u) => POLICY === 'all' || (POLICY === 'admins' && !!u.is_admin);
const TRUST_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};
const USER_SQL = 'SELECT u.*, t.name AS team_name, t.disabled AS team_disabled FROM users u JOIN teams t ON t.id=u.team_id';
const sessionUser = (u) => ({ v: SESSION_V, id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin, is_owner: !!u.is_owner, is_demo: !!u.is_demo,
  team_id: u.team_id, team_name: u.team_name, must_change_password: !!u.must_change_password && !u.is_demo,
  must_setup_2fa: requires2fa(u) && !u.totp_enabled && !u.is_demo });
// remember=true keeps you signed in for 30 days; otherwise until the browser is closed.
const REMEMBER_DAYS = 30;
function startSession(req, res, u, remember) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    req.session.cookie.maxAge = remember ? REMEMBER_DAYS * 864e5 : null;
    req.session.user = sessionUser(u);
    log(req, 'login');
    res.json(req.session.user);
  });
}
async function isTrustedDevice(req, userId) {
  const t = cookieOf(req, 'td_trust');
  if (!t) return false;
  const [row] = await q('SELECT id FROM trusted_devices WHERE user_id=? AND token_hash=? AND expires_at > NOW()', [userId, sha(t)]);
  return !!row;
}
async function trustDevice(res, userId) {
  const t = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO trusted_devices (user_id, token_hash, expires_at) VALUES (?,?, NOW() + INTERVAL ? DAY)', [userId, sha(t), TRUST_DAYS]);
  res.cookie('td_trust', t, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: TRUST_DAYS * 864e5 });
}
// Accepts a 6-digit authenticator code or an unused backup code.
async function checkSecondFactor(u, raw) {
  const code = String(raw || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^\d{6}$/.test(code)) {
    if (!u.totp_secret) return false;
    const step = totp.verify(totp.open(u.totp_secret), code, Number(u.totp_last_step || 0));
    if (step === null) return false;
    await q('UPDATE users SET totp_last_step=? WHERE id=?', [step, u.id]);
    return true;
  }
  if (!/^[a-z2-7]{8}$/.test(code)) return false;
  const r = await q('UPDATE backup_codes SET used_at=NOW() WHERE user_id=? AND code_hash=? AND used_at IS NULL', [u.id, sha(code)]);
  return r.affectedRows === 1;
}
async function newBackupCodes(userId) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const codes = Array.from({ length: 10 }, () => [...crypto.randomBytes(8)].map((b) => alphabet[b & 31]).join(''));
  await q('DELETE FROM backup_codes WHERE user_id=?', [userId]);
  await q('INSERT INTO backup_codes (user_id, code_hash) VALUES ?', [codes.map((c) => [userId, sha(c)])]);
  return codes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
}
async function clear2fa(userId) {
  await q('UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_last_step=0 WHERE id=?', [userId]);
  await q('DELETE FROM backup_codes WHERE user_id=?', [userId]);
  await q('DELETE FROM trusted_devices WHERE user_id=?', [userId]);
}
async function checkPassword(userId, password) {
  const [u] = await q('SELECT password_hash FROM users WHERE id=?', [userId]);
  return !!u && bcrypt.compare(String(password || ''), u.password_hash);
}
async function teamMember(req, id) {
  const [u] = await q('SELECT id, name, email, is_admin FROM users WHERE id=? AND team_id=?', [id, T(req)]);
  if (!u) throw httpErr(404, 'Member not found');
  return u;
}

// ---------- Auth ----------
app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const ipKey = `ip:${req.ip}`, userKey = `u:${req.ip}:${email}`;
  if (tooMany(ipKey, 20) || tooMany(userKey, 5))
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const [u] = await q(`${USER_SQL} WHERE u.email = ?`, [email]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    addFail(ipKey); addFail(userKey);
    if (u) log(req, 'login_failed', {}, 'Wrong password', { teamId: u.team_id, userId: u.id });
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (u.team_disabled) return res.status(403).json({ error: 'This team account is disabled. Contact the TeamDrive owner.' });
  fails.delete(userKey);
  if (u.totp_enabled && !(await isTrustedDevice(req, u.id))) {
    // Password was right; now ask for the code. Nothing is unlocked until it's verified.
    return req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      req.session.pending2fa = { uid: u.id, at: Date.now(), remember: !!req.body.remember };
      res.json({ needs2fa: true });
    });
  }
  startSession(req, res, u, !!req.body.remember);
}));
app.post('/api/login/2fa', wrap(async (req, res) => {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > 10 * 60 * 1000)
    return res.status(401).json({ error: 'Sign-in timed out. Enter your password again.', restart: true });
  const key = `2fa:${p.uid}`;
  if (tooMany(key, 5)) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
  const [u] = await q(`${USER_SQL} WHERE u.id=?`, [p.uid]);
  if (!u || !u.totp_enabled || u.team_disabled) return res.status(401).json({ error: 'Sign-in timed out. Enter your password again.', restart: true });
  if (!(await checkSecondFactor(u, req.body.code))) {
    addFail(key);
    log(req, 'login_failed', {}, 'Wrong two-step code', { teamId: u.team_id, userId: u.id });
    return res.status(401).json({ error: 'Wrong code' });
  }
  fails.delete(key);
  if (req.body.trust) await trustDevice(res, u.id);
  startSession(req, res, u, !!p.remember);
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, wrap(async (req, res) => {
  const [u] = await q(`${USER_SQL} WHERE u.id=?`, [req.session.user.id]);
  if (!u) return req.session.destroy(() => res.status(401).json({ error: 'Not signed in' }));
  const [c] = await q('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id=? AND used_at IS NULL', [u.id]);
  const [tm] = await q('SELECT trial_ends_at FROM teams WHERE id=?', [u.team_id]);
  const [st] = await q("SELECT COALESCE(SUM(size),0) AS b FROM files WHERE team_id=? AND uploaded_by=? AND status='ready'", [u.team_id, u.id]);
  res.json({ ...req.session.user, portal: portal.ENABLED, my_storage: Number(st.b), team_name: u.team_name, trial_ends_at: u.is_admin ? tm.trial_ends_at : null, totp_enabled: !!u.totp_enabled, totp_required: requires2fa(u), backup_codes_left: c.n });
}));

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  if (!(await checkPassword(req.session.user.id, current))) return res.status(400).json({ error: 'Current password is wrong' });
  if (await bcrypt.compare(password, (await q('SELECT password_hash FROM users WHERE id=?', [req.session.user.id]))[0].password_hash))
    return res.status(400).json({ error: 'Choose a password that is different from your current one' });
  await q('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', [await bcrypt.hash(password, 12), req.session.user.id]);
  req.session.user = { ...req.session.user, must_change_password: false };
  await q('DELETE FROM trusted_devices WHERE user_id=?', [req.session.user.id]);
  log(req, 'password_change');
  res.json({ ok: true });
}));

// ---------- Two-step login setup ----------
app.post('/api/2fa/setup', auth, wrap(async (req, res) => {
  const [u] = await q('SELECT email, totp_enabled FROM users WHERE id=?', [req.session.user.id]);
  if (u.totp_enabled) return res.status(400).json({ error: 'Two-step login is already on' });
  const secret = totp.newSecret();
  await q('UPDATE users SET totp_secret=?, totp_last_step=0 WHERE id=?', [totp.seal(secret), req.session.user.id]);
  const label = encodeURIComponent(`TeamDrive:${u.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=TeamDrive&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
}));
app.post('/api/2fa/enable', auth, wrap(async (req, res) => {
  const [u] = await q('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  if (u.totp_enabled) return res.status(400).json({ error: 'Two-step login is already on' });
  if (!u.totp_secret) return res.status(400).json({ error: 'Start setup first' });
  const key = `2fa-setup:${u.id}`;
  if (tooMany(key, 10)) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
  const code = String(req.body.code || '').replace(/\s/g, '');
  const step = totp.verify(totp.open(u.totp_secret), code, 0);
  if (step === null) { addFail(key); return res.status(400).json({ error: "That code didn't match. Check the time on your phone is set automatically and try the newest code." }); }
  await q('UPDATE users SET totp_enabled=1, totp_last_step=? WHERE id=?', [step, u.id]);
  const codes = await newBackupCodes(u.id);
  req.session.user = { ...req.session.user, must_setup_2fa: false };
  log(req, '2fa_on');
  res.json({ codes });
}));
app.post('/api/2fa/backup-codes', auth, wrap(async (req, res) => {
  if (!(await checkPassword(req.session.user.id, req.body.password))) return res.status(400).json({ error: 'Password is wrong' });
  const [u] = await q('SELECT totp_enabled FROM users WHERE id=?', [req.session.user.id]);
  if (!u.totp_enabled) return res.status(400).json({ error: 'Two-step login is off' });
  log(req, 'backup_codes');
  res.json({ codes: await newBackupCodes(req.session.user.id) });
}));
app.post('/api/2fa/disable', auth, wrap(async (req, res) => {
  const [u] = await q('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  if (requires2fa(u)) return res.status(400).json({ error: 'Two-step login is required for your account and cannot be turned off' });
  if (!(await checkPassword(u.id, req.body.password))) return res.status(400).json({ error: 'Password is wrong' });
  await clear2fa(u.id);
  log(req, '2fa_off');
  res.json({ ok: true });
}));

// ---------- Members (your team only) ----------
app.get('/api/members', auth, wrap(async (req, res) => {
  res.json(await q('SELECT id, name FROM users WHERE team_id=? ORDER BY name', [T(req)]));
}));
app.get('/api/users', auth, admin, wrap(async (req, res) => {
  res.json((await q(`SELECT u.id, u.email, u.name, u.is_admin, u.is_owner, u.totp_enabled, u.created_at,
      (SELECT MAX(a.created_at) FROM activity_log a WHERE a.team_id=u.team_id AND a.user_id=u.id AND a.action='login') AS last_active,
      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.team_id=u.team_id AND f.uploaded_by=u.id AND f.status='ready') AS storage
    FROM users u WHERE u.team_id=? ORDER BY u.name`, [T(req)]))
    .map((u) => ({ ...u, storage: Number(u.storage), is_admin: !!u.is_admin, is_owner: !!u.is_owner, totp_enabled: !!u.totp_enabled, totp_required: requires2fa(u) })));
}));
app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const { email, name, password, is_admin } = req.body;
  if (!email || !name || !password || password.length < 8)
    return res.status(400).json({ error: 'Email, name and a password of 8+ characters are required' });
  const r = await q('INSERT INTO users (team_id, email, name, password_hash, is_admin, must_change_password) VALUES (?,?,?,?,?,1)',
    [T(req), String(email).toLowerCase(), cleanName(name), await bcrypt.hash(password, 12), is_admin ? 1 : 0])
    .catch((e) => { throw e.code === 'ER_DUP_ENTRY' ? httpErr(400, 'That email is already registered') : e; });
  log(req, 'user_add', { type: 'user', id: r.insertId, name: cleanName(name) }, is_admin ? 'Admin' : 'Member');
  res.json({ ok: true });
}));
app.post('/api/users/:id/password', auth, admin, wrap(async (req, res) => {
  const u = await teamMember(req, req.params.id);
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  await q('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [await bcrypt.hash(password, 12), u.id]);
  await q('DELETE FROM trusted_devices WHERE user_id=?', [u.id]);
  log(req, 'password_reset', { type: 'user', id: u.id, name: u.name });
  res.json({ ok: true });
}));
// For a member who lost their phone and backup codes. They set it up again at next sign-in if required.
app.delete('/api/users/:id/2fa', auth, admin, wrap(async (req, res) => {
  const u = await teamMember(req, req.params.id);
  if (u.id === req.session.user.id) return res.status(400).json({ error: 'Use your own Two-step login settings instead' });
  await clear2fa(u.id);
  log(req, '2fa_reset', { type: 'user', id: u.id, name: u.name });
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const u = await teamMember(req, req.params.id);
  if (u.id === req.session.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  await q('DELETE FROM users WHERE id = ?', [u.id]).catch(() => {
    throw httpErr(400, 'This member has uploaded files or created folders/links, so they cannot be removed. Reset their password instead to block access.');
  });
  log(req, 'user_remove', { type: 'user', id: u.id, name: u.name });
  res.json({ ok: true });
}));

// ---------- Browse ----------
app.get('/api/stats', auth, wrap(async (req, res) => {
  const u = await teamUsage(T(req));
  const [t] = await q('SELECT quota_bytes FROM teams WHERE id=?', [T(req)]);
  res.json({ files: u.files, bytes: u.used, quota: t.quota_bytes === null ? null : Number(t.quota_bytes) });
}));

app.get('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = idOrNull(req.params.id);
  const acl = await requireFolder(req, id);
  const where = id === null ? 'IS NULL' : '= ?';
  const p = id === null ? [T(req)] : [T(req), id];
  const folders = (await q(`SELECT f.id, f.name, f.restricted, f.created_at, u.name AS owner FROM folders f JOIN users u ON u.id=f.created_by
    WHERE f.team_id=? AND f.parent_id ${where} AND f.deleted_at IS NULL`, p))
    .filter((f) => acl.can(f.id))
    .map((f) => ({ ...f, restricted: !!f.restricted, can_manage: acl.canManage(f.id) }));
  // How many items each folder holds (only subfolders this person can see).
  if (folders.length) {
    const fileCounts = new Map((await q("SELECT folder_id, COUNT(*) AS n FROM files WHERE team_id=? AND folder_id IN (?) AND status='ready' AND deleted_at IS NULL GROUP BY folder_id",
      [T(req), folders.map((f) => f.id)])).map((r) => [r.folder_id, Number(r.n)]));
    const sub = new Map();
    for (const c of acl.byId.values()) if (!c.deleted_at && acl.can(c.id) && c.parent_id != null) sub.set(c.parent_id, (sub.get(c.parent_id) || 0) + 1);
    for (const f of folders) f.items = (fileCounts.get(f.id) || 0) + (sub.get(f.id) || 0);
  }
  const files = await q(`SELECT f.id, f.name, f.size, f.mime, f.created_at, COALESCE(f.updated_at, f.created_at) AS updated_at, ${OWNER},
    (SELECT COUNT(*) FROM file_versions v WHERE v.file_id=f.id) AS versions
    FROM files f JOIN users u ON u.id=f.uploaded_by ${OWNER_JOIN}
    WHERE f.team_id=? AND f.folder_id ${where} AND f.status='ready' AND f.deleted_at IS NULL`, p);
  const crumbs = [];
  for (let c = id; c !== null; ) { const f = acl.byId.get(c); crumbs.unshift({ id: f.id, name: f.name, restricted: !!f.restricted }); c = f.parent_id; }
  const [mc] = await q('SELECT COUNT(*) AS n FROM users WHERE team_id=?', [T(req)]);
  res.json({ folders, files, crumbs, member_count: Number(mc.n) });
}));

app.get('/api/folders-all', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  res.json([...acl.byId.values()].filter((f) => acl.visible(f.id)).map(({ id, name, parent_id }) => ({ id, name, parent_id })));
}));

app.get('/api/search', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  const term = `%${String(req.query.q || '').replace(/[%_\\]/g, '\\$&')}%`;
  res.json({
    folders: (await q('SELECT id, name, parent_id, restricted, created_at FROM folders WHERE team_id=? AND deleted_at IS NULL AND name LIKE ? LIMIT 200', [T(req), term]))
      .filter((f) => acl.visible(f.id)).slice(0, 50)
      .map((f) => ({ ...f, restricted: !!f.restricted, can_manage: acl.canManage(f.id) })),
    files: (await q(`SELECT f.id, f.name, f.size, f.mime, f.folder_id, f.created_at, COALESCE(f.updated_at, f.created_at) AS updated_at, ${OWNER},
      (SELECT COUNT(*) FROM file_versions v WHERE v.file_id=f.id) AS versions
      FROM files f JOIN users u ON u.id=f.uploaded_by ${OWNER_JOIN}
      WHERE f.team_id=? AND f.deleted_at IS NULL AND f.status='ready' AND f.name LIKE ? LIMIT 500`, [T(req), term]))
      .filter((f) => acl.visible(f.folder_id)).slice(0, 100),
  });
}));

// ---------- Folders ----------
app.post('/api/folders', auth, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const parent = idOrNull(req.body.parent_id);
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  const acl = await requireFolder(req, parent);
  const r = await q('INSERT INTO folders (team_id, parent_id, name, created_by) VALUES (?,?,?,?)', [T(req), parent, name, req.session.user.id]);
  log(req, 'folder_create', { type: 'folder', id: r.insertId, name }, `in ${acl.pathOf(parent)}`);
  res.json({ id: r.insertId });
}));

// Find-or-create a chain of folders (used by folder uploads). Body: { parent_id, path: ["a","b"] }
app.post('/api/folders/ensure', auth, wrap(async (req, res) => {
  let parent = idOrNull(req.body.parent_id);
  const acl = await requireFolder(req, parent);
  for (const raw of (Array.isArray(req.body.path) ? req.body.path : []).slice(0, 50)) {
    const name = cleanName(raw);
    if (!name) continue;
    const existing = (await q(`SELECT id FROM folders WHERE team_id=? AND parent_id ${parent === null ? 'IS NULL' : '= ?'} AND name=? AND deleted_at IS NULL`,
      parent === null ? [T(req), name] : [T(req), parent, name])).find((f) => acl.can(f.id));
    if (existing) parent = existing.id;
    else {
      const inPath = acl.pathOf(parent);
      parent = (await q('INSERT INTO folders (team_id, parent_id, name, created_by) VALUES (?,?,?,?)', [T(req), parent, name, req.session.user.id])).insertId;
      log(req, 'folder_create', { type: 'folder', id: parent, name }, `in ${inPath}`);
    }
  }
  res.json({ id: parent });
}));

app.patch('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  const f = acl.byId.get(id);
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name required' });
    await q('UPDATE folders SET name=? WHERE id=?', [name, id]);
    if (name !== f.name) log(req, 'rename', { type: 'folder', id, name }, `from "${f.name}"`);
  }
  if (req.body.parent_id !== undefined) {
    const target = idOrNull(req.body.parent_id);
    if (target !== null && !acl.visible(target)) return res.status(400).json({ error: 'Target folder not found' });
    for (let cur = target; cur !== null; cur = acl.byId.get(cur).parent_id)
      if (cur === id) return res.status(400).json({ error: "Can't move a folder into itself" });
    await q('UPDATE folders SET parent_id=? WHERE id=?', [target, id]);
    if (target !== f.parent_id) log(req, 'move', { type: 'folder', id, name: f.name }, `to ${acl.pathOf(target)}`);
  }
  res.json({ ok: true });
}));
app.delete('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  await q('UPDATE folders SET deleted_at=NOW(), deleted_by=? WHERE id=?', [req.session.user.id, id]);
  log(req, 'delete', { type: 'folder', id, name: acl.byId.get(id).name });
  res.json({ ok: true });
}));

// Folder access (restriction)
app.get('/api/folders/:id/access', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  if (!acl.canManage(id)) throw httpErr(403, 'Only an admin or the folder creator can change access');
  const f = acl.byId.get(id);
  const users = (await q('SELECT user_id FROM folder_access WHERE folder_id=?', [id])).map((r) => r.user_id);
  res.json({ restricted: !!f.restricted, user_ids: users, created_by: f.created_by });
}));
app.put('/api/folders/:id/access', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  if (!acl.canManage(id)) throw httpErr(403, 'Only an admin or the folder creator can change access');
  const ids = [...new Set((req.body.user_ids || []).map(Number).filter(Boolean))];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE folders SET restricted=? WHERE id=?', [req.body.restricted ? 1 : 0, id]);
    await conn.query('DELETE FROM folder_access WHERE folder_id=?', [id]);
    if (req.body.restricted && ids.length)
      await conn.query('INSERT INTO folder_access (folder_id, user_id) SELECT ?, id FROM users WHERE id IN (?) AND team_id=?', [id, ids, T(req)]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  let detail = 'Open to the whole team';
  if (req.body.restricted) {
    const names = ids.length ? (await q('SELECT name FROM users WHERE id IN (?) AND team_id=?', [ids, T(req)])).map((u) => u.name) : [];
    detail = `Restricted to ${names.length ? names.join(', ') : 'admins and creator'}`;
  }
  log(req, 'access_change', { type: 'folder', id, name: acl.byId.get(id).name }, detail);
  res.json({ ok: true });
}));

// Download a whole folder as a zip (streamed from R2 through the server).
app.get('/api/folders/:id/zip', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  const children = new Map();
  for (const f of acl.byId.values()) if (!f.deleted_at && acl.can(f.id)) {
    if (!children.has(f.parent_id)) children.set(f.parent_id, []);
    children.get(f.parent_id).push(f);
  }
  const dirs = [{ id, prefix: '' }];
  for (let i = 0; i < dirs.length; i++)
    for (const c of children.get(dirs[i].id) || []) dirs.push({ id: c.id, prefix: `${dirs[i].prefix}${c.name}/` });
  const prefixOf = new Map(dirs.map((d) => [d.id, d.prefix]));
  const files = await q("SELECT name, r2_key, size, folder_id FROM files WHERE team_id=? AND status='ready' AND deleted_at IS NULL AND folder_id IN (?)", [T(req), [...prefixOf.keys()]]);
  const total = files.reduce((s, f) => s + Number(f.size), 0);
  if (total > MAX_ZIP_BYTES) return res.status(400).json({ error: `Folder is larger than the ${process.env.MAX_ZIP_MB || 5120} MB zip limit. Download subfolders instead.` });

  log(req, 'zip_download', { type: 'folder', id, name: acl.byId.get(id).name }, `${files.length} files`);
  const zipName = `${acl.byId.get(id).name}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (e) => { console.error('zip error', e); res.destroy(e); });
  archive.pipe(res);
  // Add entries one at a time so only one R2 download is open at once.
  const add = (src, opts) => new Promise((resolve) => { archive.once('entry', resolve); archive.append(src, opts); });
  const used = new Set();
  for (const d of dirs) if (d.prefix) await add(null, { name: d.prefix, type: 'directory' }); // keep empty folders
  for (const f of files) {
    let name = prefixOf.get(f.folder_id) + f.name;
    for (let n = 2; used.has(name); n++) name = prefixOf.get(f.folder_id) + f.name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    used.add(name);
    if (res.destroyed) return archive.abort();
    await add(await r2.getStream(f.r2_key), { name });
  }
  await archive.finalize();
}));

// ---------- Files ----------
app.post('/api/files/init', auth, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const size = Number(req.body.size || 0);
  const mime = String(req.body.mime || 'application/octet-stream').slice(0, 255) || 'application/octet-stream';
  const folder = idOrNull(req.body.folder_id);
  if (!name) return res.status(400).json({ error: 'File name required' });
  if (size > MAX_BYTES) return res.status(400).json({ error: `File exceeds ${process.env.MAX_UPLOAD_MB || 2048} MB limit` });
  if (req.session.user.is_demo) demo.checkUpload(name, size);
  await requireFolder(req, folder);
  const [t] = await q('SELECT quota_bytes FROM teams WHERE id=?', [T(req)]);
  if (t.quota_bytes !== null) {
    const { used } = await teamUsage(T(req));
    if (used + size > Number(t.quota_bytes))
      return res.status(400).json({ error: `Your team's storage is full (${fmtBytes(used)} of ${fmtBytes(Number(t.quota_bytes))} used). Delete files or ask the owner for more space.` });
  }
  const [existing] = await q("SELECT id FROM files WHERE team_id=? AND folder_id <=> ? AND name=? AND status='ready' AND deleted_at IS NULL LIMIT 1", [T(req), folder, name]);
  const key = `files/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  const r = await q('INSERT INTO files (team_id, folder_id, name, r2_key, size, mime, uploaded_by) VALUES (?,?,?,?,?,?,?)',
    [T(req), folder, name, key, size, mime, req.session.user.id]);
  res.json({ id: r.insertId, url: await r2.uploadUrl(key, mime), replaces: existing ? existing.id : null });
}));

// After the browser's PUT finishes. Same name in the same folder => becomes a new version.
app.post('/api/files/:id/complete', auth, wrap(async (req, res) => {
  const [f] = await q("SELECT * FROM files WHERE id=? AND team_id=? AND uploaded_by=? AND status='pending'", [req.params.id, T(req), req.session.user.id]);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const meta = await r2.head(f.r2_key).catch(() => null);
  if (!meta) return res.status(400).json({ error: 'Upload not found in storage' });
  const size = Number(meta.ContentLength ?? f.size);
  const conn = await pool.getConnection();
  let old;
  try {
    await conn.beginTransaction();
    [[old]] = await conn.query(
      "SELECT * FROM files WHERE team_id=? AND folder_id <=> ? AND name=? AND status='ready' AND deleted_at IS NULL AND id<>? LIMIT 1 FOR UPDATE",
      [f.team_id, f.folder_id, f.name, f.id]);
    if (old) {
      await conn.query('INSERT INTO file_versions (file_id, r2_key, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
        [old.id, old.r2_key, old.size, old.mime, old.uploaded_by, old.updated_at || old.created_at]);
      await conn.query('DELETE FROM files WHERE id=?', [f.id]);
      await conn.query('UPDATE files SET r2_key=?, size=?, mime=?, uploaded_by=?, updated_at=NOW() WHERE id=?',
        [f.r2_key, size, f.mime, f.uploaded_by, old.id]);
    } else {
      await conn.query("UPDATE files SET status='ready', size=?, updated_at=NOW() WHERE id=?", [size, f.id]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  const acl = await loadAcl(req.session.user);
  log(req, old ? 'new_version' : 'upload', { type: 'file', id: old ? old.id : f.id, name: f.name }, `${fmtBytes(size)} in ${acl.pathOf(f.folder_id)}`);
  res.json({ ok: true, id: old ? old.id : f.id, versioned: !!old });
}));

app.get('/api/files/:id/download', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  log(req, 'download', { type: 'file', id: f.id, name: f.name });
  res.redirect(await r2.downloadUrl(f.r2_key, f.name));
}));

// Only types that are safe to show inline; text is always served as plain text.
const previewType = (mime) => {
  if (/^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/(mp4|webm|ogg|quicktime)|audio\/.+|application\/pdf)$/.test(mime)) return mime;
  if (/^text\/|^application\/(json|xml|javascript)$/.test(mime)) return 'text/plain; charset=utf-8';
  return null;
};
app.get('/api/files/:id/preview', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const type = previewType(f.mime);
  if (!type) return res.status(400).json({ error: 'No preview for this file type' });
  res.json({ url: await r2.previewUrl(f.r2_key, type), mime: f.mime });
}));

app.patch('/api/files/:id', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const sets = [], p = [];
  let newName = null, target;
  if (req.body.name !== undefined) {
    newName = cleanName(req.body.name);
    if (!newName) return res.status(400).json({ error: 'Name required' });
    sets.push('name=?'); p.push(newName);
  }
  let acl;
  if (req.body.folder_id !== undefined) {
    target = idOrNull(req.body.folder_id);
    acl = await requireFolder(req, target).catch(() => { throw httpErr(400, 'Target folder not found'); });
    sets.push('folder_id=?'); p.push(target);
  }
  if (sets.length) await q(`UPDATE files SET ${sets.join(',')} WHERE id=?`, [...p, f.id]);
  if (newName && newName !== f.name) log(req, 'rename', { type: 'file', id: f.id, name: newName }, `from "${f.name}"`);
  if (acl && target !== f.folder_id) log(req, 'move', { type: 'file', id: f.id, name: newName || f.name }, `to ${acl.pathOf(target)}`);
  res.json({ ok: true });
}));
app.delete('/api/files/:id', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  await q('UPDATE files SET deleted_at=NOW(), deleted_by=? WHERE id=?', [req.session.user.id, f.id]);
  log(req, 'delete', { type: 'file', id: f.id, name: f.name });
  res.json({ ok: true });
}));

// ---------- Versions ----------
app.get('/api/files/:id/versions', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const [cur] = await q('SELECT name FROM users WHERE id=?', [f.uploaded_by]);
  const older = await q(`SELECT v.id, v.size, v.created_at, u.name AS owner FROM file_versions v JOIN users u ON u.id=v.uploaded_by
    WHERE v.file_id=? ORDER BY v.created_at DESC, v.id DESC`, [f.id]);
  res.json({ name: f.name, current: { size: f.size, created_at: f.updated_at || f.created_at, owner: cur?.name }, older });
}));
app.get('/api/files/:id/versions/:vid/download', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const [v] = await q('SELECT * FROM file_versions WHERE id=? AND file_id=?', [req.params.vid, f.id]);
  if (!v) return res.status(404).json({ error: 'Version not found' });
  const stamp = new Date(v.created_at).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  log(req, 'download', { type: 'file', id: f.id, name: f.name }, `Older version from ${stamp}`);
  res.redirect(await r2.downloadUrl(v.r2_key, f.name.replace(/(\.[^.]*)?$/, ` (${stamp})$1`)));
}));
app.post('/api/files/:id/versions/:vid/restore', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const conn = await pool.getConnection();
  let v;
  try {
    await conn.beginTransaction();
    [[v]] = await conn.query('SELECT * FROM file_versions WHERE id=? AND file_id=? FOR UPDATE', [req.params.vid, f.id]);
    if (!v) throw httpErr(404, 'Version not found');
    await conn.query('DELETE FROM file_versions WHERE id=?', [v.id]);
    await conn.query('INSERT INTO file_versions (file_id, r2_key, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
      [f.id, f.r2_key, f.size, f.mime, f.uploaded_by, f.updated_at || f.created_at]);
    await conn.query('UPDATE files SET r2_key=?, size=?, mime=?, uploaded_by=?, updated_at=NOW() WHERE id=?',
      [v.r2_key, v.size, v.mime, req.session.user.id, f.id]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  log(req, 'version_restore', { type: 'file', id: f.id, name: f.name }, `Restored the version from ${new Date(v.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  res.json({ ok: true });
}));

// ---------- Trash ----------
app.get('/api/trash', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  res.json({
    folders: (await q('SELECT f.id, f.name, f.deleted_at, u.name AS owner FROM folders f LEFT JOIN users u ON u.id=f.deleted_by WHERE f.team_id=? AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC', [T(req)])).filter((f) => acl.can(f.id)),
    files: (await q('SELECT f.id, f.name, f.size, f.mime, f.folder_id, f.deleted_at, u.name AS owner FROM files f LEFT JOIN users u ON u.id=f.deleted_by WHERE f.team_id=? AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC', [T(req)])).filter((f) => acl.can(f.folder_id)),
  });
}));
// If the item's parent folder is still in Trash, restore it to the top level so it doesn't vanish.
app.post('/api/trash/:type/:id/restore', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  let movedToRoot = false, name;
  if (req.params.type === 'folder') {
    const f = acl.byId.get(Number(req.params.id));
    if (!f || !acl.can(f.id)) throw httpErr(404, 'Not found');
    movedToRoot = f.parent_id !== null && !acl.alive(f.parent_id);
    await q('UPDATE folders SET deleted_at=NULL, parent_id=? WHERE id=?', [movedToRoot ? null : f.parent_id, f.id]);
    name = f.name;
  } else {
    const [f] = await q('SELECT id, name, folder_id FROM files WHERE id=? AND team_id=?', [req.params.id, T(req)]);
    if (!f || !acl.can(f.folder_id)) throw httpErr(404, 'Not found');
    movedToRoot = f.folder_id !== null && !acl.alive(f.folder_id);
    await q('UPDATE files SET deleted_at=NULL, folder_id=? WHERE id=?', [movedToRoot ? null : f.folder_id, f.id]);
    name = f.name;
  }
  log(req, 'restore', { type: req.params.type === 'folder' ? 'folder' : 'file', id: Number(req.params.id), name }, movedToRoot ? 'Put at top level (its folder is in Trash)' : '');
  res.json({ ok: true, movedToRoot });
}));

// Permanent purge is admin-only. Storage objects (and old versions) are kept for
// PURGE_DAYS before being erased from R2, so a mistake can still be recovered.
async function queuePurge(fileIds) {
  if (!fileIds.length) return;
  const objs = [
    ...(await q('SELECT r2_key, name, size FROM files WHERE id IN (?)', [fileIds])),
    ...(await q('SELECT v.r2_key, f.name, v.size FROM file_versions v JOIN files f ON f.id=v.file_id WHERE v.file_id IN (?)', [fileIds])),
  ];
  for (const o of objs)
    await q('INSERT IGNORE INTO purge_queue (r2_key, name, size, purge_after) VALUES (?,?,?, NOW() + INTERVAL ? DAY)', [o.r2_key, o.name, o.size, PURGE_DAYS]);
}
app.delete('/api/trash/:type/:id', auth, admin, wrap(async (req, res) => {
  if (req.params.type === 'file') {
    const [f] = await q('SELECT id, name FROM files WHERE id=? AND team_id=? AND deleted_at IS NOT NULL', [req.params.id, T(req)]);
    if (f) {
      await queuePurge([f.id]); await q('DELETE FROM files WHERE id=?', [f.id]);
      log(req, 'purge', { type: 'file', id: f.id, name: f.name });
    }
  } else {
    const [root] = await q('SELECT id, name FROM folders WHERE id=? AND team_id=? AND deleted_at IS NOT NULL', [req.params.id, T(req)]);
    if (root) {
      const ids = [root.id];
      for (let i = 0; i < ids.length; i++)
        (await q('SELECT id FROM folders WHERE parent_id=? AND team_id=?', [ids[i], T(req)])).forEach((r) => ids.push(r.id));
      const fileIds = (await q('SELECT id FROM files WHERE folder_id IN (?) AND team_id=?', [ids, T(req)])).map((r) => r.id);
      await queuePurge(fileIds);
      await q('DELETE FROM folders WHERE id=?', [root.id]);
      log(req, 'purge', { type: 'folder', id: root.id, name: root.name }, `${fileIds.length} files`);
    }
  }
  res.json({ ok: true });
}));

async function runPurge() {
  try {
    const due = await q('SELECT id, r2_key FROM purge_queue WHERE purge_after < NOW() LIMIT 500');
    for (const d of due) { await r2.remove(d.r2_key); await q('DELETE FROM purge_queue WHERE id=?', [d.id]); }
    if (due.length) console.log(`Purged ${due.length} object(s) from storage`);
    await q('DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL ? DAY', [ACTIVITY_DAYS]);
    await q('DELETE FROM access_requests WHERE created_at < NOW() - INTERVAL 365 DAY');
  } catch (e) { console.error('Purge job failed:', e.message); }
}

// ---------- Share links ----------
app.post('/api/files/:id/share', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const days = Number(req.body.days ?? 7);
  const pw = String(req.body.password || '');
  if (pw && pw.length < 4) return res.status(400).json({ error: 'Link password must be 4+ characters' });
  const token = crypto.randomBytes(24).toString('hex');
  await q('INSERT INTO share_links (token, file_id, created_by, expires_at, password_hash) VALUES (?,?,?,?,?)',
    [token, f.id, req.session.user.id, days > 0 ? new Date(Date.now() + days * 864e5) : null, pw ? await bcrypt.hash(pw, 10) : null]);
  log(req, 'share_create', { type: 'file', id: f.id, name: f.name }, `${days > 0 ? `Expires in ${days} day${days === 1 ? '' : 's'}` : 'Never expires'}${pw ? ', password-protected' : ''}`);
  res.json({ url: `${process.env.APP_URL}/s/${token}` });
}));
app.get('/api/shares', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  const mine = !req.session.user.is_admin;
  const rows = await q(`SELECT s.id, s.token, s.expires_at, s.created_at, s.downloads, s.created_by, (s.password_hash IS NOT NULL) AS has_password,
      f.id AS file_id, f.name AS file_name, f.folder_id, f.deleted_at, u.name AS creator
    FROM share_links s JOIN files f ON f.id=s.file_id JOIN users u ON u.id=s.created_by
    WHERE f.team_id=? ${mine ? 'AND s.created_by=?' : ''} ORDER BY s.created_at DESC`, mine ? [T(req), req.session.user.id] : [T(req)]);
  res.json(rows.filter((r) => acl.can(r.folder_id)).map((r) => ({
    id: r.id, url: `${process.env.APP_URL}/s/${r.token}`, file_id: r.file_id, file_name: r.file_name, creator: r.creator,
    created_at: r.created_at, expires_at: r.expires_at, downloads: r.downloads, has_password: !!r.has_password,
    status: r.deleted_at ? 'file in trash' : r.expires_at && new Date(r.expires_at) < new Date() ? 'expired' : 'active',
  })));
}));
app.delete('/api/shares/:id', auth, wrap(async (req, res) => {
  const [s] = await q('SELECT s.id, s.created_by, f.id AS file_id, f.name FROM share_links s JOIN files f ON f.id=s.file_id WHERE s.id=? AND f.team_id=?', [req.params.id, T(req)]);
  if (!s || (!req.session.user.is_admin && s.created_by !== req.session.user.id)) throw httpErr(404, 'Link not found');
  await q('DELETE FROM share_links WHERE id=?', [s.id]);
  log(req, 'share_revoke', { type: 'file', id: s.file_id, name: s.name });
  res.json({ ok: true });
}));

// Public link pages
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--mute:#6b7280;--line:#e5e7eb;--acc:#2f6bff;--danger:#d93838}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#e8eaf0;--mute:#9aa1ad;--line:#2a2e38;--acc:#5b8cff}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
.c{max-width:360px;margin:14vh auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px}
input,button{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{background:var(--acc);border-color:var(--acc);color:#fff;cursor:pointer}.m{color:var(--mute);font-size:14px}.e{color:var(--danger);font-size:14px}
a{color:var(--acc)}.f{text-align:center;font-size:13px;color:var(--mute);margin-top:-6vh}
</style></head><body><div class="c">${body}</div><p class="f"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></body></html>`;
async function shareRow(token) {
  const [row] = await q(`SELECT s.id, s.password_hash, f.id AS file_id, f.team_id, f.r2_key, f.name FROM share_links s
    JOIN files f ON f.id=s.file_id JOIN teams t ON t.id=f.team_id
    WHERE s.token=? AND (s.expires_at IS NULL OR s.expires_at > NOW()) AND f.deleted_at IS NULL AND f.status='ready' AND t.disabled=0`, [token]);
  return row;
}
async function serveShare(req, res, row, status = 302) {
  await q('UPDATE share_links SET downloads=downloads+1 WHERE id=?', [row.id]);
  log(req, 'share_open', { type: 'file', id: row.file_id, name: row.name }, 'Downloaded through a share link', { teamId: row.team_id, userId: null });
  res.redirect(status, await r2.downloadUrl(row.r2_key, row.name));
}
const pwForm = (name, err = '') => page('Protected file', `<b>${esc(name)}</b><span class="m">This file is password-protected.</span>
  <form method="post" style="display:grid;gap:10px"><input type="password" name="password" placeholder="Password" required autofocus><button>Download</button></form>
  ${err ? `<span class="e">${esc(err)}</span>` : ''}`);
const gone = () => page('Link unavailable', '<b>Link unavailable</b><span class="m">This link has expired, was revoked, or does not exist.</span>');
app.get('/s/:token', wrap(async (req, res) => {
  const row = await shareRow(req.params.token);
  if (!row) return res.status(404).send(gone());
  if (row.password_hash) return res.send(pwForm(row.name));
  await serveShare(req, res, row);
}));
app.post('/s/:token', wrap(async (req, res) => {
  const row = await shareRow(req.params.token);
  if (!row) return res.status(404).send(gone());
  if (!row.password_hash) return res.redirect(`/s/${req.params.token}`);
  const key = `s:${req.ip}:${req.params.token}`;
  if (tooMany(key, 10)) return res.status(429).send(pwForm(row.name, 'Too many attempts. Try again in 15 minutes.'));
  if (!(await bcrypt.compare(String(req.body.password || ''), row.password_hash))) {
    addFail(key);
    return res.status(401).send(pwForm(row.name, 'Wrong password'));
  }
  await serveShare(req, res, row, 303);
}));

// ---------- Activity (admins, own team) ----------
function activityQuery(req) {
  const where = ['a.team_id=?'], p = [T(req)];
  if (req.query.user) { where.push('a.user_id=?'); p.push(Number(req.query.user)); }
  if (req.query.action) { where.push('a.action IN (?)'); p.push(String(req.query.action).split(',').slice(0, 20)); }
  if (req.query.q) { where.push('(a.target_name LIKE ? OR a.detail LIKE ?)'); const t = `%${String(req.query.q).replace(/[%_\\]/g, '\\$&')}%`; p.push(t, t); }
  if (req.query.from) { where.push('a.created_at >= ?'); p.push(new Date(req.query.from)); }
  if (req.query.to) { where.push('a.created_at < ?'); p.push(new Date(new Date(req.query.to).getTime() + 864e5)); }
  return { sql: `SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.target_name, a.detail, a.ip, a.device, a.user_id, u.name AS user_name
    FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE ${where.join(' AND ')}`, p };
}
app.get('/api/activity', auth, admin, wrap(async (req, res) => {
  const { sql, p } = activityQuery(req);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const before = Number(req.query.before) || 0;
  const rows = await q(`${sql}${before ? ' AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`, [...p, ...(before ? [before] : []), limit + 1]);
  res.json({ items: rows.slice(0, limit), more: rows.length > limit });
}));
app.get('/api/activity.csv', auth, admin, wrap(async (req, res) => {
  const { sql, p } = activityQuery(req);
  const rows = await q(`${sql} ORDER BY a.id DESC LIMIT 20000`, p);
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]|^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
  const lines = [['Time (UTC)', 'Who', 'Action', 'Type', 'Item', 'Details', 'IP', 'Device'].join(',')];
  for (const r of rows)
    lines.push([new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19), r.user_name || (r.user_id ? 'Removed member' : 'Someone with a link'),
      r.action, r.target_type, r.target_name, r.detail, r.ip, r.device].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="teamdrive-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

// ---------- Backups (owner) ----------
app.get('/api/owner/backups', auth, owner, wrap(async (req, res) => {
  let items = [], listError = null;
  try { items = (await backup.list()).slice(0, 40); } catch (e) { listError = e.message; }
  res.json({ enabled: backup.ENABLED, keep_days: backup.KEEP_DAYS, last: await backup.last(), items, list_error: listError });
}));
app.post('/api/owner/backups', auth, owner, wrap(async (req, res) => {
  const info = await backup.run('manual').catch((e) => { throw httpErr(500, `Backup failed: ${e.message}`); });
  log(req, 'backup', {}, `${Math.round(info.bytes / 1024)} KB`);
  res.json(info);
}));
app.get('/api/owner/backups/download', auth, owner, wrap(async (req, res) => {
  const key = String(req.query.key || '');
  if (!key.startsWith(backup.PREFIX) || !/^teamdrive-[\d-]+\.sql\.gz$/.test(key.slice(backup.PREFIX.length))) throw httpErr(400, 'Unknown backup');
  res.redirect(await r2.downloadUrl(key, key.slice(backup.PREFIX.length)));
}));

// ---------- Teams (platform owner) ----------
app.get('/api/owner/teams', auth, owner, wrap(async (req, res) => {
  const teams = await q(`SELECT t.id, t.name, t.quota_bytes, t.disabled, t.created_at, t.trial_ends_at,
    (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id) AS members,
    (SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR ', ') FROM users u WHERE u.team_id=t.id AND u.is_admin=1) AS admins,
    (SELECT GROUP_CONCAT(u.email ORDER BY u.id SEPARATOR ', ') FROM users u WHERE u.team_id=t.id AND u.is_admin=1) AS admin_emails
    FROM teams t ORDER BY t.name`);
  for (const t of teams) Object.assign(t, await teamUsage(t.id), { quota_bytes: t.quota_bytes === null ? null : Number(t.quota_bytes), disabled: !!t.disabled, mine: t.id === T(req) });
  res.json(teams);
}));
const quotaBytes = (gb) => (gb === '' || gb === null || gb === undefined || Number(gb) <= 0 ? null : Math.round(Number(gb) * GB));
app.post('/api/owner/teams', auth, owner, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const { admin_name, admin_email, admin_password } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name required' });
  if (!admin_name || !admin_email || !admin_password || String(admin_password).length < 8)
    return res.status(400).json({ error: "First admin's name, email and a temporary password of 8+ characters are required" });
  const conn = await pool.getConnection();
  let teamId;
  try {
    await conn.beginTransaction();
    const trialDays = Number(req.body.trial_days) > 0 ? Math.min(Number(req.body.trial_days), 365) : 0;
    teamId = (await conn.query('INSERT INTO teams (name, quota_bytes, trial_ends_at) VALUES (?,?,?)',
      [name, quotaBytes(req.body.quota_gb), trialDays ? new Date(Date.now() + trialDays * 864e5) : null]))[0].insertId;
    await conn.query('INSERT INTO users (team_id, email, name, password_hash, is_admin, must_change_password) VALUES (?,?,?,?,1,1)',
      [teamId, String(admin_email).toLowerCase(), cleanName(admin_name), await bcrypt.hash(String(admin_password), 12)]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e.code === 'ER_DUP_ENTRY' ? httpErr(400, 'That admin email is already registered') : e;
  } finally { conn.release(); }
  log(req, 'team_create', { type: 'team', id: teamId, name }, `First admin ${String(admin_email).toLowerCase()}`);
  log(req, 'team_create', { type: 'team', id: teamId, name }, 'Team created by the TeamDrive owner', { teamId, userId: null });
  res.json({ id: teamId });
}));
app.patch('/api/owner/teams/:id', auth, owner, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('SELECT * FROM teams WHERE id=?', [id]);
  if (!t) throw httpErr(404, 'Team not found');
  const changes = [];
  if (req.body.name !== undefined) {
    const n = cleanName(req.body.name);
    if (!n) return res.status(400).json({ error: 'Team name required' });
    await q('UPDATE teams SET name=? WHERE id=?', [n, id]); if (n !== t.name) changes.push(`renamed to "${n}"`);
  }
  if (req.body.quota_gb !== undefined) {
    const qb = quotaBytes(req.body.quota_gb);
    await q('UPDATE teams SET quota_bytes=? WHERE id=?', [qb, id]); changes.push(`storage limit ${qb === null ? 'removed' : `set to ${fmtBytes(qb)}`}`);
  }
  if (req.body.trial_end !== undefined) {
    // 'YYYY-MM-DD' sets/extends the trial (ends at the end of that day); '' ends the trial (now a paying customer)
    const d = req.body.trial_end ? new Date(`${req.body.trial_end}T23:59:59`) : null;
    if (d && isNaN(d)) return res.status(400).json({ error: 'Pick a valid trial end date' });
    await q('UPDATE teams SET trial_ends_at=? WHERE id=?', [d, id]);
    changes.push(d ? `trial ends ${req.body.trial_end}` : 'trial ended (now a customer)');
  }
  if (req.body.disabled !== undefined) {
    if (id === T(req) && req.body.disabled) return res.status(400).json({ error: "You can't disable your own team" });
    await q('UPDATE teams SET disabled=? WHERE id=?', [req.body.disabled ? 1 : 0, id]); changes.push(req.body.disabled ? 'disabled' : 'enabled');
  }
  if (changes.length) log(req, 'team_update', { type: 'team', id, name: t.name }, changes.join(', '));
  res.json({ ok: true });
}));

// ---------- Frontend ----------
// ---------- Access requests (public landing page form) ----------
app.post('/api/access-requests', wrap(async (req, res) => {
  const key = `req:${req.ip}`;
  if (tooMany(key, 5)) return res.status(429).json({ error: 'Too many requests from your network. Please try again later, or email privacy@equawire.com.' });
  addFail(key);
  if (req.body.website) return res.json({ ok: true }); // spam trap: humans never fill this hidden field
  const f = (k, max) => String(req.body[k] || '').trim().slice(0, max);
  const name = f('name', 120), email = f('email', 200).toLowerCase(), company = f('company', 160), size = f('team_size', 40), hosting = f('hosting', 60), message = f('message', 2000);
  if (!name || !company || !size) return res.status(400).json({ error: 'Please fill in your name, company and team size.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid work email, like you@yourcompany.com.' });
  await q('INSERT INTO access_requests (name, email, company, team_size, hosting, message, ip) VALUES (?,?,?,?,?,?,?)', [name, email, company, size, hosting || null, message || null, String(req.ip || '').slice(0, 64)]);
  console.log(`New access request from ${company} (${email})`);
  res.json({ ok: true });
}));
app.get('/api/owner/requests', auth, owner, wrap(async (req, res) => {
  res.json(await q('SELECT * FROM access_requests ORDER BY handled_at IS NOT NULL, created_at DESC LIMIT 200'));
}));
app.patch('/api/owner/requests/:id', auth, owner, wrap(async (req, res) => {
  await q('UPDATE access_requests SET handled_at=? WHERE id=?', [req.body.handled ? new Date() : null, req.params.id]);
  res.json({ ok: true });
}));

// Health check for uptime monitors (e.g. UptimeRobot keyword "\"status\":\"ok\"").
// Says only whether things work, never anything about customers' data.
app.get('/health', wrap(async (req, res) => {
  const checks = {};
  try { await q('SELECT 1'); checks.database = 'ok'; } catch { checks.database = 'error'; }
  try { await r2.ping(); checks.storage = 'ok'; } catch { checks.storage = 'error'; }
  if (!backup.ENABLED) checks.backup = 'off';
  else { const l = await backup.last().catch(() => null); checks.backup = l && Date.now() - new Date(l.at) < 26 * 3600e3 ? 'ok' : 'stale'; }
  const status = checks.database !== 'ok' || checks.storage !== 'ok' ? 'error' : checks.backup === 'stale' ? 'warning' : 'ok';
  res.set('Cache-Control', 'no-store').status(status === 'error' ? 503 : 200).json({ status, checks, time: new Date().toISOString() });
}));

// Public settings the pages need before sign-in.
app.get('/api/config', (req, res) => res.json({ demo: demo.ENABLED, landing: LANDING, demo_reset_hour: demo.RESET_HOUR }));
// One click into the shared demo account (only on the demo site).
app.get('/demo', wrap(async (req, res) => {
  if (!demo.ENABLED) return res.redirect('/');
  let u = await demo.demoUser();
  if (!u) { await demo.reset(); u = await demo.demoUser(); }
  if (!u) return res.status(503).send('The demo is being reset. Please try again in a minute.');
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Server error');
    req.session.cookie.maxAge = null; // demo visitors: until the browser closes
    req.session.user = sessionUser(u);
    res.redirect('/');
  });
}));

if (portal.ENABLED) {
  portal.mount(app, { auth, wrap, httpErr, cleanName, loadAcl, log, tooMany, addFail, fails, MAX_BYTES, BASE });
  app.get('/portal', (req, res) => res.sendFile(path.join(PUBLIC, 'portal.html')));
}
app.get('/terms', (req, res) => res.send(legal.terms()));
app.get('/privacy', (req, res) => res.send(legal.privacy()));
// Signed-out visitors see the landing page; signed-in people go straight to their files.
const PUBLIC = path.join(__dirname, '..', 'public');
const landingHtml = fs.readFileSync(path.join(PUBLIC, 'landing.html'), 'utf8').replaceAll('{{BASE}}', BASE);
app.get('/', (req, res) => {
  if (req.session.user?.v === SESSION_V || !LANDING) return res.sendFile(path.join(PUBLIC, 'index.html'));
  res.setHeader('X-Robots-Tag', 'all'); res.type('html').send(landingHtml);
});
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.use(express.static(PUBLIC, { index: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

// ---------- Startup migrations (so updates need no manual SQL) ----------
async function addColumn(table, column, def) {
  const [c] = await q('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [table, column]);
  if (!c) await q(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
async function addIndex(table, name, cols) {
  const [i] = await q('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?', [table, name]);
  if (!i) await q(`ALTER TABLE ${table} ADD INDEX ${name} (${cols})`);
}
async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS purge_queue (
    id INT AUTO_INCREMENT PRIMARY KEY, r2_key VARCHAR(512) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL DEFAULT 0, purge_after DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await q(`CREATE TABLE IF NOT EXISTS folder_access (
    folder_id INT NOT NULL, user_id INT NOT NULL, PRIMARY KEY (folder_id, user_id),
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS file_versions (
    id INT AUTO_INCREMENT PRIMARY KEY, file_id INT NOT NULL, r2_key VARCHAR(512) NOT NULL UNIQUE,
    size BIGINT NOT NULL DEFAULT 0, mime VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    uploaded_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id))`);
  await addColumn('folders', 'restricted', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('files', 'updated_at', 'DATETIME NULL');
  await addColumn('share_links', 'password_hash', 'VARCHAR(255) NULL');
  await addColumn('share_links', 'downloads', 'INT NOT NULL DEFAULT 0');
  await addColumn('users', 'totp_secret', 'VARCHAR(255) NULL');
  await addColumn('users', 'totp_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('users', 'totp_last_step', 'BIGINT NOT NULL DEFAULT 0');
  await q(`CREATE TABLE IF NOT EXISTS backup_codes (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, code_hash CHAR(64) NOT NULL, used_at DATETIME NULL,
    INDEX (user_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS trusted_devices (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (token_hash),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await q('DELETE FROM trusted_devices WHERE expires_at < NOW()');

  // Teams: everything that existed before becomes the first team.
  await q(`CREATE TABLE IF NOT EXISTS teams (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, quota_bytes BIGINT NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await addColumn('users', 'team_id', 'INT NULL');
  await addColumn('users', 'is_owner', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('teams', 'trial_ends_at', 'DATETIME NULL');
  await addColumn('users', 'is_demo', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('files', 'deleted_by', 'INT NULL');
  await addColumn('folders', 'deleted_by', 'INT NULL');
  await q('CREATE TABLE IF NOT EXISTS app_state (k VARCHAR(64) PRIMARY KEY, v TEXT NULL)');
  await addColumn('folders', 'team_id', 'INT NULL');
  await addColumn('files', 'team_id', 'INT NULL');
  await addIndex('users', 'idx_users_team', 'team_id');
  await addIndex('folders', 'idx_folders_team', 'team_id, parent_id');
  await addIndex('files', 'idx_files_team', 'team_id, folder_id');
  const [orphans] = await q('SELECT (SELECT COUNT(*) FROM users WHERE team_id IS NULL) + (SELECT COUNT(*) FROM folders WHERE team_id IS NULL) + (SELECT COUNT(*) FROM files WHERE team_id IS NULL) AS n');
  if (Number(orphans.n) > 0) {
    let [first] = await q('SELECT id FROM teams ORDER BY id LIMIT 1');
    if (!first) first = { id: (await q('INSERT INTO teams (name) VALUES (?)', [process.env.TEAM_NAME || 'My team'])).insertId };
    await q('UPDATE users SET team_id=? WHERE team_id IS NULL', [first.id]);
    await q('UPDATE folders SET team_id=? WHERE team_id IS NULL', [first.id]);
    await q('UPDATE files SET team_id=? WHERE team_id IS NULL', [first.id]);
    console.log(`Moved existing data into team #${first.id}`);
  }
  const [hasOwner] = await q('SELECT id FROM users WHERE is_owner=1 LIMIT 1');
  if (!hasOwner) {
    const [o] = process.env.OWNER_EMAIL
      ? await q('SELECT id, email FROM users WHERE email=?', [process.env.OWNER_EMAIL.toLowerCase()])
      : await q('SELECT id, email FROM users WHERE is_admin=1 ORDER BY id LIMIT 1');
    if (o) { await q('UPDATE users SET is_owner=1, is_admin=1 WHERE id=?', [o.id]); console.log(`TeamDrive owner: ${o.email}`); }
  }
  await q(`CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, team_id INT NOT NULL, user_id INT NULL, action VARCHAR(40) NOT NULL,
    target_type VARCHAR(20) NULL, target_id INT NULL, target_name VARCHAR(255) NULL, detail VARCHAR(500) NULL,
    ip VARCHAR(64) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_activity_team (team_id, id), INDEX idx_activity_user (team_id, user_id, id))`);
  await addColumn('activity_log', 'device', 'VARCHAR(80) NULL');
  await q(`CREATE TABLE IF NOT EXISTS access_requests (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(200) NOT NULL, company VARCHAR(160) NOT NULL,
    team_size VARCHAR(40) NOT NULL, message TEXT NULL, ip VARCHAR(64) NULL, handled_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await addColumn('access_requests', 'hosting', 'VARCHAR(60) NULL');
  if (portal.ENABLED) await portal.migrate();
}

migrate()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => console.log(`TeamDrive on :${process.env.PORT || 3000}`));
    runPurge();
    setInterval(runPurge, 60 * 60 * 1000).unref();
    demo.schedule();
    backup.schedule();
  })
  .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
