// Daily database backups to R2 (or whatever S3-compatible storage the app uses).
//
// Everything is done in Node, so it works on hosting without the mysqldump tool.
// Output: one gzipped SQL file per backup at backups/teamdrive-YYYY-MM-DD-HHMM.sql.gz.
// Each SQL statement sits on its own line (strings are escaped, so values never
// contain raw newlines), which lets the restore script run it statement by statement.
//
// Files themselves already live in R2 and are not copied; this protects everything
// else: users, teams, folders, file records, versions, share links, activity.
const zlib = require('zlib');
const { pool, q } = require('./db');
const r2 = require('./r2');

// One folder per database, so copies that share a bucket never mix their backups.
const PREFIX = `backups/${(process.env.DB_NAME || 'teamdrive').replace(/[^\w.-]/g, '_')}/`;
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);
const HOUR = Number(process.env.BACKUP_HOUR ?? 2); // server local time
const ENABLED = !['0', 'false', 'no'].includes(String(process.env.BACKUPS ?? '1').toLowerCase());
const SKIP_DATA = new Set(['sessions']); // sign-in sessions: structure only, everyone just signs in again

let running = null;

async function dumpSql() {
  const conn = await pool.getConnection();
  try {
    const out = [];
    const now = new Date().toISOString();
    out.push(`-- TeamDrive database backup, ${now}`);
    out.push('SET FOREIGN_KEY_CHECKS=0;');
    out.push("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';");
    const [tables] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const counts = {};
    for (const { t } of tables) {
      const [[c]] = await conn.query('SHOW CREATE TABLE ??', [t]);
      out.push(`DROP TABLE IF EXISTS ${conn.escapeId(t)};`);
      out.push(c['Create Table'].replace(/\s*\n\s*/g, ' ') + ';');
      counts[t] = 0;
      if (SKIP_DATA.has(t)) continue;
      // Page through rows by primary key order so memory stays small.
      const [cols] = await conn.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [t]);
      const colList = cols.map((x) => conn.escapeId(x.c)).join(',');
      const [pk] = await conn.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION", [t]);
      const order = (pk.length ? pk : cols).map((x) => conn.escapeId(x.c)).join(',');
      for (let offset = 0; ; offset += 500) {
        const [rows] = await conn.query(`SELECT * FROM ${conn.escapeId(t)} ORDER BY ${order} LIMIT 500 OFFSET ${offset}`);
        if (!rows.length) break;
        const values = rows.map((r) => '(' + cols.map((x) => conn.escape(r[x.c])).join(',') + ')').join(',');
        out.push(`INSERT INTO ${conn.escapeId(t)} (${colList}) VALUES ${values};`);
        counts[t] += rows.length;
        if (rows.length < 500) break;
      }
    }
    out.push('SET FOREIGN_KEY_CHECKS=1;');
    out.push(`-- tables: ${JSON.stringify(counts)}`);
    return { sql: out.join('\n') + '\n', counts };
  } finally { conn.release(); }
}

const keyFor = (d = new Date()) => `${PREFIX}teamdrive-${d.toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.sql.gz`;

async function run(reason = 'scheduled') {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const { sql, counts } = await dumpSql();
    const gz = zlib.gzipSync(Buffer.from(sql, 'utf8'), { level: 9 });
    const key = keyFor();
    await r2.put(key, gz, 'application/gzip');
    const info = { key, bytes: gz.length, rows: Object.values(counts).reduce((a, b) => a + b, 0), tables: Object.keys(counts).length, at: new Date().toISOString(), reason, ms: Date.now() - started };
    await q("INSERT INTO app_state (k, v) VALUES ('last_backup', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [JSON.stringify(info)]);
    await prune();
    console.log(`Backup saved: ${key} (${Math.round(gz.length / 1024)} KB, ${info.rows} rows, ${info.ms} ms)`);
    return info;
  })();
  try { return await running; } finally { running = null; }
}

// Delete backups older than KEEP_DAYS, but always keep the newest 3 whatever their age.
async function prune() {
  const all = await list();
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const b of all.slice(3)) if (new Date(b.at) < cutoff) await r2.remove(b.key).catch(() => {});
}

async function list() {
  const items = await r2.list(PREFIX);
  return items
    .filter((o) => o.Key.endsWith('.sql.gz'))
    .map((o) => ({ key: o.Key, bytes: Number(o.Size), at: new Date(o.LastModified).toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

async function last() {
  const [s] = await q("SELECT v FROM app_state WHERE k='last_backup'");
  try { return s ? JSON.parse(s.v) : null; } catch { return null; }
}

// Once a day after HOUR (server time); also right away if there has never been one
// or the last one is more than 26 hours old (e.g. the app was asleep at backup time).
function schedule() {
  if (!ENABLED) { console.log('Backups are turned off (BACKUPS=0)'); return; }
  const check = async () => {
    const l = await last();
    const now = new Date();
    const due = new Date(now); due.setHours(HOUR, 0, 0, 0);
    if (now < due) due.setDate(due.getDate() - 1);
    if (!l || new Date(l.at) < due || Date.now() - new Date(l.at) > 26 * 3600e3) await run('scheduled');
  };
  setTimeout(() => check().catch((e) => console.error('Backup failed:', e.message)), 30 * 1000).unref();
  setInterval(() => check().catch((e) => console.error('Backup failed:', e.message)), 15 * 60 * 1000).unref();
}

module.exports = { run, list, last, schedule, dumpSql, ENABLED, KEEP_DAYS, PREFIX };
