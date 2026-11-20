// Fingerprints for the stylesheet and scripts that pages load.
//
// A file's address carries a short hash of its contents: styles.css?v=1a2b3c4d5e. When the file
// changes, its address changes, so a browser never pairs a new page with a file it saved earlier.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STAMPED = new Set(["styles.css", "app.js", "home.js", "quote.js", "partners.js", "uploads.js", "config.js"]);

function fingerprint(dir, file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex").slice(0, 10);
  } catch (error) {
    // A missing file still gets an address. The page will simply load without it.
    return "0";
  }
}

// Rewrites href="styles.css" and src="quote.js" in a page so each carries its file's fingerprint.
function stampPage(html, dir) {
  return html.replace(/\b(href|src)="(\/?)([\w.-]+\.(?:css|js))"/g, (whole, attribute, slash, file) =>
    STAMPED.has(file) ? `${attribute}="${slash}${file}?v=${fingerprint(dir, file)}"` : whole);
}

module.exports = { fingerprint, stampPage };
