// Terms of Service and Privacy Policy pages (/terms, /privacy).
// Business details come from .env so they can be updated (e.g. after incorporation) without code changes.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cfg = () => ({
  name: process.env.LEGAL_NAME || 'Equawire',
  operator: process.env.LEGAL_OPERATOR || 'Equawire, operated by Nazmul, Ontario, Canada',
  email: process.env.LEGAL_EMAIL || 'privacy@equawire.com',
  updated: process.env.LEGAL_UPDATED || 'October 30, 2026',
  url: process.env.APP_URL || '',
});

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · TeamDrive</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--mute:#6b7280;--line:#e5e7eb;--acc:#2f6bff}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#e8eaf0;--mute:#9aa1ad;--line:#2a2e38;--acc:#5b8cff}}
*{box-sizing:border-box}body{margin:0;font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header a{color:var(--acc);text-decoration:none;font-size:14px}header b{font-size:17px;margin-right:auto}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px clamp(18px,4vw,40px)}
h1{font-size:28px;line-height:1.2;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px}h3{font-size:16px;margin:20px 0 6px}
.meta{color:var(--mute);font-size:14px;margin:0 0 20px}.summary{background:var(--bg);border-radius:10px;padding:14px 18px;margin:16px 0 8px}
.summary ul{margin:6px 0 0;padding-left:20px}li{margin:4px 0}a{color:var(--acc)}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}td,th{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--bg)}
.wrap{overflow-x:auto}footer{color:var(--mute);font-size:13px;text-align:center;margin-top:20px}
</style></head><body><header><b>TeamDrive</b><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/">Sign in</a></header>
<main><article>${body}</article><footer>© ${new Date().getFullYear()} ${esc(cfg().name)}</footer></main></body></html>`;

function terms() {
  const c = cfg();
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return shell('Terms of Service', `
<h1>Terms of Service</h1>
<p class="meta">Last updated: ${esc(c.updated)}</p>

<div class="summary"><b>The short version</b>
<ul>
<li>Your organization owns its files. We only store and handle them to run TeamDrive for you.</li>
<li>Don't use TeamDrive for anything illegal or harmful, and don't try to get into another team's data.</li>
<li>Keep your own copies of important files. We work hard to keep TeamDrive running, but we can't promise it will never fail.</li>
<li>If either of us ends the service, you'll have 30 days to download your files before we delete them.</li>
<li>These terms are governed by the laws of Ontario, Canada.</li>
</ul>
<p style="margin:10px 0 0;font-size:14px">This summary is for convenience. The full terms below are what apply.</p></div>

<h2>1. Who we are and who these terms apply to</h2>
<p>TeamDrive is a file storage and sharing service provided by ${esc(c.operator)} ("<b>${esc(c.name)}</b>", "we", "us"). These Terms of Service ("Terms") apply to everyone who signs in to TeamDrive or uses a TeamDrive share link.</p>
<p>TeamDrive is sold to organizations. When an organization (the "<b>Customer</b>") gets a TeamDrive team, the person who accepts these Terms for it confirms they have authority to bind that organization. People the Customer adds to its team ("<b>Members</b>") must also follow these Terms. By signing in or using TeamDrive you agree to these Terms and to our <a href="/privacy">Privacy Policy</a>.</p>

<h2>2. The service</h2>
<p>TeamDrive lets a team upload, organize, preview, version and share files. Each Customer gets its own separate team. Teams cannot see each other's files, members or activity.</p>
<p>We may improve, change or remove features over time. If we remove a feature that a Customer relies on in a significant way, we will give reasonable notice where we can.</p>

<h2>3. Accounts and security</h2>
<ul>
<li>We create a Customer's team and its first administrator. The Customer's administrators ("<b>Admins</b>") then add and remove Members, set folder access, and manage the team.</li>
<li>Each person must use their own account. Keep your password and two-step login codes private. Admins are required to use two-step login.</li>
<li>The Customer is responsible for everything done through its team's accounts, and for removing access for people who should no longer have it.</li>
<li>Tell us right away at ${mail} if you think an account has been used without permission.</li>
</ul>

