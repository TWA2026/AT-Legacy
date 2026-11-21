// Builds dist/: a static copy of the public pages for Slipway's static hosting.
//
// The pages in site/ are the same ones the hub serves. Here they are copied as plain
// files and told where the hub is (config.js), so the forms can send to it from
// another address. The hub must list that address in SITE_ORIGINS.
//
// Each page's links to the stylesheet and scripts are given a fingerprint, as the hub does.
//
//   HUB_URL=https://hub.example.com node scripts/build-site.js

const fs = require("node:fs");
const path = require("node:path");
const { stampPage } = require("../server/lib/stamp");
const business = require("../server/lib/business");
const { DEFAULT_STANDARD, shownStandard, fillStandardPage } = require("../server/lib/standard");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist");
const hub = String(process.env.HUB_URL || require("../package.json").config.hubUrl || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(hub)) {
  console.error("Set HUB_URL to the hub's address, such as https://hub.example.com");
  process.exit(1);
}

// The standard written into the Our standard page. The hub is asked for the owner's current list;
// if it can't be reached within a few seconds, the list this code ships with is used. Either way
// the page's script swaps in the current list when a visitor opens it.
async function standardToShow() {
  const fallback = shownStandard(DEFAULT_STANDARD);
  try {
    const response = await fetch(hub + "/api/standard", { signal: AbortSignal.timeout(4000) });
    const shown = response.ok ? await response.json() : null;
    const labels = (list) => Array.isArray(list) && list.every((label) => typeof label === "string" && label.length <= 200);
    if (shown && labels(shown.must) && shown.must.length && labels(shown.more) && Number.isInteger(shown.months)) {
      return { shown: { must: shown.must, more: shown.more, months: shown.months }, from: "the hub" };
    }
  } catch (error) {
    // Unreachable or slow: fall through to the list in the code.
  }
  return { shown: fallback, from: "the list in the code" };
}

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, "site"), out, { recursive: true });
  // The dashboard's copy-button script is not part of the public pages.
  fs.rmSync(path.join(out, "app.js"), { force: true });
  fs.writeFileSync(path.join(out, "config.js"), "window.ATL_API = " + JSON.stringify(hub) + ";\n");
  // Each page is filled from business.json (phone, About, and so on) and with the standard, then its files are fingerprinted.
  const details = business.load();
  const standard = await standardToShow();
  for (const file of fs.readdirSync(out).filter((name) => name.endsWith(".html"))) {
    const filled = fillStandardPage(business.fill(fs.readFileSync(path.join(out, file), "utf8"), details), standard.shown);
    fs.writeFileSync(path.join(out, file), stampPage(filled, out));
  }
  console.log("Built dist/ with the request API at " + hub + " and the standard from " + standard.from);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
