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
npm run create-user -- you@equawire.com "Your Name" "a-strong-password" --admin
```
5. Start the app and open your domain. Add teammates from the **Users** tab.

## Two ways this app runs

**1. Your demo/marketing site** (e.g. teamdrive.equaflow.io): set `DEMO_MODE=1` (and leave `LANDING_PAGE` unset).
Visitors see the landing page, "Try the live demo" signs them straight into a shared demo team ("Northwind Design (demo)") with sample files, and "Get your own copy" sends you a quote request (shown on your Teams page with their hosting preference).
Demo safeguards: share links, password/two-step changes and member changes are off; uploads are limited to 2 MB and common document/image/media types; the demo team has a 50 MB limit; visitor IP addresses are never stored for demo activity; and everything in the demo team is wiped and re-created every night at `DEMO_RESET_HOUR` (default 3, server time) and on first start. Your own team on the same site is unaffected.

**2. A client's private copy**: a separate install with its own database, R2 bucket (or any S3-compatible storage, e.g. DigitalOcean Spaces in Toronto via `R2_ENDPOINT`), and domain.
- Set `LANDING_PAGE=0` so `/` opens straight to sign-in (no Equawire marketing page), and do **not** set `DEMO_MODE`.
- Create their first admin: `npm run create-user -- admin@client.com "Their Name" "temp-password" --admin --team "Client name"`.
- Set `LEGAL_NAME` / `LEGAL_OPERATOR` / `LEGAL_EMAIL` as agreed with the client, or replace `src/legal.js` with their own terms. Their written agreement with you governs hosting, data location and support.
- For storage outside Cloudflare, set `R2_ENDPOINT` to the provider's S3 endpoint (e.g. `https://tor1.digitaloceanspaces.com`) and use that provider's keys and bucket name.

## Home page and access requests
Signed-out visitors to `/` see a landing page ("TeamDrive by Equawire", `public/landing.html`); signed-in people go straight to their files, and the sign-in form is at `/login`. The *Request access* form saves requests to the `access_requests` table (spam trap + 5 per 15 minutes per network). They appear at the top of the owner's **Teams** page with a one-click *Create team* that pre-fills the form. Requests are deleted after 12 months. No email is sent yet, so check the Teams page (each new request is also printed to the server log).

The headline font (Bricolage Grotesque, SIL Open Font License, see `public/fonts/`) is served from your own server so visitors' browsers never contact Google.

## Backups

The app backs up its database by itself, every night (after `BACKUP_HOUR`, default 2 AM server time) and shortly after start-up if the last backup is more than a day old. Each backup is one compressed SQL file in your storage bucket at `backups/<DB_NAME>/teamdrive-YYYY-MM-DD-HHMM.sql.gz`, kept for `BACKUP_KEEP_DAYS` (default 30; the newest 3 are always kept). It is written in Node, so it works without the `mysqldump` tool.

- **What's covered:** everything in the database — teams, users, folders, file records and versions, share links, two-step login settings, activity log, requests. The files themselves are already in the bucket and are not duplicated. Sign-in sessions are not kept, so after a restore everyone signs in again.
- **See and download backups:** owner → Admin ▾ → Teams → *Database backups* (with **Back up now**).
- **Turn off** (not recommended): `BACKUPS=0`.

### Restoring a backup
1. Stop the app in Hostinger.
2. In the app folder (SSH / terminal), list backups: `npm run restore-backup`
3. Restore the newest: `npm run restore-backup -- latest --yes` (or give a key from the list, or a downloaded `.sql.gz` file).
4. Start the app again. Everyone signs in again.

To practise safely, first create an empty spare database and run the restore with `DB_NAME=<spare> npm run restore-backup -- latest --yes`.

## Search engines

Only the public pages (home, Terms, Privacy) can appear in Google. The app, the API, shared-file links and the demo send `noindex` and are blocked in `/robots.txt`. `/sitemap.xml` lists the public pages; submit `https://<your-domain>/sitemap.xml` in Google Search Console and Bing Webmaster Tools. `APP_URL` must be the exact public address (https, no trailing slash), since it is used for the canonical and sharing tags. Client copies (`LANDING_PAGE=0`) are hidden from search entirely; `SEARCH_INDEXING=0` does the same on any copy.

## Monitoring

`GET /health` returns `{"status":"ok", ...}` when the database and storage are reachable and the last backup is under 26 hours old. It returns `"warning"` if the backup is overdue, and HTTP 503 with `"error"` if the database or storage is down. It reveals nothing about customers' data.

Free setup with UptimeRobot: add a **Keyword** monitor for `https://<your-domain>/health`, keyword `"status":"ok"`, alert when the keyword is **not** found. You'll get an email if the site is down, storage is unreachable, or backups stop.

## Terms of Service and Privacy Policy
Served at `/terms` and `/privacy` and linked from the sign-in page, share-link pages and the account menu. The business name, contact email and date come from `.env` (`LEGAL_NAME`, `LEGAL_OPERATOR`, `LEGAL_EMAIL`, `LEGAL_UPDATED`), so you can update them after incorporating without touching code. The text itself is in `src/legal.js`. If you change how TeamDrive handles data (new providers, analytics, retention), update the policy too.

## Notes
- Files never pass through Hostinger — the browser uploads directly to R2 with a 1-hour signed URL, so large files work on shared hosting.
- Delete = moves to Trash. Only admins can "Delete forever". The stored object stays in R2 for 30 days (`PURGE_DAYS` in `.env`) and is listed in the `purge_queue` table, so it can still be recovered; an hourly job then erases it.
- **Teams (multi-company):** each customer company is a separate team with its own files, members, links, trash and activity. Teams never see each other's data. The TeamDrive **owner** (you) gets a *Teams* tab to create a team with its first admin, set a storage limit, rename it, or disable it (members are signed out, links stop working, files are kept). The owner cannot open other teams' files. Each email belongs to one team.
  - On upgrade, all existing data becomes the first team (named `TEAM_NAME`, default "My team") and the earliest admin becomes the owner — or set `OWNER_EMAIL` before the first start to choose.
  - From the command line: `npm run create-user -- email "Name" password --admin --team "Company"` (creates the team if needed).
- **Activity log:** admins get an *Activity* tab listing sign-ins (including failed ones), uploads, downloads, new versions, renames, moves, deletes, restores, share links (and downloads through them), access changes and member changes — filter by person, type, name or date, and export to CSV. Kept for `ACTIVITY_DAYS` (default 365).
- **Two-step login (authenticator app):** required for admins, optional for members (*Name ▾ → Two-step login*). Set `REQUIRE_2FA` to `all`, `admins` (default) or `none`. Users get 10 backup codes and can tick "Trust this device for 30 days". An admin can reset a member's two-step login from the Users tab if they lose their phone. Secrets are encrypted with `SESSION_SECRET` — **don't change `SESSION_SECRET` later**, or everyone will need their two-step login reset.
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
