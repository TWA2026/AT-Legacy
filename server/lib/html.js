// Server-rendered pages. Every value that reaches a page goes through esc().

const path = require("node:path");
const { fingerprint } = require("./stamp");

// Each file's address carries a fingerprint of its contents (see stamp.js).
const SITE_DIR = path.join(__dirname, "..", "..", "site");
const stamped = (file) => "/" + file + "?v=" + fingerprint(SITE_DIR, file);

const STYLES = stamped("styles.css");
const SCRIPT = stamped("app.js");

function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BRAND = '<a class="brand" href="/" aria-label="AT Legacy Services, home"><img src="/favicon.svg" alt="" width="44" height="44"><span class="brand-text" aria-hidden="true"><span class="brand-name">AT LEGACY</span><span class="brand-sub">SERVICES</span></span></a>';

// `scripts` names more files from site/ for the page to load, such as uploads.js.
function page({ title, heading, intro = "", body, wide = false, scripts = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | AT Legacy Services</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#13283A">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${STYLES}">
  <script src="${SCRIPT}" defer></script>${scripts.map((file) => `
  <script src="${stamped(file)}" defer></script>`).join("")}
</head>
<body>
  <header class="quote-head">
    ${BRAND}
    <h1>${esc(heading)}</h1>
    ${intro ? `<p>${esc(intro)}</p>` : ""}
  </header>
  <main class="quote-main${wide ? " app-wide" : ""}">
${body}
  </main>
  <footer class="quote-foot legal">&copy; 2026 AT Legacy Group LLC. Partner companies are independent. AT Legacy Services is not the contractor on their jobs.</footer>
</body>
</html>`;
}

// The owner's dashboard has its own frame: a gold strip, a compact bar, and tabs.
// It should never be mistaken for a page that customers or companies see.
const OWNER_BRAND = '<a class="brand" href="/admin" aria-label="AT Legacy Services dashboard"><img src="/favicon.svg" alt="" width="36" height="36"><span class="brand-text" aria-hidden="true"><span class="brand-name">AT LEGACY</span><span class="brand-sub">SERVICES</span></span></a>';

function ownerPage({ title, heading, intro = "", body, tabs, current = "", back = null, signOut = false, refreshSeconds = 0 }) {
  const links = tabs.map(([href, label, key]) => `<a href="${href}"${key === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard: ${esc(title)} | AT Legacy Services</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#F2B544">${refreshSeconds ? `
  <meta http-equiv="refresh" content="${Number(refreshSeconds)}">` : ""}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${STYLES}">
  <script src="${SCRIPT}" defer></script>
</head>
<body class="owner">
  <p class="owner-strip"><strong>Owner dashboard</strong> <span>Only you see this</span></p>
  <header class="owner-head">
    ${OWNER_BRAND}
    <nav class="owner-nav" aria-label="Dashboard">${links}${signOut ? '<a href="/admin/logout">Log out</a>' : ""}</nav>
  </header>
  <main class="owner-main">
    ${back ? `<p class="owner-back"><a href="${esc(back.href)}">${esc(back.label)}</a></p>` : ""}
    <h1>${esc(heading)}</h1>
    ${intro ? `<p class="owner-intro">${esc(intro)}</p>` : ""}
${body}
  </main>
  <footer class="quote-foot legal">Owner dashboard for AT Legacy Services. &copy; 2026 AT Legacy Group LLC.</footer>
</body>
</html>`;
}

// The certificate the owner gives an approved company. It stands alone, without the dashboard's frame,
// so it prints or saves as a PDF cleanly.
function certificatePage({ company, service, number, approved, validThrough, back, expired = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Certificate ${esc(number)}: ${esc(company)} | AT Legacy Services</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#13283A">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${STYLES}">
  <script src="${SCRIPT}" defer></script>
</head>
<body class="certificate-page">
  <p class="certificate-actions"><a href="${esc(back)}">Back to the company</a> <button class="secondary" type="button" data-print>Print or save as a PDF</button></p>
  ${expired ? '<p class="certificate-actions certificate-expired">This certificate&rsquo;s date has passed. Record another visit that meets your standard to renew it.</p>' : ""}
  <main class="certificate">
    <p class="lockup">
      <span class="lockup-name">AT LEGACY</span>
      <span class="pinstripe" aria-hidden="true"></span>
      <span class="lockup-sub">SERVICES</span>
    </p>
    <h1>Approved vendor certificate</h1>
    <p class="certificate-line">This certifies that</p>
    <p class="certificate-company">${esc(company)}</p>
    <p class="certificate-line">met the AT Legacy Services standard for <strong>${esc(service)}</strong> at a site visit, and is on our approved vendor list.</p>
    <dl class="certificate-facts">
      <div><dt>Certificate</dt><dd>${esc(number)}</dd></div>
      <div><dt>Approved</dt><dd>${esc(approved)}</dd></div>
      <div><dt>Valid through</dt><dd>${esc(validThrough)}</dd></div>
    </dl>
    <p class="certificate-small">Issued by AT Legacy Group LLC. This is AT Legacy Services&rsquo; own standard. It is not a state license, and it does not guarantee any job.</p>
  </main>
</body>
</html>`;
}

// An invoice or receipt for a finder's fee, as the company sees it. Like the certificate, it stands
// alone so it prints or saves as a PDF cleanly. `body` is built by server/routes/invoice.js.
function invoicePage({ title, heading, number, body, notice = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | AT Legacy Services</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#13283A">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${STYLES}">
  <script src="${SCRIPT}" defer></script>
</head>
<body class="invoice-page">
  ${notice}
  <p class="invoice-actions"><button class="secondary" type="button" data-print>Print or save as a PDF</button></p>
  <main class="invoice">
    <header class="invoice-head">
      <p class="lockup">
        <span class="lockup-name">AT LEGACY</span>
        <span class="pinstripe" aria-hidden="true"></span>
        <span class="lockup-sub">SERVICES</span>
      </p>
      <div class="invoice-title">
        <h1>${esc(heading)}</h1>
        <p class="invoice-number">${esc(number)}</p>
      </div>
    </header>
${body}
  </main>
</body>
</html>`;
}

function briefHtml(request) {
  const brief = request.brief || {};
  const scope = (brief.scope || []).map((item) => `<li>${esc(item)}</li>`).join("");
  const answers = (request.answers || [])
    .filter((item) => item && item.a)
    .map((item) => `<dt>${esc(item.q)}</dt><dd>${esc(item.a)}</dd>`)
    .join("");
  return `<dl class="brief">
      <dt>Service</dt><dd>${esc(request.service)}</dd>
      <dt>Where</dt><dd>${esc(request.location)}</dd>
      <dt>Property</dt><dd>${esc(request.property)}</dd>
      <dt>Timing</dt><dd>${esc(request.timing)}</dd>
      ${request.size ? `<dt>Size or how often</dt><dd>${esc(request.size)}</dd>` : ""}
      <dt>The job</dt><dd>${esc(brief.summary)}${scope ? `<ul class="scope">${scope}</ul>` : ""}</dd>
      ${answers}
    </dl>`;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

// A calendar day stored as 2026-11-20, shown as "Nov 20, 2026". No time zone is involved.
function formatDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!match) return "";
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// "Nov 20, 8:05 AM", in the business's own time zone.
function formatDateTime(value) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

module.exports = { esc, page, ownerPage, certificatePage, invoicePage, briefHtml, formatDate, formatDateTime, formatDay };
