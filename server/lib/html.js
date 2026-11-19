// Server-rendered pages. Every value that reaches a page goes through esc().

function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BRAND = '<a class="brand" href="/" aria-label="AT Legacy Services, home"><img src="/favicon.svg" alt="" width="44" height="44"><span class="brand-text" aria-hidden="true"><span class="brand-name">AT LEGACY</span><span class="brand-sub">SERVICES</span></span></a>';

function page({ title, heading, intro = "", body, nav = "", wide = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | AT Legacy Services</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#13283A">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="quote-head">
    ${BRAND}
    ${nav}
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

module.exports = { esc, page, briefHtml, formatDate };
