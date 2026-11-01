// Client portal (switch on with PORTAL=1).
//
// A firm (a TeamDrive team) gives each of its clients a private space and asks them for
// documents. Each client space is a restricted folder "Clients / <name>" with two
// subfolders, "From client" and "Shared with client", so staff can also browse it in Files
// and every existing protection (access rules, versions, trash, backups) still applies.
//
// Two kinds of people sign in:
//   staff   - normal TeamDrive users (req.session.user); they may use a client only if they
//             can see that client's folder (admins, its creator, and assigned staff).
//   clients - client_contacts (req.session.contact); every query below is limited to the
//             contact's own client_id AND team_id, on the server.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, q } = require('./db');
const r2 = require('./r2');
const mail = require('./mail');

const ENABLED = ['1', 'true', 'yes'].includes(String(process.env.PORTAL || '').toLowerCase());
const CONTACT_V = 1;
const INVITE_DAYS = 7;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ITEM_STATES = ['waiting', 'submitted', 'changes', 'accepted', 'na'];
const DONE = new Set(['accepted']);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => (!d ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));

async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY, team_id INT NOT NULL, name VARCHAR(255) NOT NULL,
    folder_id INT NOT NULL, inbox_folder_id INT NOT NULL, shared_folder_id INT NOT NULL,
    created_by INT NOT NULL, archived_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_clients_team (team_id))`);
  await q(`CREATE TABLE IF NOT EXISTS client_contacts (
    id INT AUTO_INCREMENT PRIMARY KEY, team_id INT NOT NULL, client_id INT NOT NULL,
    email VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, password_hash VARCHAR(255) NULL,
    invite_hash CHAR(64) NULL, invite_expires DATETIME NULL, disabled TINYINT(1) NOT NULL DEFAULT 0,
    last_login_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_contact_team_email (team_id, email), INDEX (client_id), INDEX (invite_hash),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS requests (
    id INT AUTO_INCREMENT PRIMARY KEY, team_id INT NOT NULL, client_id INT NOT NULL, title VARCHAR(255) NOT NULL,
    due_at DATE NULL, status VARCHAR(16) NOT NULL DEFAULT 'open', created_by INT NOT NULL,
    reminders TINYINT(1) NOT NULL DEFAULT 1, last_reminded_at DATETIME NULL, reminder_count INT NOT NULL DEFAULT 0,
    completed_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_requests_team (team_id, status), INDEX (client_id),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS request_items (
    id INT AUTO_INCREMENT PRIMARY KEY, request_id INT NOT NULL, position INT NOT NULL DEFAULT 0,
    label VARCHAR(255) NOT NULL, note VARCHAR(1000) NULL, status VARCHAR(16) NOT NULL DEFAULT 'waiting',
    na_reason VARCHAR(500) NULL, review_comment VARCHAR(1000) NULL, updated_at DATETIME NULL,
    INDEX (request_id), FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS request_item_files (
    item_id INT NOT NULL, file_id INT NOT NULL, PRIMARY KEY (item_id, file_id),
    FOREIGN KEY (item_id) REFERENCES request_items(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE)`);
  await q(`CREATE TABLE IF NOT EXISTS request_templates (
    id INT AUTO_INCREMENT PRIMARY KEY, team_id INT NOT NULL, name VARCHAR(255) NOT NULL, items TEXT NOT NULL,
    created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (team_id))`);
  // Who really uploaded a file when a client did it (files.uploaded_by must be a staff user).
  const [c] = await q("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='files' AND COLUMN_NAME='contact_id'");
  if (!c) await q('ALTER TABLE files ADD COLUMN contact_id INT NULL');
}

function mount(app, h) {
  const { auth, wrap, httpErr, cleanName, loadAcl, log, tooMany, addFail, fails, MAX_BYTES, BASE } = h;
  const T = (req) => req.session.user.team_id;
  const asDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const link = (path) => `${BASE}${path}`;

  // ---------- staff helpers ----------
  // A client is usable by a staff member only if they can see its folder.
  async function staffClient(req, id) {
    const [c] = await q('SELECT * FROM clients WHERE id=? AND team_id=?', [id, T(req)]);
    if (!c) throw httpErr(404, 'Client not found');
    const acl = await loadAcl(req.session.user);
    if (!acl.visible(c.folder_id)) throw httpErr(404, 'Client not found');
    return c;
  }
  async function staffRequest(req, id) {
    const [r] = await q('SELECT * FROM requests WHERE id=? AND team_id=?', [id, T(req)]);
    if (!r) throw httpErr(404, 'Request not found');
    await staffClient(req, r.client_id);
    return r;
  }
  async function teamName(teamId) { const [t] = await q('SELECT name FROM teams WHERE id=?', [teamId]); return t?.name || 'Your accountant'; }
  // Staff who look after a client: whoever created it plus anyone given access to its folder.
  async function staffEmails(client) {
    const rows = await q(`SELECT DISTINCT u.email FROM users u WHERE u.team_id=? AND (u.id=? OR u.id IN (SELECT user_id FROM folder_access WHERE folder_id=?))`,
      [client.team_id, client.created_by, client.folder_id]);
    return rows.map((r) => r.email);
  }
  async function contactEmails(clientId) {
    return (await q('SELECT email FROM client_contacts WHERE client_id=? AND disabled=0 AND password_hash IS NOT NULL', [clientId])).map((r) => r.email);
  }
  async function requestsWithItems(where, params) {
    const reqs = await q(`SELECT r.*, c.name AS client_name, u.name AS created_by_name FROM requests r
      JOIN clients c ON c.id=r.client_id JOIN users u ON u.id=r.created_by WHERE ${where} ORDER BY r.status='open' DESC, r.due_at IS NULL, r.due_at, r.id DESC`, params);
    if (!reqs.length) return [];
    const items = await q(`SELECT * FROM request_items WHERE request_id IN (?) ORDER BY position, id`, [reqs.map((r) => r.id)]);
    const files = items.length ? await q(`SELECT rif.item_id, f.id, f.name, f.size, f.mime, f.updated_at, f.created_at, cc.name AS contact_name
      FROM request_item_files rif JOIN files f ON f.id=rif.file_id LEFT JOIN client_contacts cc ON cc.id=f.contact_id
      WHERE rif.item_id IN (?) AND f.deleted_at IS NULL AND f.status='ready' ORDER BY f.id`, [items.map((i) => i.id)]) : [];
    return reqs.map((r) => {
      const its = items.filter((i) => i.request_id === r.id).map((i) => ({ ...i, files: files.filter((f) => f.item_id === i.id) }));
      return { ...r, due_at: ymd(r.due_at), items: its, done: its.filter((i) => DONE.has(i.status)).length, received: its.filter((i) => i.status !== 'waiting').length, total: its.length };
    });
  }
  async function closeIfDone(r) {
    const [x] = await q(`SELECT COUNT(*) AS open FROM request_items WHERE request_id=? AND status<>'accepted'`, [r.id]);
    if (Number(x.open) === 0 && r.status === 'open') {
      await q("UPDATE requests SET status='complete', completed_at=NOW() WHERE id=?", [r.id]);
      return true;
    }
    return false;
  }
  async function notifyNewRequest(r, client) {
    const firm = await teamName(client.team_id);
    const items = await q('SELECT label FROM request_items WHERE request_id=? ORDER BY position, id', [r.id]);
    return mail.send({
      to: await contactEmails(client.id), fromName: firm,
      subject: `${firm} needs some documents: ${r.title}`,
      lines: [`${firm} has asked you for ${items.length} item${items.length === 1 ? '' : 's'} for "${r.title}"${r.due_at ? `, due ${ymd(r.due_at)}` : ''}:`,
        items.map((i) => `• ${i.label}`).join('\n'), 'Sign in to upload them securely.'],
      button: { label: 'Upload documents', url: link('/portal') },
    });
  }

  // ---------- staff: clients ----------
  app.get('/api/clients', auth, wrap(async (req, res) => {
    const acl = await loadAcl(req.session.user);
    const rows = await q(`SELECT c.*,
        (SELECT COUNT(*) FROM client_contacts k WHERE k.client_id=c.id AND k.disabled=0) AS contacts,
        (SELECT COUNT(*) FROM requests r WHERE r.client_id=c.id AND r.status='open') AS open_requests,
        (SELECT MIN(r.due_at) FROM requests r WHERE r.client_id=c.id AND r.status='open') AS next_due,
        (SELECT MAX(f.created_at) FROM files f WHERE f.folder_id=c.inbox_folder_id AND f.deleted_at IS NULL) AS last_upload
      FROM clients c WHERE c.team_id=? AND c.archived_at IS NULL ORDER BY c.name`, [T(req)]);
    res.json(rows.filter((c) => acl.visible(c.folder_id)));
  }));

  app.post('/api/clients', auth, wrap(async (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Client name is required' });
    const u = req.session.user;
    const conn = await pool.getConnection();
    let client;
    try {
      await conn.beginTransaction();
      let [[top]] = await conn.query("SELECT id FROM folders WHERE team_id=? AND parent_id IS NULL AND name='Clients' AND deleted_at IS NULL LIMIT 1", [u.team_id]);
      if (!top) top = { id: (await conn.query("INSERT INTO folders (team_id, parent_id, name, created_by) VALUES (?, NULL, 'Clients', ?)", [u.team_id, u.id]))[0].insertId };
      const [[dup]] = await conn.query('SELECT id FROM folders WHERE team_id=? AND parent_id=? AND name=? AND deleted_at IS NULL', [u.team_id, top.id, name]);
      if (dup) throw httpErr(400, 'A client with that name already exists');
      const folder = (await conn.query('INSERT INTO folders (team_id, parent_id, name, created_by, restricted) VALUES (?,?,?,?,1)', [u.team_id, top.id, name, u.id]))[0].insertId;
      const inbox = (await conn.query("INSERT INTO folders (team_id, parent_id, name, created_by) VALUES (?,?,'From client',?)", [u.team_id, folder, u.id]))[0].insertId;
      const shared = (await conn.query("INSERT INTO folders (team_id, parent_id, name, created_by) VALUES (?,?,'Shared with client',?)", [u.team_id, folder, u.id]))[0].insertId;
      const staff = [].concat(req.body.staff_ids || []).map(Number).filter(Boolean);
      if (staff.length) {
        const ok = (await conn.query('SELECT id FROM users WHERE team_id=? AND id IN (?)', [u.team_id, staff]))[0].map((r) => r.id);
        for (const id of ok) await conn.query('INSERT IGNORE INTO folder_access (folder_id, user_id) VALUES (?,?)', [folder, id]);
      }
      const id = (await conn.query('INSERT INTO clients (team_id, name, folder_id, inbox_folder_id, shared_folder_id, created_by) VALUES (?,?,?,?,?,?)',
        [u.team_id, name, folder, inbox, shared, u.id]))[0].insertId;
      await conn.commit();
      client = { id, name, folder_id: folder };
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    log(req, 'client_create', { type: 'client', id: client.id, name });
    res.json(client);
  }));

  app.get('/api/clients/:id', auth, wrap(async (req, res) => {
    const c = await staffClient(req, req.params.id);
    const contacts = await q(`SELECT id, name, email, disabled, last_login_at, created_at, password_hash IS NOT NULL AS active,
      invite_expires FROM client_contacts WHERE client_id=? ORDER BY name`, [c.id]);
    const requests = await requestsWithItems('r.client_id=?', [c.id]);
    const shared = await q("SELECT id, name, size, mime, created_at, updated_at FROM files WHERE folder_id=? AND deleted_at IS NULL AND status='ready' ORDER BY name", [c.shared_folder_id]);
    const staff = await q(`SELECT u.id, u.name FROM users u WHERE u.team_id=? AND (u.id=? OR u.id IN (SELECT user_id FROM folder_access WHERE folder_id=?)) ORDER BY u.name`,
      [c.team_id, c.created_by, c.folder_id]);
    res.json({ ...c, contacts, requests, shared, staff, mail_configured: mail.configured });
  }));

  app.patch('/api/clients/:id', auth, wrap(async (req, res) => {
    const c = await staffClient(req, req.params.id);
    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Client name is required' });
      await q('UPDATE clients SET name=? WHERE id=?', [name, c.id]);
      await q('UPDATE folders SET name=? WHERE id=?', [name, c.folder_id]);
    }
    if (req.body.archived !== undefined) await q('UPDATE clients SET archived_at=? WHERE id=?', [req.body.archived ? new Date() : null, c.id]);
    log(req, 'client_update', { type: 'client', id: c.id, name: c.name });
    res.json({ ok: true });
  }));

  // ---------- staff: contacts ----------
  async function issueInvite(contact) {
    const token = crypto.randomBytes(24).toString('base64url');
    await q('UPDATE client_contacts SET invite_hash=?, invite_expires=NOW() + INTERVAL ? DAY WHERE id=?', [sha(token), INVITE_DAYS, contact.id]);
    return link(`/portal#invite=${token}`);
  }
  async function sendInvite(contact, client, url) {
    const firm = await teamName(client.team_id);
    return mail.send({
      to: contact.email, fromName: firm, subject: `${firm} invited you to share documents securely`,
      lines: [`Hi ${contact.name},`, `${firm} uses a secure portal to collect and share documents with you. Choose a password to get started.`,
        `This link works for ${INVITE_DAYS} days.`],
      button: { label: 'Set up your account', url },
    });
  }
  app.post('/api/clients/:id/contacts', auth, wrap(async (req, res) => {
    const c = await staffClient(req, req.params.id);
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = cleanName(req.body.name);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Name and a valid email are required' });
    const [staffDup] = await q('SELECT id FROM users WHERE email=?', [email]);
    if (staffDup) return res.status(400).json({ error: 'That email belongs to a staff account' });
    const r = await q('INSERT INTO client_contacts (team_id, client_id, email, name) VALUES (?,?,?,?)', [c.team_id, c.id, email, name])
      .catch((e) => { throw e.code === 'ER_DUP_ENTRY' ? httpErr(400, 'That email is already a contact for one of your clients') : e; });
    const contact = { id: r.insertId, email, name };
    const url = await issueInvite(contact);
    const sent = await sendInvite(contact, c, url);
    log(req, 'contact_invite', { type: 'client', id: c.id, name: c.name }, `Invited ${name} <${email}>`);
    res.json({ id: contact.id, invite_url: url, emailed: sent.sent });
  }));
  async function staffContact(req, id) {
    const [k] = await q('SELECT * FROM client_contacts WHERE id=? AND team_id=?', [id, T(req)]);
    if (!k) throw httpErr(404, 'Contact not found');
    return { k, c: await staffClient(req, k.client_id) };
  }
  app.post('/api/contacts/:id/invite', auth, wrap(async (req, res) => {
    const { k, c } = await staffContact(req, req.params.id);
    const url = await issueInvite(k);
    const sent = await sendInvite(k, c, url);
    log(req, 'contact_invite', { type: 'client', id: c.id, name: c.name }, `New invite link for ${k.name}`);
    res.json({ invite_url: url, emailed: sent.sent });
  }));
  app.patch('/api/contacts/:id', auth, wrap(async (req, res) => {
    const { k, c } = await staffContact(req, req.params.id);
    if (req.body.disabled !== undefined) await q('UPDATE client_contacts SET disabled=? WHERE id=?', [req.body.disabled ? 1 : 0, k.id]);
    log(req, req.body.disabled ? 'contact_disable' : 'contact_enable', { type: 'client', id: c.id, name: c.name }, k.name);
    res.json({ ok: true });
  }));

  // ---------- staff: requests ----------
  const cleanItems = (items) => [].concat(items || []).map((i) => ({
    label: cleanName(typeof i === 'string' ? i : i.label), note: String((typeof i === 'object' && i.note) || '').trim().slice(0, 1000) || null,
  })).filter((i) => i.label).slice(0, 100);

  app.post('/api/clients/:id/requests', auth, wrap(async (req, res) => {
    const c = await staffClient(req, req.params.id);
    const title = cleanName(req.body.title);
    const items = cleanItems(req.body.items);
    if (!title) return res.status(400).json({ error: 'Give the request a title' });
    if (!items.length) return res.status(400).json({ error: 'Add at least one item' });
    const conn = await pool.getConnection();
    let id;
    try {
      await conn.beginTransaction();
      id = (await conn.query('INSERT INTO requests (team_id, client_id, title, due_at, created_by, reminders) VALUES (?,?,?,?,?,?)',
        [c.team_id, c.id, title, asDate(req.body.due_at), req.session.user.id, req.body.reminders === false ? 0 : 1]))[0].insertId;
      for (const [n, i] of items.entries()) await conn.query('INSERT INTO request_items (request_id, position, label, note) VALUES (?,?,?,?)', [id, n, i.label, i.note]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    const [r] = await q('SELECT * FROM requests WHERE id=?', [id]);
    const sent = await notifyNewRequest(r, c);
    log(req, 'request_send', { type: 'client', id: c.id, name: c.name }, `${title} (${items.length} item${items.length === 1 ? '' : 's'})`);
    res.json({ id, emailed: sent.sent });
  }));

  // Status board: every request this person can see.
  app.get('/api/requests', auth, wrap(async (req, res) => {
    const acl = await loadAcl(req.session.user);
    const status = ['open', 'complete', 'cancelled'].includes(req.query.status) ? req.query.status : 'open';
    const all = await requestsWithItems('r.team_id=? AND r.status=?', [T(req), status]);
    const folders = new Map((await q('SELECT id, folder_id FROM clients WHERE team_id=?', [T(req)])).map((c) => [c.id, c.folder_id]));
    res.json(all.filter((r) => acl.visible(folders.get(r.client_id))).map(({ items, ...r }) => ({ ...r, waiting_review: items.filter((i) => ['submitted', 'na'].includes(i.status)).length })));
  }));

  app.post('/api/requests/:id/cancel', auth, wrap(async (req, res) => {
    const r = await staffRequest(req, req.params.id);
    await q("UPDATE requests SET status='cancelled' WHERE id=? AND status='open'", [r.id]);
    log(req, 'request_cancel', { type: 'client', id: r.client_id, name: r.title });
    res.json({ ok: true });
  }));
  app.post('/api/requests/:id/remind', auth, wrap(async (req, res) => {
    const r = await staffRequest(req, req.params.id);
    if (r.status !== 'open') return res.status(400).json({ error: 'This request is closed' });
    const sent = await remind(r, true);
    log(req, 'request_remind', { type: 'client', id: r.client_id, name: r.title }, 'Sent by hand');
    res.json({ emailed: sent.sent });
  }));

  app.post('/api/request-items/:id/review', auth, wrap(async (req, res) => {
    const [i] = await q('SELECT * FROM request_items WHERE id=?', [req.params.id]);
    if (!i) return res.status(404).json({ error: 'Item not found' });
    const r = await staffRequest(req, i.request_id);
    if (r.status !== 'open') return res.status(400).json({ error: 'This request is closed' });
    const decision = req.body.decision;
    if (!['accept', 'changes'].includes(decision)) return res.status(400).json({ error: 'Choose accept or changes' });
    if (decision === 'accept' && i.status === 'waiting') return res.status(400).json({ error: 'Nothing has been submitted for this item yet' });
    const comment = String(req.body.comment || '').trim().slice(0, 1000) || null;
    if (decision === 'changes' && !comment) return res.status(400).json({ error: 'Tell the client what to change' });
    await q('UPDATE request_items SET status=?, review_comment=?, updated_at=NOW() WHERE id=?', [decision === 'accept' ? 'accepted' : 'changes', comment, i.id]);
    const [c] = await q('SELECT * FROM clients WHERE id=?', [r.client_id]);
    if (decision === 'changes') {
      const firm = await teamName(c.team_id);
      await mail.send({ to: await contactEmails(c.id), fromName: firm, subject: `${firm} needs a change: ${i.label}`,
        lines: [`${firm} reviewed "${i.label}" for "${r.title}" and needs a change:`, comment], button: { label: 'See the request', url: link('/portal') } });
    }
    const completed = await closeIfDone(r);
    log(req, decision === 'accept' ? 'item_accept' : 'item_changes', { type: 'client', id: c.id, name: c.name }, `${i.label}${comment ? ` – ${comment}` : ''}`);
    if (completed) log(req, 'request_complete', { type: 'client', id: c.id, name: c.name }, r.title);
    res.json({ ok: true, completed });
  }));

  // ---------- staff: templates ----------
  app.get('/api/request-templates', auth, wrap(async (req, res) => {
    const rows = await q('SELECT id, name, items FROM request_templates WHERE team_id=? ORDER BY name', [T(req)]);
    res.json(rows.map((t) => ({ ...t, items: JSON.parse(t.items) })));
  }));
  app.post('/api/request-templates', auth, wrap(async (req, res) => {
    const name = cleanName(req.body.name);
    const items = cleanItems(req.body.items);
    if (!name || !items.length) return res.status(400).json({ error: 'A template needs a name and at least one item' });
    const r = await q('INSERT INTO request_templates (team_id, name, items, created_by) VALUES (?,?,?,?)', [T(req), name, JSON.stringify(items), req.session.user.id]);
    res.json({ id: r.insertId });
  }));
  app.delete('/api/request-templates/:id', auth, wrap(async (req, res) => {
    await q('DELETE FROM request_templates WHERE id=? AND team_id=?', [req.params.id, T(req)]);
    res.json({ ok: true });
  }));

  // ---------- clients (contacts) ----------
  // A contact's session holds only their own id; client and team are re-read every request,
  // so disabling a contact or archiving a client locks them out immediately.
  const contactAuth = wrap(async (req, res, next) => {
    const s = req.session.contact;
    if (!s || s.v !== CONTACT_V) return res.status(401).json({ error: 'Not signed in' });
    const [k] = await q(`SELECT k.*, c.name AS client_name, c.inbox_folder_id, c.shared_folder_id, c.archived_at, t.name AS firm_name, t.disabled AS team_disabled
      FROM client_contacts k JOIN clients c ON c.id=k.client_id JOIN teams t ON t.id=k.team_id WHERE k.id=?`, [s.id]);
    if (!k || k.disabled || k.archived_at || k.team_disabled || !k.password_hash) {
      delete req.session.contact;
      return res.status(401).json({ error: 'Not signed in' });
    }
    req.contact = k;
    next();
  });
  const contactLog = (req, action, detail, name) =>
    log(req, action, { type: 'client', id: req.contact.client_id, name: name || req.contact.client_name }, `${req.contact.name}: ${detail}`, { teamId: req.contact.team_id, userId: null });
  function startContact(req, res, k) {
    // The staff session (if any) is kept separate: a contact session never carries a user.
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      req.session.contact = { id: k.id, v: CONTACT_V };
      q('UPDATE client_contacts SET last_login_at=NOW() WHERE id=?', [k.id]).catch(() => {});
      res.json({ ok: true });
    });
  }

  app.post('/api/portal/login', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const ipKey = `ip:${req.ip}`, key = `pc:${req.ip}:${email}`;
    if (tooMany(ipKey, 20) || tooMany(key, 5)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    const ks = await q(`SELECT k.* FROM client_contacts k JOIN clients c ON c.id=k.client_id JOIN teams t ON t.id=k.team_id
      WHERE k.email=? AND k.disabled=0 AND c.archived_at IS NULL AND t.disabled=0 AND k.password_hash IS NOT NULL`, [email]);
    let match = null;
    for (const k of ks) if (await bcrypt.compare(String(req.body.password || ''), k.password_hash)) { match = k; break; }
    if (!match) { addFail(ipKey); addFail(key); return res.status(401).json({ error: 'Wrong email or password' }); }
    fails.delete(key);
    req.contact = match;
    startContact(req, res, match);
  }));

  app.get('/api/portal/invite', wrap(async (req, res) => {
    const [k] = await q(`SELECT k.name, k.email, t.name AS firm FROM client_contacts k JOIN teams t ON t.id=k.team_id
      WHERE k.invite_hash=? AND k.invite_expires > NOW() AND k.disabled=0`, [sha(req.query.token || '')]);
    if (!k) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
    res.json(k);
  }));
  app.post('/api/portal/invite', wrap(async (req, res) => {
    const pw = String(req.body.password || '');
    if (pw.length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
    const [k] = await q('SELECT * FROM client_contacts WHERE invite_hash=? AND invite_expires > NOW() AND disabled=0', [sha(req.body.token || '')]);
    if (!k) return res.status(404).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
    await q('UPDATE client_contacts SET password_hash=?, invite_hash=NULL, invite_expires=NULL WHERE id=?', [await bcrypt.hash(pw, 12), k.id]);
    req.contact = k;
    log(req, 'contact_join', { type: 'client', id: k.client_id }, `${k.name} set up their account`, { teamId: k.team_id, userId: null });
    startContact(req, res, k);
  }));
  app.post('/api/portal/logout', (req, res) => { delete req.session.contact; res.json({ ok: true }); });

  app.get('/api/portal/me', contactAuth, (req, res) => {
    const k = req.contact;
    res.json({ name: k.name, email: k.email, client: k.client_name, firm: k.firm_name });
  });

  const contactItem = async (req, id) => {
    const [i] = await q(`SELECT i.*, r.title, r.status AS request_status, r.created_by, r.id AS rid FROM request_items i JOIN requests r ON r.id=i.request_id
      WHERE i.id=? AND r.client_id=? AND r.team_id=?`, [id, req.contact.client_id, req.contact.team_id]);
    if (!i) throw httpErr(404, 'Item not found');
    if (i.request_status !== 'open') throw httpErr(400, 'This request is closed');
    return i;
  };
  const strip = ({ created_by, created_by_name, team_id, reminders, last_reminded_at, reminder_count, client_id, client_name, ...r }) => r;

  app.get('/api/portal/requests', contactAuth, wrap(async (req, res) => {
    const reqs = await requestsWithItems("r.client_id=? AND r.team_id=? AND r.status<>'cancelled'", [req.contact.client_id, req.contact.team_id]);
    res.json(reqs.map(strip));
  }));

  app.get('/api/portal/shared', contactAuth, wrap(async (req, res) => {
    res.json(await q("SELECT id, name, size, mime, COALESCE(updated_at, created_at) AS updated_at FROM files WHERE folder_id=? AND team_id=? AND deleted_at IS NULL AND status='ready' ORDER BY name",
      [req.contact.shared_folder_id, req.contact.team_id]));
  }));

  // Upload: same direct-to-storage flow as staff, into the client's "From client" folder.
  app.post('/api/portal/items/:id/upload', contactAuth, wrap(async (req, res) => {
    const i = await contactItem(req, req.params.id);
    if (i.status === 'accepted') return res.status(400).json({ error: 'This item is already accepted' });
    const name = cleanName(req.body.name);
    const size = Number(req.body.size || 0);
    const mime = String(req.body.mime || 'application/octet-stream').slice(0, 255) || 'application/octet-stream';
    if (!name) return res.status(400).json({ error: 'File name required' });
    if (size > MAX_BYTES) return res.status(400).json({ error: 'That file is too large' });
    const [t] = await q('SELECT quota_bytes FROM teams WHERE id=?', [req.contact.team_id]);
    if (t.quota_bytes !== null) {
      const [u] = await q("SELECT COALESCE(SUM(size),0) AS used FROM files WHERE team_id=? AND status='ready'", [req.contact.team_id]);
      if (Number(u.used) + size > Number(t.quota_bytes)) return res.status(400).json({ error: 'The firm\'s storage is full. Please let them know.' });
    }
    const key = `files/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
    const r = await q('INSERT INTO files (team_id, folder_id, name, r2_key, size, mime, uploaded_by, contact_id) VALUES (?,?,?,?,?,?,?,?)',
      [req.contact.team_id, req.contact.inbox_folder_id, name, key, size, mime, i.created_by, req.contact.id]);
    res.json({ id: r.insertId, url: await r2.uploadUrl(key, mime) });
  }));

  app.post('/api/portal/items/:id/complete', contactAuth, wrap(async (req, res) => {
    const i = await contactItem(req, req.params.id);
    const [f] = await q("SELECT * FROM files WHERE id=? AND contact_id=? AND team_id=? AND folder_id=? AND status='pending'",
      [req.body.file_id, req.contact.id, req.contact.team_id, req.contact.inbox_folder_id]);
    if (!f) return res.status(404).json({ error: 'Upload not found' });
    const meta = await r2.head(f.r2_key).catch(() => null);
    if (!meta) return res.status(400).json({ error: 'Upload not found in storage' });
    const size = Number(meta.ContentLength ?? f.size);
    // A file with the same name already in "From client" becomes a new version of it: clients
    // can replace what they sent, but the firm keeps every earlier copy.
    const conn = await pool.getConnection();
    let fileId = f.id;
    try {
      await conn.beginTransaction();
      const [[old]] = await conn.query("SELECT * FROM files WHERE team_id=? AND folder_id=? AND name=? AND status='ready' AND deleted_at IS NULL AND id<>? LIMIT 1 FOR UPDATE",
        [f.team_id, f.folder_id, f.name, f.id]);
      if (old) {
        await conn.query('INSERT INTO file_versions (file_id, r2_key, size, mime, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
          [old.id, old.r2_key, old.size, old.mime, old.uploaded_by, old.updated_at || old.created_at]);
        await conn.query('DELETE FROM files WHERE id=?', [f.id]);
        await conn.query('UPDATE files SET r2_key=?, size=?, mime=?, contact_id=?, updated_at=NOW() WHERE id=?', [f.r2_key, size, f.mime, req.contact.id, old.id]);
        fileId = old.id;
      } else {
        await conn.query("UPDATE files SET status='ready', size=?, updated_at=NOW() WHERE id=?", [size, f.id]);
      }
      await conn.query('INSERT IGNORE INTO request_item_files (item_id, file_id) VALUES (?,?)', [i.id, fileId]);
      await conn.query("UPDATE request_items SET status='submitted', na_reason=NULL, updated_at=NOW() WHERE id=?", [i.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    contactLog(req, 'client_upload', `uploaded ${f.name} for "${i.label}"`);
    await maybeTellStaff(i.rid);
    res.json({ ok: true, id: fileId });
  }));

  app.delete('/api/portal/items/:id/files/:fileId', contactAuth, wrap(async (req, res) => {
    // Detach only: the file stays in the firm's folder (clients never delete what they sent).
    const i = await contactItem(req, req.params.id);
    if (i.status === 'accepted') return res.status(400).json({ error: 'This item is already accepted' });
    await q('DELETE FROM request_item_files WHERE item_id=? AND file_id=?', [i.id, req.params.fileId]);
    const [left] = await q('SELECT COUNT(*) AS n FROM request_item_files WHERE item_id=?', [i.id]);
    if (Number(left.n) === 0) await q("UPDATE request_items SET status='waiting', updated_at=NOW() WHERE id=?", [i.id]);
    contactLog(req, 'client_unlink', `removed a file from "${i.label}"`);
    res.json({ ok: true });
  }));

  app.post('/api/portal/items/:id/na', contactAuth, wrap(async (req, res) => {
    const i = await contactItem(req, req.params.id);
    if (i.status === 'accepted') return res.status(400).json({ error: 'This item is already accepted' });
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Tell your firm why this does not apply' });
    await q("UPDATE request_items SET status='na', na_reason=?, updated_at=NOW() WHERE id=?", [reason, i.id]);
    contactLog(req, 'client_na', `marked "${i.label}" as not applicable – ${reason}`);
    await maybeTellStaff(i.rid);
    res.json({ ok: true });
  }));

  app.get('/api/portal/files/:id/download', contactAuth, wrap(async (req, res) => {
    // Files the firm shared, or files this client uploaded into one of their requests.
    const [f] = await q(`SELECT f.* FROM files f WHERE f.id=? AND f.team_id=? AND f.deleted_at IS NULL AND f.status='ready'
      AND (f.folder_id=? OR (f.folder_id=? AND f.id IN (SELECT rif.file_id FROM request_item_files rif JOIN request_items i ON i.id=rif.item_id
        JOIN requests r ON r.id=i.request_id WHERE r.client_id=?)))`,
    [req.params.id, req.contact.team_id, req.contact.shared_folder_id, req.contact.inbox_folder_id, req.contact.client_id]);
    if (!f) return res.status(404).json({ error: 'File not found' });
    if (f.folder_id === req.contact.shared_folder_id) contactLog(req, 'client_download', `downloaded ${f.name}`);
    res.redirect(await r2.downloadUrl(f.r2_key, f.name));
  }));

  // When every item of a request has an answer, tell the staff it's ready to review.
  async function maybeTellStaff(requestId) {
    const [r] = await q('SELECT * FROM requests WHERE id=?', [requestId]);
    const [x] = await q("SELECT SUM(status='waiting' OR status='changes') AS missing FROM request_items WHERE request_id=?", [r.id]);
    if (Number(x.missing) > 0) return;
    const [c] = await q('SELECT * FROM clients WHERE id=?', [r.client_id]);
    await mail.send({ to: await staffEmails(c), subject: `${c.name} sent everything for "${r.title}"`,
      lines: [`${c.name} has answered every item in "${r.title}". It's ready for you to review.`], button: { label: 'Review in TeamDrive', url: link('/#clients') } });
  }

  // ---------- reminders ----------
  // Before the due date: 3 days before and on the day. After it: every 3 days, at most 6 times.
  async function remind(r, manual = false) {
    const [c] = await q('SELECT * FROM clients WHERE id=?', [r.client_id]);
    const missing = await q("SELECT label, status FROM request_items WHERE request_id=? AND status IN ('waiting','changes') ORDER BY position, id", [r.id]);
    if (!missing.length && !manual) return { sent: false };
    const firm = await teamName(c.team_id);
    const sent = await mail.send({
      to: await contactEmails(c.id), fromName: firm, subject: `Reminder: ${firm} is waiting for documents`,
      lines: [`${firm} is still waiting for ${missing.length} item${missing.length === 1 ? '' : 's'} for "${r.title}"${r.due_at ? ` (due ${ymd(r.due_at)})` : ''}:`,
        missing.map((m) => `• ${m.label}${m.status === 'changes' ? ' (needs a change)' : ''}`).join('\n')],
      button: { label: 'Upload documents', url: link('/portal') },
    });
    await q('UPDATE requests SET last_reminded_at=NOW(), reminder_count=reminder_count+1 WHERE id=?', [r.id]);
    return sent;
  }
  async function runReminders() {
    const due = await q(`SELECT r.* FROM requests r JOIN clients c ON c.id=r.client_id
      WHERE r.status='open' AND r.reminders=1 AND r.due_at IS NOT NULL AND c.archived_at IS NULL AND r.reminder_count < 8
        AND (r.last_reminded_at IS NULL OR r.last_reminded_at < NOW() - INTERVAL 20 HOUR)
        AND (DATEDIFF(r.due_at, CURDATE()) IN (3, 0) OR (DATEDIFF(CURDATE(), r.due_at) > 0 AND MOD(DATEDIFF(CURDATE(), r.due_at), 3) = 0))`);
    for (const r of due) {
      const s = await remind(r).catch((e) => console.error('Reminder failed:', e.message));
      if (s) await q('INSERT INTO activity_log (team_id, user_id, action, target_type, target_id, target_name, detail) VALUES (?,?,?,?,?,?,?)',
        [r.team_id, null, 'request_remind', 'client', r.client_id, r.title, 'Automatic reminder']).catch(() => {});
    }
  }
  setInterval(() => runReminders().catch((e) => console.error('Reminders failed:', e.message)), 15 * 60 * 1000).unref();
  setTimeout(() => runReminders().catch(() => {}), 60 * 1000).unref();

  return { runReminders };
}

module.exports = { ENABLED, migrate, mount, ITEM_STATES };