<h2>4. Your content</h2>
<p>"<b>Content</b>" means the files, file and folder names, and other material your team puts in TeamDrive.</p>
<ul>
<li><b>You own your Content.</b> We do not claim any ownership of it.</li>
<li>You give us permission to store, copy, process, transmit and display your Content only as needed to provide, secure and support TeamDrive for you. For example, we need it to create previews, zip downloads and share links. This permission ends when your Content is deleted from TeamDrive as described in section 10.</li>
<li>We do not sell your Content, use it for advertising, or use it to train artificial intelligence models.</li>
<li>We do not look at your Content except where needed to keep TeamDrive working or secure, when you ask us to (for example for support), or where the law requires it.</li>
<li>You confirm that you have the rights to the Content you upload and share, and that storing and sharing it through TeamDrive doesn't break any law or anyone else's rights.</li>
</ul>

<h2>5. Acceptable use</h2>
<p>You must not use TeamDrive to:</p>
<ul>
<li>store or share anything illegal, including child sexual abuse material, or content that infringes someone's copyright, trademark, privacy or other rights;</li>
<li>distribute malware or phishing material, or use share links to send spam;</li>
<li>harass, threaten or defraud anyone;</li>
<li>try to access another team's data or anyone else's account, get around access controls, two-step login or storage limits, or probe, scan or test TeamDrive's security without our written permission;</li>
<li>overload, disrupt or reverse engineer the service, or resell it without our agreement.</li>
</ul>
<p>If we reasonably believe these rules have been broken, we may remove the Content, disable share links, or suspend accounts or the team. Where it's safe and lawful to do so, we will tell the Customer and give it a chance to fix the problem first. We may report illegal content to the authorities.</p>

<h2>6. Share links</h2>
<p>Anyone who has a share link can download the file it points to, unless the link has a password. You are responsible for who you send links to. You can see and revoke your links at any time on the <i>Shared links</i> page. Links stop working when they expire, are revoked, or when the file is deleted.</p>

<h2>7. Storage limits and fees</h2>
<ul>
<li>Each team may have a storage limit. Uploads that would go over it are refused until space is freed or the limit is raised.</li>
<li>Fees, billing period and payment terms are those agreed in writing between us and the Customer (for example in a quote, order or invoice). Unless stated otherwise, fees do not include taxes such as HST, which will be added where required.</li>
<li>If fees are more than 30 days overdue, we may suspend the team after giving notice. Suspension does not delete your Content.</li>
<li>We will give at least 30 days' notice before changing the fees for an existing Customer.</li>
</ul>

<h2>8. Availability and backups</h2>
<p>We work to keep TeamDrive available and your files safe. Files are stored with an established cloud storage provider, deleted items go to Trash first, and permanently deleted files can usually be recovered for 30 days. However, TeamDrive may sometimes be unavailable, for example during maintenance or when a provider we rely on has an outage. <b>We don't guarantee uninterrupted service unless we've agreed a service level with you in writing. You should keep your own copies of files that are important to you.</b></p>

<h2>9. Confidentiality</h2>
<p>We treat your Content and information about your team as confidential. We only share it with people who need it to provide TeamDrive and who are bound by confidentiality obligations, such as our hosting providers listed in the <a href="/privacy">Privacy Policy</a>, or where the law requires us to.</p>

<h2>10. Ending the service</h2>
<ul>
<li>A Customer may stop using TeamDrive at any time by telling us at ${mail}.</li>
<li>We may end a Customer's service for any reason with 30 days' written notice, or sooner if the Customer seriously or repeatedly breaks these Terms, doesn't pay, or if we're required to by law.</li>
<li>After the service ends, the team is disabled and the Customer has <b>30 days</b> to ask us for access to download its Content (folders can be downloaded as zip files). After that we delete the Content, as described in the <a href="/privacy">Privacy Policy</a>.</li>
<li>Admins can remove Members, and a Member's account ends when it is removed.</li>
</ul>

