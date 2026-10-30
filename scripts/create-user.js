// Usage: npm run create-user -- email@x.com "Full Name" password [--admin] [--owner] [--team "Team name"]
// Without --team the user joins the first team (created as "My team" on a fresh install).
// The first admin created on a fresh install automatically becomes the TeamDrive owner.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, q } = require('../src/db');

(async () => {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const teamName = opt('--team');
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--team');
  const [email, name, password] = positional;
  const isAdmin = flag('--admin') || flag('--owner');
  if (!email || !name || !password) {
    console.log('Usage: npm run create-user -- email "Name" password [--admin] [--owner] [--team "Team name"]');
    process.exit(1);
  }
  let team;
  if (teamName) {
    [team] = await q('SELECT id, name FROM teams WHERE name=?', [teamName]);
    if (!team) team = { id: (await q('INSERT INTO teams (name) VALUES (?)', [teamName])).insertId, name: teamName };
  } else {
    [team] = await q('SELECT id, name FROM teams ORDER BY id LIMIT 1');
    if (!team) team = { id: (await q("INSERT INTO teams (name) VALUES ('My team')")).insertId, name: 'My team' };
  }
  const [anyOwner] = await q('SELECT id FROM users WHERE is_owner=1 LIMIT 1');
  const isOwner = flag('--owner') || (isAdmin && !anyOwner);
  await q('INSERT INTO users (team_id, email, name, password_hash, is_admin, is_owner) VALUES (?,?,?,?,?,?)',
    [team.id, email.toLowerCase(), name, await bcrypt.hash(password, 12), isAdmin ? 1 : 0, isOwner ? 1 : 0]);
  console.log(`Created ${isOwner ? 'owner' : isAdmin ? 'admin' : 'user'} ${email} in team "${team.name}"`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
