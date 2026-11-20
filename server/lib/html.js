// Server-rendered pages. Every value that reaches a page goes through esc().

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Each file's address carries a fingerprint of its contents. When a file changes, its address
// changes, so a browser never pairs a new page with a stylesheet it saved earlier.
function stamped(file) {
  let mark = "0";
  try {
    mark = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "..", "site", file))).digest("hex").slice(0, 10);
  } catch (error) {
    // A missing file still gets an address. The page will simply load without it.
  }
  return "/" + file + "?v=" + mark;
}

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

function page({ title, heading, intro = "", body, wide = false }) {
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

// "Nov 20, 8:05 AM", in the business's own time zone.
function formatDateTime(value) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

module.exports = { esc, page, ownerPage, briefHtml, formatDate, formatDateTime };