<h2>11. Disclaimers</h2>
<p>To the extent permitted by law, TeamDrive is provided "as is" and "as available". We make no warranties beyond those stated in these Terms, including implied warranties of merchantability, fitness for a particular purpose or non-infringement. Nothing in these Terms limits any rights you have that cannot be limited under applicable law.</p>

<h2>12. Limitation of liability</h2>
<p>To the extent permitted by law:</p>
<ul>
<li>We are not liable for indirect, incidental, special or consequential losses, or for lost profits, revenue or data, even if we were told they were possible.</li>
<li>Our total liability for all claims relating to TeamDrive is limited to the greater of (a) the fees the Customer paid us for TeamDrive in the 12 months before the event that caused the claim, and (b) CAD $100.</li>
</ul>
<p>These limits do not apply to liability that cannot be limited by law, such as liability for fraud or gross negligence.</p>

<h2>13. Indemnity</h2>
<p>The Customer will compensate us for reasonable losses and costs (including reasonable legal fees) arising from claims by third parties about Content the Customer's team stored or shared, or about the team's breach of section 5.</p>

<h2>14. Changes to these Terms</h2>
<p>We may update these Terms. If a change is material, we will tell Customers' Admins by email or in TeamDrive at least 30 days before it takes effect. If you continue to use TeamDrive after a change takes effect, you accept the updated Terms. If you don't agree, you can end the service as described in section 10.</p>

<h2>15. Governing law</h2>
<p>These Terms are governed by the laws of the Province of Ontario and the federal laws of Canada that apply there. The courts of Ontario, sitting in Toronto, have exclusive jurisdiction over disputes about these Terms, unless the law where you are gives you a right to bring a claim elsewhere.</p>

<h2>16. Other terms</h2>
<ul>
<li>These Terms, the Privacy Policy and any written agreement with a Customer about fees or service levels make up the whole agreement about TeamDrive. If they conflict, the written agreement with the Customer applies.</li>
<li>We may transfer these Terms to a company that takes over TeamDrive, including a corporation formed by ${esc(c.name)}'s owner. We will tell Customers if that happens. Customers may not transfer these Terms without our written consent.</li>
<li>If any part of these Terms can't be enforced, the rest still applies. If we don't enforce a right straight away, we can still enforce it later.</li>
<li>Neither of us is responsible for delays caused by events outside our reasonable control.</li>
</ul>

