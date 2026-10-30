# TeamDrive — simple team file service

Login, folders, drag-and-drop uploads (straight to Cloudflare R2), downloads, rename, search, Trash with restore, expiring share links, and an admin page for team members.

## 1. Cloudflare R2
1. Create bucket `teamdrive`.
2. R2 → Manage API tokens → create a token with **Object Read & Write** on that bucket. Copy Access Key ID, Secret, and your Account ID.
3. Bucket → Settings → **CORS policy** (needed for browser uploads):
```json
[{"AllowedOrigins":["https://files.yourdomain.com"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]
```

## 2. Hostinger
1. hPanel → Databases → create MySQL database + user. Open phpMyAdmin and run `schema.sql`.
2. hPanel → Websites → **Node.js app** (Business plan): upload this folder (zip), entry file `src/server.js`, Node 18+.
3. Copy `.env.example` to `.env` and fill in DB, R2, `APP_URL`, a long random `SESSION_SECRET`, and set `NODE_ENV=production`.
4. Run `npm install`, then create yourself as admin:
```
npm run create-user -- you@equawire.com "Nazmul" "a-strong-password" --admin
```
5. Start the app and open your domain. Add teammates from the **Users** tab.

## Notes
- Files never pass through Hostinger — the browser uploads directly to R2 with a 1-hour signed URL, so large files work on shared hosting.
- Delete = moves to Trash. Only admins can "Delete forever". The stored object stays in R2 for 30 days (`PURGE_DAYS` in `.env`) and is listed in the `purge_queue` table, so it can still be recovered; an hourly job then erases it.
- Login is rate-limited: 5 wrong passwords per email (20 per IP) locks out for 15 minutes.
- Everyone can change their password (Password button); admins can reset anyone's from the Users tab.
- Files and folders can be moved with the Move button.
- Share links are public download links; default expiry 7 days, 0 = never.
- Everyone on the team can see all files (MVP). Per-folder permissions are the next step.
- Backups: schedule a nightly `mysqldump` (hPanel cron) — R2 already holds the files.
