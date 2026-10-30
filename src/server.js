require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const { pool, q } = require('./db');
const r2 = require('./r2');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    store: new MySQLStore({}, pool),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 },
  })
);

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const auth = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Not signed in' }));
const admin = (req, res, next) => (req.session.user?.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));
const cleanName = (s) => String(s || '').replace(/[\/\\\0]/g, '').trim().slice(0, 255);
const idOrNull = (v) => (v === null || v === undefined || v === '' || v === 'root' ? null : Number(v));

// ---------- Auth ----------
// Simple in-memory limiter: 5 failed tries per email+IP, 20 per IP, per 15 minutes.
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function tooMany(key, max) {
  const r = fails.get(key);
  if (!r || r.reset < Date.now()) return false;
  return r.count >= max;
}
function addFail(key) {
  const r = fails.get(key);
  if (!r || r.reset < Date.now()) fails.set(key, { count: 1, reset: Date.now() + WINDOW });
  else r.count++;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of fails) if (r.reset < now) fails.delete(k); }, WINDOW).unref();

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const ipKey = `ip:${req.ip}`, userKey = `u:${req.ip}:${email}`;
  if (tooMany(ipKey, 20) || tooMany(userKey, 5))
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const [u] = await q('SELECT * FROM users WHERE email = ?', [email]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    addFail(ipKey); addFail(userKey);
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  fails.delete(userKey);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin };
    res.json(req.session.user);
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ---------- Users (admin) ----------
app.get('/api/users', auth, admin, wrap(async (req, res) => {
  res.json(await q('SELECT id, email, name, is_admin, created_at FROM users ORDER BY name'));
}));
app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const { email, name, password, is_admin } = req.body;
  if (!email || !name || !password || password.length < 8)
    return res.status(400).json({ error: 'Email, name and a password of 8+ characters are required' });
  const hash = await bcrypt.hash(password, 12);
  await q('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?,?,?,?)',
    [email.toLowerCase(), cleanName(name), hash, is_admin ? 1 : 0]);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap(async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  await q('DELETE FROM users WHERE id = ?', [req.params.id]).catch(() => {
    throw Object.assign(new Error('User owns files; reassign or delete them first'), { status: 400 });
  });
  res.json({ ok: true });
}));

// ---------- Passwords ----------
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  const [u] = await q('SELECT password_hash FROM users WHERE id=?', [req.session.user.id]);
  if (!u || !(await bcrypt.compare(String(current || ''), u.password_hash)))
    return res.status(400).json({ error: 'Current password is wrong' });
  await q('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), req.session.user.id]);
  res.json({ ok: true });
}));
app.post('/api/users/:id/password', auth, admin, wrap(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  await q('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), req.params.id]);
  res.json({ ok: true });
}));

// ---------- Browse ----------
app.get('/api/folders-all', auth, wrap(async (req, res) => {
  res.json(await q('SELECT id, name, parent_id FROM folders WHERE deleted_at IS NULL ORDER BY name'));
}));
app.get('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = idOrNull(req.params.id);
  const where = id === null ? 'IS NULL' : '= ?';
  const p = id === null ? [] : [id];
  const folders = await q(`SELECT f.id, f.name, f.created_at, u.name AS owner FROM folders f JOIN users u ON u.id=f.created_by
    WHERE f.parent_id ${where} AND f.deleted_at IS NULL ORDER BY f.name`, p);
  const files = await q(`SELECT f.id, f.name, f.size, f.mime, f.created_at, u.name AS owner FROM files f JOIN users u ON u.id=f.uploaded_by
    WHERE f.folder_id ${where} AND f.status='ready' AND f.deleted_at IS NULL ORDER BY f.name`, p);
  // breadcrumb trail
  const crumbs = [];
  let cur = id;
  while (cur !== null) {
    const [f] = await q('SELECT id, name, parent_id FROM folders WHERE id = ?', [cur]);
    if (!f) return res.status(404).json({ error: 'Folder not found' });
    crumbs.unshift({ id: f.id, name: f.name });
    cur = f.parent_id;
  }
  res.json({ folders, files, crumbs });
}));

