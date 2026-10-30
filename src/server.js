require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { pool, q } = require('./db');
const r2 = require('./r2');

const app = express();
app.set('trust proxy', 1);
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

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_MB || 5120) * 1024 * 1024;
const PURGE_DAYS = Number(process.env.PURGE_DAYS || 30);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const auth = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Not signed in' }));
const admin = (req, res, next) => (req.session.user?.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));
const cleanName = (s) => String(s || '').replace(/[\/\\\0]/g, '').trim().slice(0, 255);
const idOrNull = (v) => (v === null || v === undefined || v === '' || v === 'root' ? null : Number(v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// ---------- Access control ----------
// Folders are open to everyone unless marked restricted. A restricted folder (and
// everything inside it) is visible only to admins, its creator, and listed members.
async function loadAcl(user) {
  const folders = await q('SELECT id, parent_id, name, restricted, created_by, deleted_at FROM folders');
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
  return { byId, can, alive, visible, canManage };
}
async function getFile(req, id, extra = "deleted_at IS NULL AND status='ready'") {
  const [f] = await q(`SELECT * FROM files WHERE id=? AND ${extra}`, [id]);
  if (!f) throw httpErr(404, 'File not found');
  const acl = await loadAcl(req.session.user);
  if (!acl.can(f.folder_id) || (extra.includes('deleted_at IS NULL') && !acl.alive(f.folder_id))) throw httpErr(404, 'File not found');
  return f;
}
async function requireFolder(req, id) {
  if (id === null) return null;
  const acl = await loadAcl(req.session.user);
  if (!acl.visible(id)) throw httpErr(404, 'Folder not found');
  return acl;
}

// ---------- Auth ----------
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
    if (err) return res.status(500).json({ error: 'Server error' });
    req.session.user = { id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin };
    res.json(req.session.user);
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  const [u] = await q('SELECT password_hash FROM users WHERE id=?', [req.session.user.id]);
  if (!u || !(await bcrypt.compare(String(current || ''), u.password_hash)))
    return res.status(400).json({ error: 'Current password is wrong' });
  await q('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), req.session.user.id]);
  res.json({ ok: true });
}));

// ---------- Users ----------
app.get('/api/members', auth, wrap(async (req, res) => {
  res.json(await q('SELECT id, name FROM users ORDER BY name'));
}));
app.get('/api/users', auth, admin, wrap(async (req, res) => {
  res.json(await q('SELECT id, email, name, is_admin, created_at FROM users ORDER BY name'));
}));
app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const { email, name, password, is_admin } = req.body;
  if (!email || !name || !password || password.length < 8)
    return res.status(400).json({ error: 'Email, name and a password of 8+ characters are required' });
  await q('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?,?,?,?)',
    [String(email).toLowerCase(), cleanName(name), await bcrypt.hash(password, 12), is_admin ? 1 : 0])
    .catch((e) => { throw e.code === 'ER_DUP_ENTRY' ? httpErr(400, 'That email is already a member') : e; });
  res.json({ ok: true });
}));
app.post('/api/users/:id/password', auth, admin, wrap(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  await q('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap(async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  await q('DELETE FROM users WHERE id = ?', [req.params.id]).catch(() => {
    throw httpErr(400, 'This member has uploaded files or created folders/links, so they cannot be removed. Reset their password instead to block access.');
  });
  res.json({ ok: true });
}));

// ---------- Browse ----------
app.get('/api/stats', auth, wrap(async (req, res) => {
  const [a] = await q("SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM files WHERE status='ready'");
  const [b] = await q('SELECT COALESCE(SUM(size),0) AS bytes FROM file_versions');
  res.json({ files: a.files, bytes: Number(a.bytes) + Number(b.bytes) });
}));

app.get('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = idOrNull(req.params.id);
  const acl = (await requireFolder(req, id)) || (await loadAcl(req.session.user));
  const where = id === null ? 'IS NULL' : '= ?';
  const p = id === null ? [] : [id];
  const folders = (await q(`SELECT f.id, f.name, f.restricted, f.created_at, u.name AS owner FROM folders f JOIN users u ON u.id=f.created_by
    WHERE f.parent_id ${where} AND f.deleted_at IS NULL`, p))
    .filter((f) => acl.can(f.id))
    .map((f) => ({ ...f, restricted: !!f.restricted, can_manage: acl.canManage(f.id) }));
  const files = await q(`SELECT f.id, f.name, f.size, f.mime, f.created_at, COALESCE(f.updated_at, f.created_at) AS updated_at, u.name AS owner,
    (SELECT COUNT(*) FROM file_versions v WHERE v.file_id=f.id) AS versions
    FROM files f JOIN users u ON u.id=f.uploaded_by
    WHERE f.folder_id ${where} AND f.status='ready' AND f.deleted_at IS NULL`, p);
  const crumbs = [];
  for (let c = id; c !== null; ) { const f = acl.byId.get(c); crumbs.unshift({ id: f.id, name: f.name, restricted: !!f.restricted }); c = f.parent_id; }
  res.json({ folders, files, crumbs });
}));

