// Restore the database from a backup.
//
//   npm run restore-backup                         list available backups
//   npm run restore-backup -- latest --yes         restore the newest backup
//   npm run restore-backup -- backups/<DB_NAME>/teamdrive-2026-11-01-0200.sql.gz --yes
//   npm run restore-backup -- ./my-download.sql.gz --yes   (a file you downloaded)
//
// It REPLACES the current database contents (DB_NAME in .env). Stop the app first,
// restore, then start it again. Everyone will need to sign in again afterwards.
// Tip: to test a backup safely, point DB_NAME at an empty spare database first.
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const mysql = require('mysql2/promise');
const r2 = require('../src/r2');
const { PREFIX } = require('../src/backup');

(async () => {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const which = args.find((a) => !a.startsWith('--'));
  const items = (await r2.list(PREFIX).catch(() => [])).filter((o) => o.Key.endsWith('.sql.gz')).sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified) || b.Key.localeCompare(a.Key));

  if (!which) {
    console.log(items.length ? 'Available backups (newest first):' : 'No backups found in storage.');
    for (const o of items.slice(0, 40)) console.log(`  ${o.Key}   ${Math.round(o.Size / 1024)} KB   ${new Date(o.LastModified).toLocaleString()}`);
    console.log('\nRestore one with: npm run restore-backup -- latest --yes   (or give a key or a file path)');
    process.exit(0);
  }

  let gz, label;
  if (fs.existsSync(which)) { gz = fs.readFileSync(which); label = which; }
  else {
    const key = which === 'latest' ? items[0]?.Key : which;
    if (!key) { console.error('No backups found.'); process.exit(1); }
    label = key; gz = await r2.getBuffer(key);
  }
  const sql = zlib.gunzipSync(gz).toString('utf8');
  if (!sql.startsWith('-- TeamDrive database backup')) { console.error('That file is not a TeamDrive backup.'); process.exit(1); }
  const statements = sql.split('\n').filter((l) => l && !l.startsWith('--'));
  const summary = (sql.match(/^-- tables: (.*)$/m) || [])[1];

  console.log(`Backup:   ${label}  (${sql.split('\n')[0].slice(31)})`);
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Contains: ${summary || 'unknown'}`);
  if (!yes) {
    console.log('\nThis will REPLACE everything in that database. Run again with --yes to go ahead.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  let n = 0;
  for (const st of statements) { await conn.query(st); n++; }
  await conn.end();
  console.log(`\nRestored ${n} statements. Start the app again; everyone will need to sign in.`);
})().catch((e) => { console.error('Restore failed:', e.message); process.exit(1); });
