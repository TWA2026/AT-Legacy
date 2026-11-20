// Builds dist/: a static copy of the public pages for Slipway's static hosting.
//
// The pages in site/ are the same ones the hub serves. Here they are copied as plain
// files and told where the hub is (config.js), so the forms can send to it from
// another address. The hub must list that address in SITE_ORIGINS.
//
//   HUB_URL=https://hub.example.com node scripts/build-site.js

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist");
const hub = String(process.env.HUB_URL || require("../package.json").config.hubUrl || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(hub)) {
  console.error("Set HUB_URL to the hub's address, such as https://hub.example.com");
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "site"), out, { recursive: true });
// The dashboard's copy-button script is not part of the public pages.
fs.rmSync(path.join(out, "app.js"), { force: true });
fs.writeFileSync(path.join(out, "config.js"), "window.ATL_API = " + JSON.stringify(hub) + ";\n");
console.log("Built dist/ with the request API at " + hub);