<h2>17. Contact</h2>
<p>Questions about these Terms: ${mail}.</p>`);
}

function privacy() {
  const c = cfg();
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return shell('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="meta">Last updated: ${esc(c.updated)}</p>

<div class="summary"><b>The short version</b>
<ul>
<li>We collect what's needed to run TeamDrive: your name, email and sign-in details, the files your team uploads, and a record of activity in your team.</li>
<li>We don't sell personal information, show ads, use tracking or analytics cookies, or use your files to train AI.</li>
<li>Your team's Admins can see your team's activity, including when you sign in and what you upload, download or share.</li>
<li>Data is stored with Hostinger (app and database) and Cloudflare (files), and may be processed outside Canada.</li>
<li>You can ask to see, correct or delete your personal information by emailing ${mail}.</li>
</ul></div>

<h2>1. Who is responsible</h2>
<p>TeamDrive is provided by ${esc(c.operator)} ("<b>${esc(c.name)}</b>", "we", "us"). This policy explains how we handle personal information when you use TeamDrive or a TeamDrive share link. It is written to meet Canada's <i>Personal Information Protection and Electronic Documents Act</i> (PIPEDA).</p>
<p><b>Our role.</b> TeamDrive is used by organizations ("<b>Customers</b>"). For the files and other content a Customer stores in TeamDrive, we act on the Customer's behalf and follow its instructions. The Customer decides what is uploaded and who can see it, so questions about that content are best directed to the Customer's administrators ("<b>Admins</b>"). For account, security and service information, we are responsible.</p>
<p><b>Privacy contact.</b> Our privacy contact is responsible for our compliance with this policy and can be reached at ${mail}.</p>

<h2>2. What we collect</h2>
<div class="wrap"><table>
<tr><th>Information</th><th>Examples</th><th>Why</th></tr>
<tr><td>Account details</td><td>Name, email address, role (Admin or Member), team</td><td>To create your account, let you sign in, and show your name to your team</td></tr>
<tr><td>Sign-in and security data</td><td>Password (stored only as a one-way hash), two-step login key (stored encrypted), backup codes and "trusted device" tokens (stored only as hashes)</td><td>To keep your account secure</td></tr>
<tr><td>Content</td><td>Files and their older versions, file and folder names, sizes, types, upload dates, who uploaded them</td><td>To store, organize, preview and share files as your team asks</td></tr>
<tr><td>Sharing data</td><td>Share links you create, their expiry, optional link passwords (stored as hashes), and how many times they were downloaded</td><td>To make share links work and let you manage them</td></tr>
<tr><td>Activity log</td><td>Sign-ins and failed sign-ins, uploads, downloads, renames, moves, deletes, restores, sharing, access and member changes, with the time and IP address</td><td>So your team's Admins can see who did what, and to detect misuse</td></tr>
<tr><td>Technical data</td><td>IP address, browser information and request details in server logs kept by our hosting provider</td><td>To run, secure and troubleshoot the service</td></tr>
<tr><td>Messages to us</td><td>Emails you send us</td><td>To answer you</td></tr>
</table></div>
<p>If you only use a share link, we record the download and your IP address in the sharing team's activity log. We don't ask for your name or email.</p>
<p>We don't collect payment card details through TeamDrive. Billing is handled separately with the Customer.</p>

<h2>3. How we use it</h2>
<p>We use personal information only to:</p>
<ul>
<li>provide TeamDrive, including sign-in, storage, previews, versions, share links and the activity log;</li>
<li>keep TeamDrive and your account secure, for example by limiting sign-in attempts, requiring two-step login for Admins, and investigating misuse;</li>
<li>provide support and contact Admins about the service, such as changes to these policies or security notices;</li>
<li>bill Customers and keep business records;</li>
<li>meet legal obligations.</li>
</ul>
<p>We do <b>not</b> sell or rent personal information, use it for advertising, build marketing profiles, or use your files to train artificial intelligence models. If we ever want to use personal information for a new purpose, we will ask for consent first unless the law allows otherwise.</p>

<h2>4. Who can see your information</h2>
<ul>
<li><b>Your team.</b> Members can see the names of other Members, and the files and folders they have access to, including who uploaded them. Restricted folders are visible only to the people they're shared with and to Admins.</li>
<li><b>Your team's Admins</b> can see the member list (names, emails and whether two-step login is on), all files and folders in the team, all share links, and the full activity log, including sign-in times and IP addresses. Admins can export the activity log.</li>
<li><b>Anyone with a share link</b> can download the file it points to.</li>
<li><b>${esc(c.name)}.</b> We can see team names, Admins' email addresses, member counts and storage use. We access Content or account data only when needed to run or secure the service, when the Customer asks us to (for example for support), or when the law requires it.</li>
<li><b>Other teams</b> cannot see anything about your team.</li>
</ul>

<h2>5. Service providers and where data is stored</h2>
<p>We use these providers to run TeamDrive. They process data only on our instructions and are bound by confidentiality and security obligations:</p>
<div class="wrap"><table>
<tr><th>Provider</th><th>What they do</th></tr>
<tr><td>Hostinger</td><td>Hosts the TeamDrive application and its database (accounts, file and folder details, share links, activity log)</td></tr>
<tr><td>Cloudflare (R2)</td><td>Stores the files themselves and their older versions. Files are encrypted at rest by Cloudflare.</td></tr>
</table></div>
<p>These providers may store and process information <b>outside Canada</b>, including in the United States and the European Union. While it is there, it is subject to the laws of those countries and may be accessible to their courts, law enforcement and national security authorities.</p>
<p>We may also share information if the law requires it (for example a valid court order), to protect people's safety or our legal rights, or as part of a transfer of the TeamDrive business, including to a corporation formed by ${esc(c.name)}'s owner. A new owner would have to protect the information as this policy describes.</p>

<h2>6. Cookies and similar technology</h2>
<p>TeamDrive uses only what it needs to work. We don't use advertising, analytics or tracking cookies.</p>
<div class="wrap"><table>
<tr><th>Name</th><th>Purpose</th><th>How long</th></tr>
<tr><td>Session cookie (<code>connect.sid</code>)</td><td>Keeps you signed in</td><td>Up to 7 days, or until you sign out</td></tr>
<tr><td><code>td_trust</code></td><td>Remembers a device you marked "Trust this device", so you aren't asked for a two-step code each time</td><td>30 days, or until you change your password</td></tr>
<tr><td>Browser storage (<code>td-sort</code>)</td><td>Remembers how you like file lists sorted</td><td>Until you clear your browser data</td></tr>
</table></div>

<h2>7. How long we keep information</h2>
<ul>
<li><b>Files</b> stay until your team deletes them. Deleted items go to Trash. When an Admin deletes them for good, they are removed from TeamDrive straight away and erased from storage after 30 days. Older versions are kept until the file itself is deleted for good.</li>
<li><b>Activity log</b> entries are kept for 12 months, then deleted automatically.</li>
<li><b>Accounts</b> are kept until an Admin removes them or the Customer's service ends.</li>
<li><b>Trusted-device tokens</b> expire after 30 days. Sign-in attempt counters are kept in memory for 15 minutes.</li>
<li><b>When a Customer's service ends,</b> we keep its data for 30 days so it can be downloaded, then delete it. Any backup copies are deleted or overwritten as backups are replaced.</li>
<li>We may keep limited records longer where the law requires, such as billing records for tax purposes.</li>
</ul>

<h2>8. How we protect information</h2>
<p>We use safeguards suited to how sensitive the information is, including:</p>
<ul>
<li>encrypted connections (HTTPS);</li>
<li>passwords stored as one-way hashes, and two-step login keys stored encrypted;</li>
<li>two-step login required for Admins;</li>
<li>limits on repeated sign-in attempts;</li>
<li>strict separation between teams, and access checks on every request;</li>
<li>files encrypted at rest by our storage provider;</li>
<li>short-lived, signed download links.</li>
</ul>
<p>No system is perfectly secure. If a breach of security involving your personal information creates a real risk of significant harm, we will notify you, the affected Customer and the Office of the Privacy Commissioner of Canada as required by law, and keep a record of it.</p>

<h2>9. Your rights and choices</h2>
<ul>
<li><b>Access and correction.</b> You can ask what personal information we hold about you and ask us to correct it. You can change your own password and two-step login settings at any time in TeamDrive.</li>
<li><b>Deletion.</b> You can ask your team's Admin to remove your account, or ask us. Some information, such as entries in your team's activity log, belongs to the Customer's records. We will tell you if we can't delete something and why.</li>
<li><b>Withdrawing consent.</b> You can withdraw consent at any time, subject to legal or contractual limits. If you do, you may no longer be able to use TeamDrive.</li>
</ul>
<p>Email ${mail} to make a request. We may need to confirm your identity first. We will respond within 30 days, or tell you if we need more time as the law allows. If a request concerns a Customer's Content, we may refer you to that Customer or act on its instructions.</p>
<p>If you're not satisfied with our response, you can contact the <a href="https://www.priv.gc.ca/" rel="noopener">Office of the Privacy Commissioner of Canada</a>.</p>

<h2>10. Children</h2>
<p>TeamDrive is a service for organizations and is not intended for children. We do not knowingly collect personal information from children.</p>

<h2>11. Changes to this policy</h2>
<p>We may update this policy. If a change is material, we will tell Customers' Admins by email or in TeamDrive before it takes effect. The date at the top shows when it was last changed.</p>

<h2>12. Contact</h2>
<p>Privacy questions, requests or complaints: ${mail}.</p>`);
}

module.exports = { terms, privacy };
