# TeamDrive — simple team file service

Login, folders, drag-and-drop uploads of files *and whole folders* (straight to Cloudflare R2), in-browser previews, download-folder-as-zip, file versions, restricted folders, sortable lists with storage usage, Trash with restore, expiring/password-protected share links you can manage and revoke, and an admin page for team members.

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
- **Restricted folders:** folders are open to the whole team by default. An admin or the folder's creator can use ⋯ → *Restrict access* to limit a folder (and everything inside it) to chosen members. Admins always have access.
- **Versions:** uploading a file with the same name into the same folder saves it as a new version. ⋯ → *Versions* lets you download or restore older copies.
- **Previews:** images, PDFs, video, audio and text open in the browser. HTML and code files are shown as plain text, never run.
- **Download zip:** folders download as a zip streamed through the server (limit `MAX_ZIP_MB`, default 5120). Very large folders on shared hosting may be slow; download subfolders instead.
- **Share links:** optional password and expiry. The *Shared links* tab lists links with download counts and lets you revoke them (admins see all links).
- **Updates:** new tables and columns are added automatically when the app starts — just redeploy.
- Backups: schedule a nightly `mysqldump` (hPanel cron) — R2 already holds the files.
