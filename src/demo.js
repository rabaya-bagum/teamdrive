// Public demo (only when DEMO_MODE=1). Never enable this on a client's private copy.
//
// Safeguards, because anyone on the internet can sign in:
//  - share links are off, so nothing can be handed out to people who haven't signed in
//  - uploads are limited to small, common document/image types
//  - accounts can't be changed: no password or two-step changes, no adding/removing members
//  - everything in the demo team is wiped and re-created every night (and on first start)
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('./db');
const r2 = require('./r2');

const ENABLED = ['1', 'true', 'yes'].includes(String(process.env.DEMO_MODE || '').toLowerCase());
const TEAM_NAME = 'Northwind Design (demo)';
const DEMO_EMAIL = 'demo@teamdrive.demo';
const MAX_UPLOAD = 2 * 1024 * 1024;           // 2 MB per file
const QUOTA = 50 * 1024 * 1024;               // 50 MB for the whole demo team
const RESET_HOUR = Number(process.env.DEMO_RESET_HOUR ?? 3); // server local time
const ALLOWED = /\.(pdf|txt|md|csv|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|odt|ods|odp|rtf|mp3|m4a|wav|mp4|mov|webm)$/i;

const notInDemo = (what) => Object.assign(new Error(`${what} is turned off in the public demo. Get your own private copy to use it.`), { status: 403 });

// Express middleware: block account/security changes and sharing for demo users.
function guard(req, res, next) {
  if (!ENABLED || !req.session?.user?.is_demo) return next();
  const p = req.path, m = req.method;
  const blocked =
    (p === '/api/me/password' && 'Changing passwords') ||
    (p.startsWith('/api/2fa/') && 'Two-step login') ||
    (p === '/api/users' && m === 'POST' && 'Adding members') ||
    (/^\/api\/users\/\d+(\/password|\/2fa)?$/.test(p) && m !== 'GET' && 'Changing members') ||
    (/^\/api\/files\/\d+\/share$/.test(p) && 'Share links');
  if (blocked) return next(notInDemo(blocked));
  next();
}

// Called from the upload endpoint for demo users.
function checkUpload(name, size) {
  if (size > MAX_UPLOAD) throw Object.assign(new Error('The public demo accepts files up to 2 MB. Your own copy can take files of up to 2 GB.'), { status: 400 });
  if (!ALLOWED.test(name)) throw Object.assign(new Error('The public demo only accepts common document, image, audio and video files. Your own copy accepts any file type.'), { status: 400 });
}

// ---- Sample content ----
function tinyPng(rgb) {
  // 160x100 solid-colour PNG, built by hand so there are no image dependencies.
  const zlib = require('zlib');
  const w = 160, h = 100;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from(rgb))])));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const text = (s) => Buffer.from(s.trim() + '\n', 'utf8');

const SAMPLE = {
  welcome: text(`
Welcome to the TeamDrive demo!

This is a shared demo team for "Northwind Design", a pretend design agency.
Everything here is sample content, and anything you upload is visible to other
visitors and deleted every night.

Things to try:
- Open "Clients / Northwind": it's a restricted folder, shown with a lock.
- Open "Project brief.txt" and choose Versions to see its earlier version.
- Upload a file, then upload another file with the same name to create a version.
- Drag a whole folder in, or download a folder as a zip.
- Delete something, then restore it from Trash.
- Open Activity to see who did what.

Share links and account settings are turned off in the demo.
Want your own private TeamDrive? Use "Get your own copy" on the home page.`),
  briefV1: text(`
Project brief: Northwind spring campaign (draft)

Goal: refresh the Northwind brand for the spring product launch.
Deliverables: logo refresh, 3 social posts, 1 landing page.
Deadline: TBD`),
  briefV2: text(`
Project brief: Northwind spring campaign

Goal: refresh the Northwind brand for the spring product launch.
Deliverables: logo refresh, 6 social posts, 1 landing page, launch email.
Deadline: March 14
Budget: see "Budget 2027.csv"
Owner: Priya (design), Marcus (copy)`),
  budget: text(`
Item,Owner,Estimate (CAD)
Logo refresh,Priya,2400
Social posts (6),Marcus,1800
Landing page,Priya,3200
Launch email,Marcus,900
Total,,8300`),
  notes: text(`
# Kick-off meeting notes

- Client prefers a warmer palette; keep the navy for headings.
- Marcus to draft three taglines by Friday.
- Priya to share logo sketches in "Clients / Northwind / Brand assets".
- Next check-in: Tuesday 10:00.`),
  invoice: text(`
INVOICE 1042 (sample)
Bill to: Northwind Inc.
Logo refresh ........ 2,400.00
Total (CAD) ......... 2,400.00
This is sample demo content.`),
};