app.get('/api/folders-all', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  res.json([...acl.byId.values()].filter((f) => acl.visible(f.id)).map(({ id, name, parent_id }) => ({ id, name, parent_id })));
}));

app.get('/api/search', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  const term = `%${String(req.query.q || '').replace(/[%_\\]/g, '\\$&')}%`;
  res.json({
    folders: (await q('SELECT id, name, parent_id, restricted, created_at FROM folders WHERE deleted_at IS NULL AND name LIKE ? LIMIT 200', [term]))
      .filter((f) => acl.visible(f.id)).slice(0, 50)
      .map((f) => ({ ...f, restricted: !!f.restricted, can_manage: acl.canManage(f.id) })),
    files: (await q(`SELECT f.id, f.name, f.size, f.mime, f.folder_id, f.created_at, COALESCE(f.updated_at, f.created_at) AS updated_at, u.name AS owner,
      (SELECT COUNT(*) FROM file_versions v WHERE v.file_id=f.id) AS versions
      FROM files f JOIN users u ON u.id=f.uploaded_by
      WHERE f.deleted_at IS NULL AND f.status='ready' AND f.name LIKE ? LIMIT 500`, [term]))
      .filter((f) => acl.visible(f.folder_id)).slice(0, 100),
  });
}));

// ---------- Folders ----------
app.post('/api/folders', auth, wrap(async (req, res) => {
  const name = cleanName(req.body.name);
  const parent = idOrNull(req.body.parent_id);
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  await requireFolder(req, parent);
  const r = await q('INSERT INTO folders (parent_id, name, created_by) VALUES (?,?,?)', [parent, name, req.session.user.id]);
  res.json({ id: r.insertId });
}));

// Find-or-create a chain of folders (used by folder uploads). Body: { parent_id, path: ["a","b"] }
app.post('/api/folders/ensure', auth, wrap(async (req, res) => {
  let parent = idOrNull(req.body.parent_id);
  const acl = (await requireFolder(req, parent)) || (await loadAcl(req.session.user));
  for (const raw of (Array.isArray(req.body.path) ? req.body.path : []).slice(0, 50)) {
    const name = cleanName(raw);
    if (!name) continue;
    const existing = (await q(`SELECT id FROM folders WHERE parent_id ${parent === null ? 'IS NULL' : '= ?'} AND name=? AND deleted_at IS NULL`,
      parent === null ? [name] : [parent, name])).find((f) => acl.can(f.id));
    parent = existing ? existing.id : (await q('INSERT INTO folders (parent_id, name, created_by) VALUES (?,?,?)', [parent, name, req.session.user.id])).insertId;
  }
  res.json({ id: parent });
}));

