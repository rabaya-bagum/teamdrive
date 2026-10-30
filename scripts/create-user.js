// Usage: npm run create-user -- email@x.com "Full Name" password [--admin]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, q } = require('../src/db');

(async () => {
  const [email, name, password] = process.argv.slice(2);
  const isAdmin = process.argv.includes('--admin');
  if (!email || !name || !password) {
    console.log('Usage: npm run create-user -- email "Name" password [--admin]');
    process.exit(1);
  }
  await q('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?,?,?,?)',
    [email.toLowerCase(), name, await bcrypt.hash(password, 12), isAdmin ? 1 : 0]);
  console.log(`Created ${isAdmin ? 'admin' : 'user'} ${email}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