async function put(teamId, folderId, name, body, mime, uploadedBy, daysAgo = 0) {
  const key = `demo/${crypto.randomUUID()}`;
  await r2.put(key, body, mime);
  const when = new Date(Date.now() - daysAgo * 864e5);
  const r = await q("INSERT INTO files (team_id, folder_id, name, r2_key, size, mime, status, uploaded_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'ready',?,?,?)",
    [teamId, folderId, name, key, body.length, mime, uploadedBy, when, when]);
  return r.insertId;
}
async function folder(teamId, parentId, name, by, restricted = 0) {
  return (await q('INSERT INTO folders (team_id, parent_id, name, created_by, restricted) VALUES (?,?,?,?,?)', [teamId, parentId, name, by, restricted])).insertId;
}
async function user(teamId, email, name, password, isAdmin) {
  const [u] = await q('SELECT id FROM users WHERE email=?', [email]);
  const hash = await bcrypt.hash(password, 10);
  if (u) {
    await q('UPDATE users SET team_id=?, name=?, password_hash=?, is_admin=?, is_demo=1, totp_enabled=0, totp_secret=NULL WHERE id=?', [teamId, name, hash, isAdmin ? 1 : 0, u.id]);
    return u.id;
  }
  return (await q('INSERT INTO users (team_id, email, name, password_hash, is_admin, is_demo) VALUES (?,?,?,?,?,1)', [teamId, email, name, hash, isAdmin ? 1 : 0])).insertId;
}