app.patch('/api/folders/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const acl = await requireFolder(req, id);
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name required' });
    await q('UPDATE folders SET name=? WHERE id=?', [name, id]);
  }
  if (req.body.parent_id !== undefined) {
    const target = idOrNull(req.body.parent_id);
    if (target !== null && !acl.visible(target)) return res.status(400).json({ error: 'Target folder not found' });
    for (let cur = target; cur !== null; cur = acl.byId.get(cur).parent_id)
      if (cur === id) return res.status(400).json({ error: "Can't move a folder into itself" });
    await q('UPDATE folders SET parent_id=? WHERE id=?', [target, id]);
  }
  res.json({ ok: true });
}));
app.delete('/api/folders/:id', auth, wrap(async (req, res) => {
  await requireFolder(req, Number(req.params.id));
  await q('UPDATE folders SET deleted_at=NOW() WHERE id=?', [req.params.id]);
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
      await conn.query('INSERT INTO folder_access (folder_id, user_id) SELECT ?, id FROM users WHERE id IN (?)', [id, ids]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
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
  const files = await q("SELECT name, r2_key, size, folder_id FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id IN (?)", [[...prefixOf.keys()]]);
  const total = files.reduce((s, f) => s + Number(f.size), 0);
  if (total > MAX_ZIP_BYTES) return res.status(400).json({ error: `Folder is larger than the ${process.env.MAX_ZIP_MB || 5120} MB zip limit. Download subfolders instead.` });

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
  await requireFolder(req, folder);
  const [existing] = await q("SELECT id FROM files WHERE folder_id <=> ? AND name=? AND status='ready' AND deleted_at IS NULL LIMIT 1", [folder, name]);
  const key = `files/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  const r = await q('INSERT INTO files (folder_id, name, r2_key, size, mime, uploaded_by) VALUES (?,?,?,?,?,?)',
    [folder, name, key, size, mime, req.session.user.id]);
  res.json({ id: r.insertId, url: await r2.uploadUrl(key, mime), replaces: existing ? existing.id : null });
}));

// After the browser's PUT finishes. Same name in the same folder => becomes a new version.
app.post('/api/files/:id/complete', auth, wrap(async (req, res) => {
  const [f] = await q("SELECT * FROM files WHERE id=? AND uploaded_by=? AND status='pending'", [req.params.id, req.session.user.id]);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const meta = await r2.head(f.r2_key).catch(() => null);
  if (!meta) return res.status(400).json({ error: 'Upload not found in storage' });
  const size = Number(meta.ContentLength ?? f.size);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[old]] = await conn.query(
      "SELECT * FROM files WHERE folder_id <=> ? AND name=? AND status='ready' AND deleted_at IS NULL AND id<>? LIMIT 1 FOR UPDATE",
      [f.folder_id, f.name, f.id]);
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
    res.json({ ok: true, id: old ? old.id : f.id, versioned: !!old });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.get('/api/files/:id/download', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
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
  await getFile(req, req.params.id);
  const sets = [], p = [];
  if (req.body.name !== undefined) {
    const n = cleanName(req.body.name);
    if (!n) return res.status(400).json({ error: 'Name required' });
    sets.push('name=?'); p.push(n);
  }
  if (req.body.folder_id !== undefined) {
    const target = idOrNull(req.body.folder_id);
    await requireFolder(req, target).catch(() => { throw httpErr(400, 'Target folder not found'); });
    sets.push('folder_id=?'); p.push(target);
  }
  if (sets.length) await q(`UPDATE files SET ${sets.join(',')} WHERE id=?`, [...p, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/files/:id', auth, wrap(async (req, res) => {
  await getFile(req, req.params.id);
  await q('UPDATE files SET deleted_at=NOW() WHERE id=?', [req.params.id]);
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
  res.redirect(await r2.downloadUrl(v.r2_key, f.name.replace(/(\.[^.]*)?$/, ` (${stamp})$1`)));
}));
app.post('/api/files/:id/versions/:vid/restore', auth, wrap(async (req, res) => {
  const f = await getFile(req, req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[v]] = await conn.query('SELECT * FROM file_versions WHERE id=? AND file_id=? FOR UPDATE', [req.params.vid, f.id]);
    if (!v) throw httpErr(404, 'Version not found');
    await conn.query('DELETE FROM file_versions WHERE id=?', [v.id]);
    await conn.query('INSERT INTO file_versions (file_id, r2_key, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
      [f.id, f.r2_key, f.size, f.mime, f.uploaded_by, f.updated_at || f.created_at]);
    await conn.query('UPDATE files SET r2_key=?, size=?, mime=?, uploaded_by=?, updated_at=NOW() WHERE id=?',
      [v.r2_key, v.size, v.mime, req.session.user.id, f.id]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  res.json({ ok: true });
}));

// ---------- Trash ----------
app.get('/api/trash', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  res.json({
    folders: (await q('SELECT id, name, deleted_at FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')).filter((f) => acl.can(f.id)),
    files: (await q('SELECT id, name, size, folder_id, deleted_at FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')).filter((f) => acl.can(f.folder_id)),
  });
}));
// If the item's parent folder is still in Trash, restore it to the top level so it doesn't vanish.
app.post('/api/trash/:type/:id/restore', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  let movedToRoot = false;
  if (req.params.type === 'folder') {
    const f = acl.byId.get(Number(req.params.id));
    if (!f || !acl.can(f.id)) throw httpErr(404, 'Not found');
    movedToRoot = f.parent_id !== null && !acl.alive(f.parent_id);
    await q('UPDATE folders SET deleted_at=NULL, parent_id=? WHERE id=?', [movedToRoot ? null : f.parent_id, f.id]);
  } else {
    const [f] = await q('SELECT id, folder_id FROM files WHERE id=?', [req.params.id]);
    if (!f || !acl.can(f.folder_id)) throw httpErr(404, 'Not found');
    movedToRoot = f.folder_id !== null && !acl.alive(f.folder_id);
    await q('UPDATE files SET deleted_at=NULL, folder_id=? WHERE id=?', [movedToRoot ? null : f.folder_id, f.id]);
  }
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
    const [f] = await q('SELECT id FROM files WHERE id=? AND deleted_at IS NOT NULL', [req.params.id]);
    if (f) { await queuePurge([f.id]); await q('DELETE FROM files WHERE id=?', [f.id]); }
  } else {
    const ids = [Number(req.params.id)];
    for (let i = 0; i < ids.length; i++)
      (await q('SELECT id FROM folders WHERE parent_id=?', [ids[i]])).forEach((r) => ids.push(r.id));
    await queuePurge((await q('SELECT id FROM files WHERE folder_id IN (?)', [ids])).map((r) => r.id));
    await q('DELETE FROM folders WHERE id=?', [req.params.id]);
  }
  res.json({ ok: true });
}));

async function runPurge() {
  try {
    const due = await q('SELECT id, r2_key FROM purge_queue WHERE purge_after < NOW() LIMIT 500');
    for (const d of due) { await r2.remove(d.r2_key); await q('DELETE FROM purge_queue WHERE id=?', [d.id]); }
    if (due.length) console.log(`Purged ${due.length} object(s) from storage`);
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
  res.json({ url: `${process.env.APP_URL}/s/${token}` });
}));
app.get('/api/shares', auth, wrap(async (req, res) => {
  const acl = await loadAcl(req.session.user);
  const rows = await q(`SELECT s.id, s.token, s.expires_at, s.created_at, s.downloads, s.created_by, (s.password_hash IS NOT NULL) AS has_password,
      f.id AS file_id, f.name AS file_name, f.folder_id, f.deleted_at, u.name AS creator
    FROM share_links s JOIN files f ON f.id=s.file_id JOIN users u ON u.id=s.created_by
    ${req.session.user.is_admin ? '' : 'WHERE s.created_by=?'} ORDER BY s.created_at DESC`, req.session.user.is_admin ? [] : [req.session.user.id]);
  res.json(rows.filter((r) => acl.can(r.folder_id)).map((r) => ({
    id: r.id, url: `${process.env.APP_URL}/s/${r.token}`, file_id: r.file_id, file_name: r.file_name, creator: r.creator,
    created_at: r.created_at, expires_at: r.expires_at, downloads: r.downloads, has_password: !!r.has_password,
    status: r.deleted_at ? 'file in trash' : r.expires_at && new Date(r.expires_at) < new Date() ? 'expired' : 'active',
  })));
}));
app.delete('/api/shares/:id', auth, wrap(async (req, res) => {
  const [s] = await q('SELECT created_by FROM share_links WHERE id=?', [req.params.id]);
  if (!s || (!req.session.user.is_admin && s.created_by !== req.session.user.id)) throw httpErr(404, 'Link not found');
  await q('DELETE FROM share_links WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// Public link pages
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--mute:#6b7280;--line:#e5e7eb;--acc:#2f6bff;--danger:#d93838}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#e8eaf0;--mute:#9aa1ad;--line:#2a2e38;--acc:#5b8cff}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
.c{max-width:360px;margin:14vh auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px}
input,button{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{background:var(--acc);border-color:var(--acc);color:#fff;cursor:pointer}.m{color:var(--mute);font-size:14px}.e{color:var(--danger);font-size:14px}
</style></head><body><div class="c">${body}</div></body></html>`;
async function shareRow(token) {
  const [row] = await q(`SELECT s.id, s.password_hash, f.r2_key, f.name FROM share_links s JOIN files f ON f.id=s.file_id
    WHERE s.token=? AND (s.expires_at IS NULL OR s.expires_at > NOW()) AND f.deleted_at IS NULL AND f.status='ready'`, [token]);
  return row;
}
const pwForm = (name, err = '') => page('Protected file', `<b>${esc(name)}</b><span class="m">This file is password-protected.</span>
  <form method="post" style="display:grid;gap:10px"><input type="password" name="password" placeholder="Password" required autofocus><button>Download</button></form>
  ${err ? `<span class="e">${esc(err)}</span>` : ''}`);
const gone = () => page('Link unavailable', '<b>Link unavailable</b><span class="m">This link has expired, was revoked, or does not exist.</span>');
app.get('/s/:token', wrap(async (req, res) => {
  const row = await shareRow(req.params.token);
  if (!row) return res.status(404).send(gone());
  if (row.password_hash) return res.send(pwForm(row.name));
  await q('UPDATE share_links SET downloads=downloads+1 WHERE id=?', [row.id]);
  res.redirect(await r2.downloadUrl(row.r2_key, row.name));
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
  await q('UPDATE share_links SET downloads=downloads+1 WHERE id=?', [row.id]);
  res.redirect(303, await r2.downloadUrl(row.r2_key, row.name));
}));

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
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
}

migrate()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => console.log(`TeamDrive on :${process.env.PORT || 3000}`));
    runPurge();
    setInterval(runPurge, 60 * 60 * 1000).unref();
  })
  .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