app.get('/api/search', auth, wrap(async (req, res) => {
  const term = `%${String(req.query.q || '').replace(/[%_]/g, '\\$&')}%`;
  res.json({
    folders: await q('SELECT id, name FROM folders WHERE deleted_at IS NULL AND name LIKE ? LIMIT 50', [term]),
    files: await q(`SELECT f.id, f.name, f.size, f.mime, f.created_at, u.name AS owner FROM files f JOIN users u ON u.id=f.uploaded_by
      WHERE f.deleted_at IS NULL AND f.status='ready' AND f.name LIKE ? LIMIT 100`, [term]),
  });
}));

// ---------- Folders ----------
app.post('/api/folders', auth, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  const r = await q('INSERT INTO folders (parent_id, name, created_by) VALUES (?,?,?)',
    [idOrNull(req.body.parent_id), name, req.session.user.id]);
  res.json({ id: r.insertId });
}));
app.patch('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name required' });
    await q('UPDATE folders SET name=? WHERE id=?', [name, id]);
  }
  if (req.body.parent_id !== undefined) {
    const target = idOrNull(req.body.parent_id);
    // Refuse to move a folder into itself or one of its own subfolders.
    for (let cur = target; cur !== null; ) {
      if (cur === id) return res.status(400).json({ error: "Can't move a folder into itself" });
      const [f] = await q('SELECT parent_id FROM folders WHERE id=?', [cur]);
      if (!f) return res.status(400).json({ error: 'Target folder not found' });
      cur = f.parent_id;
    }
    await q('UPDATE folders SET parent_id=? WHERE id=?', [target, id]);
  }
  res.json({ ok: true });
}));
app.delete('/api/folders/:id', auth, wrap(async (req, res) => {
  await q('UPDATE folders SET deleted_at=NOW() WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Files ----------
// Step 1: ask for an upload URL
app.post('/api/files/init', auth, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const size = Number(req.body.size || 0);
  const mime = String(req.body.mime || 'application/octet-stream').slice(0, 255);
  if (!name) return res.status(400).json({ error: 'File name required' });
  if (size > MAX_BYTES) return res.status(400).json({ error: `File exceeds ${process.env.MAX_UPLOAD_MB} MB limit` });
  const key = `files/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  const r = await q('INSERT INTO files (folder_id, name, r2_key, size, mime, uploaded_by) VALUES (?,?,?,?,?,?)',
    [idOrNull(req.body.folder_id), name, key, size, mime, req.session.user.id]);
  res.json({ id: r.insertId, url: await r2.uploadUrl(key, mime) });
}));
// Step 2: confirm after browser PUT finishes
app.post('/api/files/:id/complete', auth, wrap(async (req, res) => {
  const [f] = await q('SELECT * FROM files WHERE id=? AND uploaded_by=?', [req.params.id, req.session.user.id]);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const meta = await r2.head(f.r2_key).catch(() => null);
  if (!meta) return res.status(400).json({ error: 'Upload not found in storage' });
  await q("UPDATE files SET status='ready', size=? WHERE id=?", [meta.ContentLength, f.id]);
  res.json({ ok: true });
}));
app.get('/api/files/:id/download', auth, wrap(async (req, res) => {
  const [f] = await q("SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL", [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.redirect(await r2.downloadUrl(f.r2_key, f.name));
}));
app.patch('/api/files/:id', auth, wrap(async (req, res) => {
  const sets = [], p = [];
  if (req.body.name !== undefined) { const n = cleanName(req.body.name); if (!n) return res.status(400).json({ error: 'Name required' }); sets.push('name=?'); p.push(n); }
  if (req.body.folder_id !== undefined) { sets.push('folder_id=?'); p.push(idOrNull(req.body.folder_id)); }
  if (!sets.length) return res.json({ ok: true });
  await q(`UPDATE files SET ${sets.join(',')} WHERE id=?`, [...p, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/files/:id', auth, wrap(async (req, res) => {
  await q('UPDATE files SET deleted_at=NOW() WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Trash ----------
app.get('/api/trash', auth, wrap(async (req, res) => {
  res.json({
    folders: await q('SELECT id, name, deleted_at FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
    files: await q('SELECT id, name, size, deleted_at FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
  });
}));
app.post('/api/trash/:type/:id/restore', auth, wrap(async (req, res) => {
  const t = req.params.type === 'folder' ? 'folders' : 'files';
  await q(`UPDATE ${t} SET deleted_at=NULL WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));
// Permanent purge is admin-only. Storage objects are kept for PURGE_DAYS before
// being removed from R2, so an accidental "Delete forever" can still be recovered.
const PURGE_DAYS = Number(process.env.PURGE_DAYS || 30);
async function queuePurge(files) {
  for (const f of files)
    await q('INSERT IGNORE INTO purge_queue (r2_key, name, size, purge_after) VALUES (?,?,?, NOW() + INTERVAL ? DAY)',
      [f.r2_key, f.name, f.size, PURGE_DAYS]);
}
app.delete('/api/trash/:type/:id', auth, admin, wrap(async (req, res) => {
  if (req.params.type === 'file') {
    const files = await q('SELECT r2_key, name, size FROM files WHERE id=? AND deleted_at IS NOT NULL', [req.params.id]);
    if (files.length) { await queuePurge(files); await q('DELETE FROM files WHERE id=?', [req.params.id]); }
  } else {
    const ids = [Number(req.params.id)];
    for (let i = 0; i < ids.length; i++)
      (await q('SELECT id FROM folders WHERE parent_id=?', [ids[i]])).forEach((r) => ids.push(r.id));
    await queuePurge(await q('SELECT r2_key, name, size FROM files WHERE folder_id IN (?)', [ids]));
    await q('DELETE FROM folders WHERE id=?', [req.params.id]);
  }
  res.json({ ok: true });
}));

async function runPurge() {
  try {
    const due = await q('SELECT id, r2_key FROM purge_queue WHERE purge_after < NOW() LIMIT 500');
    for (const d of due) {
      await r2.remove(d.r2_key);
      await q('DELETE FROM purge_queue WHERE id=?', [d.id]);
    }
    if (due.length) console.log(`Purged ${due.length} object(s) from storage`);
  } catch (e) { console.error('Purge job failed:', e.message); }
}

// ---------- Share links ----------
app.post('/api/files/:id/share', auth, wrap(async (req, res) => {
  const days = Number(req.body.days || 7);
  const token = crypto.randomBytes(24).toString('hex');
  await q('INSERT INTO share_links (token, file_id, created_by, expires_at) VALUES (?,?,?,?)',
    [token, req.params.id, req.session.user.id, days > 0 ? new Date(Date.now() + days * 864e5) : null]);
  res.json({ url: `${process.env.APP_URL}/s/${token}` });
}));
app.get('/s/:token', wrap(async (req, res) => {
  const [row] = await q(`SELECT f.r2_key, f.name FROM share_links s JOIN files f ON f.id=s.file_id
    WHERE s.token=? AND (s.expires_at IS NULL OR s.expires_at > NOW()) AND f.deleted_at IS NULL AND f.status='ready'`,
    [req.params.token]);
  if (!row) return res.status(404).send('This link has expired or does not exist.');
  res.redirect(await r2.downloadUrl(row.r2_key, row.name));
}));

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

// Create any tables added after the first release, so updates need no manual SQL.
async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS purge_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    r2_key VARCHAR(512) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    purge_after DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

migrate()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => console.log(`TeamDrive on :${process.env.PORT || 3000}`));
    runPurge();
    setInterval(runPurge, 60 * 60 * 1000).unref();
  })
  .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
