// Outgoing email. Set SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465) and
// MAIL_FROM ("TeamDrive <no-reply@equawire.com>"). Without SMTP_URL, emails are only
// written to the server log, and staff can copy invite links from the app instead.
const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'TeamDrive <no-reply@equawire.com>';
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// send({ to, subject, lines: ['paragraph', ...], button: { label, url }, fromName })
async function send({ to, subject, lines = [], button, fromName }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return { sent: false };
  const text = [...lines, button ? `${button.label}: ${button.url}` : ''].filter(Boolean).join('\n\n');
  const html = `<div style="font:16px/1.5 system-ui,sans-serif;color:#16213A;max-width:560px">
${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
${button ? `<p><a href="${esc(button.url)}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${esc(button.label)}</a></p>` : ''}
<p style="color:#5B6475;font-size:13px">This email has a sign-in link only. Your documents are never attached to emails.</p></div>`;
  const from = fromName ? FROM.replace(/^[^<]*</, `${fromName.replace(/[<>"]/g, '')} <`) : FROM;
  if (!transport) {
    console.log(`[mail not configured] to ${recipients.join(', ')}: ${subject}\n${text}`);
    return { sent: false };
  }
  try {
    await transport.sendMail({ from, to: recipients.join(', '), subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error('Email failed:', e.message);
    return { sent: false, error: e.message };
  }
}

module.exports = { send, configured: !!transport };