let resetting = false;
async function reset() {
  if (!ENABLED || resetting) return;
  resetting = true;
  try {
    let [team] = await q('SELECT id FROM teams WHERE name=?', [TEAM_NAME]);
    if (!team) team = { id: (await q('INSERT INTO teams (name, quota_bytes) VALUES (?,?)', [TEAM_NAME, QUOTA])).insertId };
    await q('UPDATE teams SET quota_bytes=?, disabled=0, trial_ends_at=NULL WHERE id=?', [QUOTA, team.id]);

    // Wipe: storage objects first, then rows (share links, versions and access rules cascade).
    const keys = [
      ...(await q('SELECT r2_key FROM files WHERE team_id=?', [team.id])),
      ...(await q('SELECT v.r2_key FROM file_versions v JOIN files f ON f.id=v.file_id WHERE f.team_id=?', [team.id])),
    ].map((r) => r.r2_key);
    for (const k of keys) await r2.remove(k).catch(() => {});
    await q('DELETE FROM files WHERE team_id=?', [team.id]);
    await q('UPDATE folders SET parent_id=NULL WHERE team_id=?', [team.id]);
    await q('DELETE FROM folders WHERE team_id=?', [team.id]);
    await q('DELETE FROM activity_log WHERE team_id=?', [team.id]);

    // People
    const you = await user(team.id, DEMO_EMAIL, 'You (demo)', 'demo', true);
    const priya = await user(team.id, 'priya@northwind.demo', 'Priya Shah', crypto.randomBytes(24).toString('hex'), false);
    const marcus = await user(team.id, 'marcus@northwind.demo', 'Marcus Lee', crypto.randomBytes(24).toString('hex'), false);
    await q('DELETE FROM users WHERE team_id=? AND id NOT IN (?)', [team.id, [you, priya, marcus]]).catch(() => {});
    await q('DELETE FROM trusted_devices WHERE user_id IN (?)', [[you, priya, marcus]]);
    await q('DELETE FROM backup_codes WHERE user_id IN (?)', [[you, priya, marcus]]);

    // Folders and files
    const clients = await folder(team.id, null, 'Clients', you);
    const northwind = await folder(team.id, clients, 'Northwind', you, 1);
    await q('INSERT INTO folder_access (folder_id, user_id) VALUES (?,?)', [northwind, priya]);
    const brand = await folder(team.id, northwind, 'Brand assets', priya);
    const marketing = await folder(team.id, null, 'Marketing', marcus);
    await folder(team.id, null, 'Templates', you);

    await put(team.id, null, 'Welcome to the TeamDrive demo.txt', SAMPLE.welcome, 'text/plain', you, 0);
    const brief = await put(team.id, northwind, 'Project brief.txt', SAMPLE.briefV2, 'text/plain', priya, 1);
    const oldKey = `demo/${crypto.randomUUID()}`;
    await r2.put(oldKey, SAMPLE.briefV1, 'text/plain');
    await q('INSERT INTO file_versions (file_id, r2_key, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
      [brief, oldKey, SAMPLE.briefV1.length, 'text/plain', marcus, new Date(Date.now() - 4 * 864e5)]);
    await put(team.id, northwind, 'Budget 2027.csv', SAMPLE.budget, 'text/csv', marcus, 2);
    await put(team.id, northwind, 'Invoice 1042.txt', SAMPLE.invoice, 'text/plain', you, 1);
    await put(team.id, brand, 'Logo colour - navy.png', tinyPng([22, 33, 58]), 'image/png', priya, 3);
    await put(team.id, brand, 'Logo colour - manila.png', tinyPng([243, 201, 105]), 'image/png', priya, 3);
    await put(team.id, marketing, 'Kick-off meeting notes.md', SAMPLE.notes, 'text/markdown', marcus, 5);

    // A little history so the Activity page isn't empty
    const ago = (h) => new Date(Date.now() - h * 3600e3);
    const acts = [
      [marcus, 'upload', 'file', 'Kick-off meeting notes.md', 'in Marketing', 120],
      [priya, 'upload', 'file', 'Logo colour - navy.png', 'in Clients / Northwind / Brand assets', 72],
      [you, 'access_change', 'folder', 'Northwind', 'Restricted to Priya Shah', 50],
      [marcus, 'download', 'file', 'Budget 2027.csv', null, 30],
      [priya, 'new_version', 'file', 'Project brief.txt', 'in Clients / Northwind', 24],
    ];
    for (const [uid, action, type, name, detail, h] of acts)
      await q('INSERT INTO activity_log (team_id, user_id, action, target_type, target_name, detail, created_at) VALUES (?,?,?,?,?,?,?)', [team.id, uid, action, type, name, detail, ago(h)]);

    await q("INSERT INTO app_state (k, v) VALUES ('demo_reset', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [new Date().toISOString()]);
    console.log('Demo reset done');
  } catch (e) {
    console.error('Demo reset failed:', e.message);
  } finally { resetting = false; }
}

// Reset once a day after RESET_HOUR (server local time), and on start-up if never done.
async function schedule() {
  if (!ENABLED) return;
  const check = async () => {
    const [s] = await q("SELECT v FROM app_state WHERE k='demo_reset'");
    const last = s ? new Date(s.v) : null;
    const now = new Date();
    const due = new Date(now); due.setHours(RESET_HOUR, 0, 0, 0);
    if (now < due) due.setDate(due.getDate() - 1); // most recent scheduled time
    if (!last || last < due) await reset();
  };
  await check().catch((e) => console.error('Demo check failed:', e.message));
  setInterval(() => check().catch(() => {}), 10 * 60 * 1000).unref();
}

async function demoUser() {
  const [u] = await q('SELECT u.*, t.name AS team_name, t.disabled AS team_disabled FROM users u JOIN teams t ON t.id=u.team_id WHERE u.email=?', [DEMO_EMAIL]);
  return u;
}

module.exports = { ENABLED, guard, checkUpload, reset, schedule, demoUser, RESET_HOUR };
