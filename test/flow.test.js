// End-to-end tests against a real Postgres database.
// Set TEST_DATABASE_URL to a database these tests are allowed to wipe.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPool, migrate, loadSecret } = require("../server/db");
const { createApp, readConfig } = require("../server/app");
const { parseAiBrief } = require("../server/lib/brief");
const { dollarsToCents, formatDollars } = require("../server/lib/validate");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://atl:atl@localhost:5432/atl_test";

const JOB = {
  service: "Fence",
  property: "My home",
  location: "34637",
  timing: "Within a month",
  size: "120 feet, 6 feet tall",
  details: "White vinyl privacy fence along the back and both sides.\nOne gate on the left side.",
  tiers: ["Affordable", "Premium"]
};
const CONTACT = { name: "Dana Customer", phone: "813-555-0100", email: "", contact: "Text" };

let pool;
let secret;
const servers = [];

async function start(env = {}, fetchImpl) {
  const config = readConfig({ ADMIN_PASSWORD: "correct horse", PUBLIC_URL: "https://example.test", ...env });
  const app = createApp({ pool, secret, config, fetchImpl: fetchImpl || (async () => { throw new Error("no network in tests"); }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    get: (path, headers = {}) => fetch(base + path, { redirect: "manual", headers }),
    json: (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    form: (path, fields, headers = {}) => fetch(base + path, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString()
    })
  };
}

async function login(site) {
  const response = await site.form("/admin/login", { password: "correct horse" });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const page = await (await site.get("/admin/partners/new", { cookie })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  return { cookie, csrf };
}

async function createRequest(site, overrides = {}) {
  const response = await site.json("/api/requests", { ...JOB, ...CONTACT, ...overrides });
  assert.equal(response.status, 201);
  const { url } = await response.json();
  // The address is /r/<secret>/<name>. The secret is the part that opens the page.
  const row = (await pool.query("select * from requests where token = $1", [url.split("/")[2]])).rows[0];
  return { url, row };
}

const { itemKey, loadStandard } = require("../server/lib/standard");

// Scorecard boxes are named after each item's wording. These tick the ones named, or every one.
const tick = (...labels) => Object.fromEntries(labels.map((label) => [itemKey(label), "on"]));
const everyItem = async () => tick(...(await loadStandard(pool)).items.map((item) => item.label));

function todayInFlorida() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// An approved partner: paperwork checked, then a site visit that meets the standard.
async function addVerifiedPartner(site, admin, company, tier, trade = "Fence") {
  const response = await site.form("/admin/partners", {
    csrf: admin.csrf, company, contact_name: "Pat Partner", phone: "813-555-0199", email: "pat@example.test",
    trade, tier, status: "applied",
    check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on"
  }, { cookie: admin.cookie });
  assert.equal(response.status, 303);
  const added = (await pool.query("select * from partners where company = $1", [company])).rows[0];
  const visit = await site.form("/admin/partners/" + added.id + "/visit", {
    csrf: admin.csrf, visit_on: todayInFlorida(), place: "A job in Connerton", visit_tier: tier, then: "approve", ...(await everyItem())
  }, { cookie: admin.cookie });
  assert.equal(visit.status, 303);
  const approved = (await pool.query("select * from partners where id = $1", [added.id])).rows[0];
  assert.equal(approved.status, "verified");
  assert.equal(approved.tier, tier);
  return approved;
}

test.before(async () => {
  pool = createPool(DATABASE_URL);
  await pool.query("drop table if exists ratings, messages, request_files, link_events, quotes, requests, partners, settings cascade");
  await migrate(pool);
  await migrate(pool); // safe to repeat
  secret = await loadSecret(pool);
});

test.after(async () => {
  for (const server of servers) server.close();
  await pool.end();
});

test("money parsing and formatting", () => {
  assert.equal(dollarsToCents("$4,950.50"), 495050);
  assert.equal(dollarsToCents("4950"), 495000);
  assert.equal(dollarsToCents("free"), null);
  assert.equal(dollarsToCents("-5"), null);
  assert.equal(dollarsToCents("0"), null);
  assert.equal(formatDollars(495050), "$4,950.50");
  assert.equal(formatDollars(495000), "$4,950");
});

test("the AI reply parser accepts only the expected shape", () => {
  assert.equal(parseAiBrief("not json"), null);
  assert.equal(parseAiBrief('{"summary": 5, "scope": []}'), null);
  assert.equal(parseAiBrief('{"summary": "ok", "scope": []}'), null);
  const parsed = parseAiBrief('Here you go: {"summary": "A fence.", "scope": ["120 ft", 7, "gate"], "questions": ["a", "b", "c", "d"]}');
  assert.deepEqual(parsed.scope, ["120 ft", "gate"]);
  assert.equal(parsed.questions.length, 3);
  assert.equal(parsed.ai, true);
});

test("health check, static site, and 404", async () => {
  const site = await start();
  assert.equal(await (await site.get("/healthz")).text(), "ok");
  const home = await site.get("/");
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /One request\. Three quotes/);
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
  // Pages name their stylesheet and scripts by fingerprint, and browsers check each page again on every visit.
  const mark = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "site", file))).digest("hex").slice(0, 10);
  assert.equal(home.headers.get("cache-control"), "no-cache");
  assert.ok(homeHtml.includes('href="styles.css?v=' + mark("styles.css") + '"'));
  assert.ok(homeHtml.includes('src="home.js?v=' + mark("home.js") + '"'));
  assert.ok(homeHtml.includes('href="fonts/alfa-slab-one-latin-400-normal.woff2"'));
  for (const [address, script] of [["/quote", "quote.js"], ["/quote.html", "quote.js"], ["/partners", "partners.js"], ["/index.html", "home.js"]]) {
    const response = await site.get(address);
    const html = await response.text();
    assert.equal(response.status, 200, address);
    assert.equal(response.headers.get("cache-control"), "no-cache", address);
    assert.ok(html.includes('href="styles.css?v=' + mark("styles.css") + '"'), address);
    assert.ok(html.includes('src="' + script + "?v=" + mark(script) + '"'), address);
  }
  const sheet = await site.get("/styles.css?v=" + mark("styles.css"));
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get("content-type"), /text\/css/);
  const missing = await site.get("/nope");
  assert.equal(missing.headers.get("cache-control"), "no-cache");
  assert.ok((await missing.text()).includes('href="/styles.css?v=' + mark("styles.css") + '"'));
  assert.equal((await site.get("/quote")).status, 200);
  assert.equal((await site.get("/nope")).status, 404);
  assert.equal((await site.get("/r/unknown-token")).status, 404);
  assert.equal((await site.get("/q/unknown-token")).status, 404);
});

test("brief without an AI key is built from the answers", async () => {
  const site = await start();
  const response = await site.json("/api/brief", JOB);
  assert.equal(response.status, 200);
  const { brief, signature } = await response.json();
  assert.equal(brief.ai, false);
  assert.deepEqual(brief.questions, []);
  assert.match(brief.summary, /Fence for my home in 34637/);
  assert.equal(brief.scope[0], "Size or frequency: 120 feet, 6 feet tall");
  assert.ok(signature);
});

test("invalid requests are rejected with a clear message", async () => {
  const site = await start();
  const cases = [
    [{ ...JOB, service: "Rocket repair" }, /valid service/],
    [{ ...JOB, tiers: [] }, /at least one tier/],
    [{ ...JOB, tiers: ["Platinum"] }, /at least one tier/],
    [{ ...JOB, details: "" }, /Job description is required/],
    [{ ...JOB, details: "x".repeat(1001) }, /too long/]
  ];
  for (const [body, pattern] of cases) {
    const response = await site.json("/api/brief", body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, pattern);
  }
  const noEmail = await site.json("/api/requests", { ...JOB, ...CONTACT, contact: "Email" });
  assert.equal(noEmail.status, 400);
  const badJson = await fetch(site.base + "/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(badJson.status, 400);
});

test("a filled honeypot stores nothing", async () => {
  const site = await start();
  const before = (await pool.query("select count(*) from requests")).rows[0].count;
  const response = await site.json("/api/requests", { ...JOB, ...CONTACT, company_url: "http://spam.example" });
  assert.equal(response.status, 200);
  assert.equal((await pool.query("select count(*) from requests")).rows[0].count, before);
});

test("AI review: brief, follow-up questions, privacy, and fallbacks", async () => {
  const calls = [];
  let reply = { ok: true, body: { content: [{ type: "text", text: JSON.stringify({ summary: "Install a white vinyl privacy fence.", scope: ["About 120 feet, 6 feet tall", "One gate on the left side"], questions: ["Is there an old fence to remove?"] }) }] } };
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: reply.ok, status: reply.ok ? 200 : 500, json: async () => reply.body };
  };
  const site = await start({ ANTHROPIC_API_KEY: "test-key" }, fakeFetch);

  const reviewed = await (await site.json("/api/brief", JOB)).json();
  assert.equal(reviewed.brief.ai, true);
  assert.deepEqual(reviewed.brief.questions, ["Is there an old fence to remove?"]);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].options.headers["x-api-key"], "test-key");
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, "claude-haiku-5-5");
  assert.doesNotMatch(calls[0].options.body, /Dana|813-555/);

  // The reviewed brief and the answer to its question are stored with the request.
  const { row } = await createRequest(site, { brief: reviewed.brief, signature: reviewed.signature, answers: ["Yes, about 40 feet of chain link"] });
  assert.equal(row.brief.ai, true);
  assert.equal(row.brief.summary, "Install a white vinyl privacy fence.");
  assert.deepEqual(row.answers, [{ q: "Is there an old fence to remove?", a: "Yes, about 40 feet of chain link" }]);

  // A brief the server didn't sign is ignored.
  const forged = await createRequest(site, { brief: { summary: "Free pool", scope: ["x"], questions: ["?"], ai: true }, signature: reviewed.signature, answers: ["a"] });
  assert.equal(forged.row.brief.ai, false);
  assert.deepEqual(forged.row.answers, []);

  // Any AI failure falls back to the plain brief.
  reply = { ok: true, body: { content: [{ type: "text", text: "Sorry, I can't help with that." }] } };
  assert.equal((await (await site.json("/api/brief", JOB)).json()).brief.ai, false);
  reply = { ok: false, body: {} };
  assert.equal((await (await site.json("/api/brief", JOB)).json()).brief.ai, false);
});

test("the dashboard is locked without the password", async () => {
  const locked = await start({ ADMIN_PASSWORD: "" });
  assert.equal((await locked.get("/admin/login")).status, 503);
  assert.equal((await locked.form("/admin/login", { password: "" })).status, 503);

  const site = await start();
  const anonymous = await site.get("/admin");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/admin/login");
  assert.equal((await site.get("/admin/requests/1")).status, 303);
  assert.equal((await site.form("/admin/login", { password: "wrong" })).status, 401);
  assert.equal((await site.get("/admin", { cookie: "atl_admin=9999999999999.forged" })).status, 303);

  const admin = await login(site);
  assert.equal((await site.get("/admin", { cookie: admin.cookie })).status, 200);
  // A change without the form token is refused.
  const noToken = await site.form("/admin/partners", { company: "X", contact_name: "Y" }, { cookie: admin.cookie });
  assert.equal(noToken.status, 403);

  // An https PUBLIC_URL makes the session cookie HTTPS-only even when the proxy doesn't report https.
  const signedIn = await site.form("/admin/login", { password: "correct horse" });
  assert.match(signedIn.headers.get("set-cookie"), /; Secure/);
  const plain = await start({ PUBLIC_URL: "" });
  const plainSignIn = await plain.form("/admin/login", { password: "correct horse" });
  assert.doesNotMatch(plainSignIn.headers.get("set-cookie"), /; Secure/);
});

test("WorkOS sign-in replaces the password and admits only listed, verified emails", async () => {
  const calls = [];
  let reply = { ok: true, user: { email: "Owner@Example.test", email_verified: true } };
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: reply.ok, status: reply.ok ? 200 : 400, json: async () => ({ user: reply.user }) };
  };
  const site = await start({ WORKOS_API_KEY: "sk_test_key", WORKOS_CLIENT_ID: "client_test", ADMIN_EMAILS: "owner@example.test, second@example.test" }, fakeFetch);

  // The login page offers WorkOS sign-in only, and the password no longer works.
  const loginPage = await (await site.get("/admin/login")).text();
  assert.match(loginPage, /href="\/admin\/login\/start"/);
  assert.doesNotMatch(loginPage, /type="password"/);
  const password = await site.form("/admin/login", { password: "correct horse" });
  assert.equal(password.status, 303);
  assert.equal(password.headers.get("set-cookie"), null);

  const begin = async () => {
    const response = await site.get("/admin/login/start");
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location"));
    return { target, cookie: response.headers.get("set-cookie").split(";")[0], state: target.searchParams.get("state") };
  };

  const first = await begin();
  assert.equal(first.target.origin + first.target.pathname, "https://api.workos.com/user_management/authorize");
  assert.equal(first.target.searchParams.get("client_id"), "client_test");
  assert.equal(first.target.searchParams.get("provider"), "authkit");
  assert.equal(first.target.searchParams.get("response_type"), "code");
  assert.equal(first.target.searchParams.get("redirect_uri"), "https://example.test/admin/callback");

  // A callback that doesn't match the browser that started the login is refused before WorkOS is called.
  const forged = await site.get("/admin/callback?code=abc&state=someone-elses", { cookie: first.cookie });
  assert.equal(forged.headers.get("location"), "/admin/login?error=expired");
  const noCookie = await site.get("/admin/callback?code=abc&state=" + first.state);
  assert.equal(noCookie.headers.get("location"), "/admin/login?error=expired");
  const cancelled = await site.get("/admin/callback?error=access_denied&state=" + first.state, { cookie: first.cookie });
  assert.equal(cancelled.headers.get("location"), "/admin/login?error=cancelled");
  assert.equal(calls.length, 0);

  // A listed, verified email gets a working session. Matching ignores letter case.
  const good = await site.get("/admin/callback?code=one-time-code&state=" + first.state, { cookie: first.cookie });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "/admin");
  assert.equal(calls[0].url, "https://api.workos.com/user_management/authenticate");
  assert.deepEqual(
    { id: calls[0].body.client_id, secret: calls[0].body.client_secret, grant: calls[0].body.grant_type, code: calls[0].body.code },
    { id: "client_test", secret: "sk_test_key", grant: "authorization_code", code: "one-time-code" }
  );
  const session = good.headers.getSetCookie().find((cookie) => cookie.startsWith("atl_admin=")).split(";")[0];
  assert.equal((await site.get("/admin", { cookie: session })).status, 200);

  // Anyone else is turned away, with no session.
  const refuse = async (user, ok = true) => {
    reply = { ok, user };
    const attempt = await begin();
    const response = await site.get("/admin/callback?code=x&state=" + attempt.state, { cookie: attempt.cookie });
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("atl_admin=")));
    return response;
  };
  const stranger = await refuse({ email: "stranger@example.test", email_verified: true });
  assert.equal(stranger.status, 403);
  assert.match(await stranger.text(), /isn\u2019t allowed/);
  assert.equal((await refuse({ email: "owner@example.test", email_verified: false })).status, 403);
  assert.equal((await refuse({ email: "owner@example.test", email_verified: true }, false)).headers.get("location"), "/admin/login?error=failed");
  assert.equal((await refuse(null)).headers.get("location"), "/admin/login?error=failed");

  // With no emails listed, nobody gets in.
  reply = { ok: true, user: { email: "owner@example.test", email_verified: true } };
  const empty = await start({ WORKOS_API_KEY: "sk_test_key", WORKOS_CLIENT_ID: "client_test", ADMIN_EMAILS: "" }, fakeFetch);
  const emptyStart = await empty.get("/admin/login/start");
  const emptyState = new URL(emptyStart.headers.get("location")).searchParams.get("state");
  const emptyResult = await empty.get("/admin/callback?code=x&state=" + emptyState, { cookie: emptyStart.headers.get("set-cookie").split(";")[0] });
  assert.equal(emptyResult.status, 403);

  // Without WorkOS keys these routes do nothing: they fall through to the normal login redirect.
  const plain = await start();
  for (const path of ["/admin/login/start", "/admin/callback?code=x&state=y"]) {
    const response = await plain.get(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("the dashboard as its own service opens only behind the host's sign-in wall", async () => {
  // What a stranger gets when they ask for the dashboard's public address.
  let wall = "on";
  const probes = [];
  const edge = async (url) => {
    probes.push(String(url));
    if (wall === "unreachable") throw new Error("no route");
    if (wall === "on") return new Response("", { status: 401 });
    if (wall === "redirect") return new Response("", { status: 302, headers: { location: "https://signin.example.test/" } });
    if (wall === "other page") return new Response("<html>hello</html>", { status: 200 });
    return new Response("reachable", { status: 200, headers: { "x-atl-dashboard": "reachable" } });
  };
  const env = { ADMIN_PASSWORD: "", DASHBOARD_ONLY: "1", ADMIN_SIGNIN: "host", DASHBOARD_URL: "https://dash.example.test/" };
  const dash = await start(env, edge);
  const via = { "x-forwarded-host": "dash.example.test", "x-forwarded-for": "203.0.113.9" };

  // Wall on: the host has signed the visitor in, so the dashboard opens and starts a session.
  const first = await dash.get("/admin", via);
  assert.equal(first.status, 200);
  assert.deepEqual(probes, ["https://dash.example.test/admin/edge-check"]);
  assert.match(first.headers.get("set-cookie"), /^atl_admin=.*; Secure/);
  assert.doesNotMatch(await first.text(), /Log out/);
  const cookie = first.headers.get("set-cookie").split(";")[0];

  // Changes still need the form token that belongs to the session.
  const formPage = await (await dash.get("/admin/partners/new", { ...via, cookie })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(formPage)[1];
  const partner = { csrf, company: "Wall Test Co", contact_name: "Pat", trade: "Fence", tier: "Premium", status: "applied" };
  assert.equal((await dash.form("/admin/partners", partner, { ...via, cookie })).status, 303);
  assert.equal((await dash.form("/admin/partners", { ...partner, company: "Forged Co" }, via)).status, 403);
  assert.equal((await pool.query("select count(*)::int as n from partners where company = 'Forged Co'")).rows[0].n, 0);
  await pool.query("delete from partners where company = 'Wall Test Co'");

  // A recent check is trusted for a signed-in session. A visitor without one is checked every time.
  const before = probes.length;
  assert.equal((await dash.get("/admin/fees", { ...via, cookie })).status, 200);
  assert.equal(probes.length, before);
  assert.equal((await dash.get("/admin", via)).status, 200);
  assert.equal(probes.length, before + 1);

  // The wall's other answer, a redirect to its login page, also counts.
  wall = "redirect";
  assert.equal((await dash.get("/admin", via)).status, 200);

  // Wall off, unreachable, or an answer that isn't the wall's: locked, and no session is handed out.
  for (const state of ["off", "unreachable", "other page"]) {
    wall = state;
    const locked = await dash.get("/admin", via);
    assert.equal(locked.status, 503, state);
    assert.equal(locked.headers.get("set-cookie"), null, state);
    assert.match(await locked.text(), /sign-in wall/);
  }
  wall = "on";

  // Only at its own address.
  assert.equal((await dash.get("/admin", { ...via, "x-forwarded-host": "elsewhere.example.test" })).status, 503);
  assert.equal((await dash.get("/admin")).status, 503);

  // No login or logout pages, and nothing public is served here.
  for (const path of ["/admin/login", "/admin/logout", "/admin/login/start"]) {
    const response = await dash.get(path, via);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin");
  }
  const home = await dash.get("/", via);
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/admin");
  for (const path of ["/quote", "/quote.html", "/index.html", "/partners", "/quote.js", "/r/anything", "/q/anything", "/sitemap.xml"]) {
    assert.equal((await dash.get(path, via)).status, 404, path);
  }
  assert.equal((await dash.json("/api/brief", JOB)).status, 404);
  assert.equal((await dash.json("/api/requests", { ...JOB, ...CONTACT })).status, 404);
  for (const path of ["/styles.css", "/styles.css?v=0123456789", "/app.js", "/app.js?v=0123456789", "/favicon.svg", "/fonts/public-sans-latin-400-normal.woff2", "/healthz"]) {
    assert.equal((await dash.get(path, via)).status, 200, path);
  }

  // The wall setting does nothing outside a dashboard-only service with an https address.
  const publicSite = await start({ ADMIN_PASSWORD: "", ADMIN_SIGNIN: "host" }, edge);
  const stillLocked = await publicSite.get("/admin", via);
  assert.equal(stillLocked.status, 303);
  assert.equal(stillLocked.headers.get("location"), "/admin/login");
  const plainHttp = await start({ ...env, DASHBOARD_URL: "http://dash.example.test" }, edge);
  assert.equal((await plainHttp.get("/admin", via)).headers.get("location"), "/admin/login");

  // The public site sends the owner to the dashboard service when it has one.
  const hub = await start({ DASHBOARD_URL: "https://dash.example.test" });
  for (const path of ["/admin", "/admin/login", "/admin/requests/1"]) {
    const response = await hub.get(path);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://dash.example.test/admin");
  }
  assert.equal((await hub.get("/")).status, 200);
  assert.equal((await hub.form("/admin/login", { password: "correct horse" })).status, 302);
});

test("pages served from another address can call the request API", async () => {
  const site = await start({ SITE_ORIGINS: "https://www.example.test, https://second.example.test/" });
  const allowed = "https://www.example.test";
  const call = (path, origin, body) => fetch(site.base + path, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const ask = (path, origin) => fetch(site.base + path, {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
  });

  // The browser asks first, then sends.
  const preflight = await ask("/api/brief", allowed);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowed);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");
  const brief = await call("/api/brief", allowed, JOB);
  assert.equal(brief.status, 200);
  assert.equal(brief.headers.get("access-control-allow-origin"), allowed);
  assert.match(brief.headers.get("vary"), /Origin/);
  assert.equal(brief.headers.get("access-control-allow-credentials"), null);
  const reviewed = await brief.json();

  // The whole request goes through, and error messages can be read too.
  const sent = await call("/api/requests", allowed, { ...JOB, ...CONTACT, brief: reviewed.brief, signature: reviewed.signature });
  assert.equal(sent.status, 201);
  assert.equal(sent.headers.get("access-control-allow-origin"), allowed);
  assert.match((await sent.json()).url, /^\/r\//);
  const invalid = await call("/api/requests", allowed, { service: "Fence" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("access-control-allow-origin"), allowed);
  assert.equal((await ask("/api/partners", "https://second.example.test")).headers.get("access-control-allow-origin"), "https://second.example.test");

  // Any other site gets no permission, and neither does anyone on the private pages.
  for (const origin of ["https://elsewhere.example.test", "https://www.example.test.evil.test", "null"]) {
    assert.equal((await ask("/api/brief", origin)).headers.get("access-control-allow-origin"), null, origin);
    assert.equal((await call("/api/brief", origin, JOB)).headers.get("access-control-allow-origin"), null, origin);
  }
  for (const path of ["/admin/login", "/r/anything", "/q/anything", "/"]) {
    assert.equal((await site.get(path, { origin: allowed })).headers.get("access-control-allow-origin"), null, path);
  }
  // Without the setting, no other address is let in.
  const plain = await start();
  assert.equal((await fetch(plain.base + "/api/brief", { method: "OPTIONS", headers: { origin: allowed } })).headers.get("access-control-allow-origin"), null);

  // Served by the hub itself, the pages use the hub's own address.
  const config = await site.get("/config.js");
  assert.equal(config.status, 200);
  assert.match(await config.text(), /window\.ATL_API = "";/);
});

test("the static copy of the public pages is built to send to the hub", () => {
  const root = path.join(__dirname, "..");
  const build = (hub) => spawnSync(process.execPath, ["scripts/build-site.js"], { cwd: root, env: { ...process.env, HUB_URL: hub }, encoding: "utf8" });
  assert.equal(build("ftp://hub.example.test").status, 1);
  assert.equal(build("https://hub.example.test/some/path").status, 1);
  const built = build("https://hub.example.test/");
  assert.equal(built.status, 0, built.stderr);
  const dist = path.join(root, "dist");
  assert.equal(fs.readFileSync(path.join(dist, "config.js"), "utf8"), 'window.ATL_API = "https://hub.example.test";\n');
  for (const file of ["index.html", "quote.html", "partners.html", "404.html", "quote.js", "partners.js", "home.js", "styles.css", "favicon.svg", "og.png", "robots.txt", "sitemap.xml", "fonts/public-sans-latin-400-normal.woff2"]) {
    assert.ok(fs.existsSync(path.join(dist, file)), file);
  }
  assert.ok(!fs.existsSync(path.join(dist, "app.js")));
  // Each built page names its files by fingerprint. The built config.js differs from the hub's, so its fingerprint does too.
  const mark = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, file))).digest("hex").slice(0, 10);
  assert.ok(fs.readFileSync(path.join(dist, "index.html"), "utf8").includes('href="styles.css?v=' + mark("styles.css") + '"'));
  assert.ok(fs.readFileSync(path.join(dist, "index.html"), "utf8").includes('src="home.js?v=' + mark("home.js") + '"'));
  assert.ok(fs.readFileSync(path.join(dist, "404.html"), "utf8").includes('href="/styles.css?v=' + mark("styles.css") + '"'));
  // config.js loads before the script that reads it.
  for (const page of ["quote", "partners"]) {
    const html = fs.readFileSync(path.join(dist, page + ".html"), "utf8");
    const config = html.indexOf('src="config.js?v=' + mark("config.js") + '"');
    assert.ok(config > 0 && config < html.indexOf('src="' + page + ".js?v=" + mark(page + ".js") + '"'), page);
  }
  fs.rmSync(dist, { recursive: true, force: true });
});

test("the request form says what each service can include, and the companies page explains approval and the tiers", () => {
  const { SERVICE_NAMES, TIERS } = require("../server/lib/catalog");
  const site = path.join(__dirname, "..", "site");
  const form = fs.readFileSync(path.join(site, "quote.html"), "utf8");
  // One block of examples for each service in the catalog, hidden until that service is chosen.
  const described = [...form.matchAll(/<div class="service-info" data-service="([^"]+)" hidden>([\s\S]*?)<p class="help">/g)];
  assert.deepEqual(described.map((block) => block[1]).sort(), SERVICE_NAMES.filter((name) => name !== "Something else").sort());
  for (const [, name, body] of described) {
    assert.ok((body.match(/<li>/g) || []).length >= 3, name);
    assert.match(body, /class="service-info-title">[^<]+ can include</, name);
  }
  // Every service the form offers is one the catalog knows.
  const offered = [...form.slice(form.indexOf('<select id="service"'), form.indexOf("</select>")).matchAll(/<option>([^<]+)<\/option>/g)].map((option) => option[1]);
  assert.deepEqual(offered.slice().sort(), SERVICE_NAMES.slice().sort());

  const companies = fs.readFileSync(path.join(site, "partners.html"), "utf8");
  // How a company gets on the approved vendor list: four steps, ending in the site visit and the certificate.
  const approval = companies.slice(companies.indexOf('id="approve-title"'), companies.indexOf('id="tiers-title"'));
  assert.equal((approval.match(/<h3>/g) || []).length, 4);
  assert.match(approval, /score what we see against our written standard/);
  assert.match(approval, /our own standard, not a state license/);
  // Then what each tier means, and why it works for the company placed in it.
  const tiers = companies.slice(companies.indexOf('id="tiers-title"'), companies.indexOf('id="partner-form"'));
  assert.ok(approval.length > 0 && tiers.length > 0);
  for (const tier of TIERS) {
    assert.ok(tiers.includes("<h3>" + tier + "</h3>"), tier);
  }
  assert.equal((tiers.match(/We place you here when/g) || []).length, TIERS.length);
  assert.equal((tiers.match(/Why it works for you/g) || []).length, TIERS.length);
  // The link above them jumps to the application form further down the page.
  assert.ok(companies.includes('href="#partner-form"') && companies.includes('id="partner-form"'));
  // Customers are told about the visit too.
  const home = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert.match(home.slice(home.indexOf('id="verified-title"')), /<span class="wear-cause">Site visit<\/span>/);
});

test("partner application and verification rules", async () => {
  const site = await start();
  const application = {
    company: "Sunline Fence Co", trade: "Fence", tier: "Affordable", years: "6", license: "", insured: "Yes, I can send proof",
    areas: "Land O' Lakes", website: "", name: "Sam Owner", phone: "813-555-0142", email: "sam@example.test"
  };
  assert.equal((await site.json("/api/partners", { ...application, email: "nope" })).status, 400);
  assert.equal((await site.json("/api/partners", { ...application, trade: "Home repairs and upkeep" })).status, 400);
  assert.equal((await site.json("/api/partners", application)).status, 201);
  const applied = (await pool.query("select * from partners where company = 'Sunline Fence Co'")).rows[0];
  assert.equal(applied.status, "applied");

  const admin = await login(site);
  const fields = { csrf: admin.csrf, company: applied.company, contact_name: applied.contact_name, trade: "Fence", tier: "Affordable", status: "verified" };
  const tooEarly = await site.form("/admin/partners/" + applied.id, { ...fields, check_registration: "on" }, { cookie: admin.cookie });
  assert.equal(tooEarly.status, 400);
  assert.match(await tooEarly.text(), /license, insurance, references/);
  // Paperwork alone is not enough. Approval also needs a site visit that meets the standard.
  const paperwork = { check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on" };
  const noVisit = await site.form("/admin/partners/" + applied.id, { ...fields, ...paperwork }, { cookie: admin.cookie });
  assert.equal(noVisit.status, 400);
  assert.match(await noVisit.text(), /Record a site visit that meets your standard/);
  assert.equal((await pool.query("select status from partners where id = $1", [applied.id])).rows[0].status, "applied");
  assert.equal((await site.form("/admin/partners/" + applied.id, { ...fields, ...paperwork, status: "applied" }, { cookie: admin.cookie })).status, 303);
  const visit = await site.form("/admin/partners/" + applied.id + "/visit", {
    csrf: admin.csrf, visit_on: todayInFlorida(), place: "Their shop", then: "save", ...(await everyItem())
  }, { cookie: admin.cookie });
  assert.equal(visit.status, 303);
  // With the visit on file, the company can be approved from its own form too.
  const verified = await site.form("/admin/partners/" + applied.id, { ...fields, ...paperwork }, { cookie: admin.cookie });
  assert.equal(verified.status, 303);
  const approved = (await pool.query("select * from partners where id = $1", [applied.id])).rows[0];
  assert.equal(approved.status, "verified");
  assert.equal(approved.approved_on, todayInFlorida());
  assert.match(approved.review_due, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(approved.review_due > approved.approved_on);
});

test("certification: the standard, a site visit, approval into a tier, the approved list, and the certificate", async () => {
  const { DEFAULT_STANDARD } = require("../server/lib/standard");
  const site = await start();
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };
  const today = todayInFlorida();

  // The standard starts from a draft the owner can change.
  const page = await (await site.get("/admin/standard", cookie)).text();
  for (const item of DEFAULT_STANDARD.items) assert.ok(page.includes(">" + item.label + "</textarea>"), item.label);
  assert.match(page, /Your standard/);

  // The owner writes their own: two must-meet items and three worth points.
  const mine = {
    csrf: admin.csrf,
    label_0: "Site is safe and tidy", kind_0: "must",
    label_1: "Written estimate for every job", kind_1: "must",
    label_2: "Five years in business", kind_2: "2",
    label_3: "Two-year warranty", kind_3: "2",
    label_4: "Starts priority jobs within two weeks", kind_4: "1",
    label_5: "", kind_5: "must",
    review_months: "6"
  };
  const tooHigh = await site.form("/admin/standard", { ...mine, mid: "2", premium: "9" }, cookie);
  assert.equal(tooHigh.status, 400);
  const tooHighPage = await tooHigh.text();
  assert.match(tooHighPage, /Premium needs 9 points, but the items only add up to 5/);
  assert.ok(tooHighPage.includes(">Two-year warranty</textarea>"), "what the owner typed is kept");
  assert.equal((await site.form("/admin/standard", { ...mine, mid: "4", premium: "2" }, cookie)).status, 400);
  assert.equal((await site.form("/admin/standard", { ...mine, mid: "2", premium: "4", label_1: "site is SAFE and tidy" }, cookie)).status, 400);
  assert.equal((await site.form("/admin/standard", { ...mine, csrf: "", mid: "2", premium: "4" }, cookie)).status, 403, "needs the form token");
  assert.equal((await site.form("/admin/standard", { ...mine, mid: "2", premium: "4" }, {})).status, 303, "signed out: sent to the login page, nothing saved");
  assert.equal((await pool.query("select count(*)::int as n from settings where key = 'standard'")).rows[0].n, 0);
  const saved = await site.form("/admin/standard", { ...mine, mid: "2", premium: "4" }, cookie);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), "/admin/standard?saved=1");
  const savedPage = await (await site.get("/admin/standard?saved=1", cookie)).text();
  assert.ok(savedPage.includes(">Site is safe and tidy</textarea>") && !savedPage.includes(DEFAULT_STANDARD.items[0].label));
  assert.match(savedPage, /add up to 5 points/);

  // A company applies. Two of its paperwork checks are done.
  const details = {
    csrf: admin.csrf, company: "Harbor <Fence> Co", contact_name: "Lee Owner", phone: "813-555-0155", email: "lee@example.test",
    trade: "Fence", tier: "Premium", status: "applied"
  };
  const paperwork = { check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on" };
  const tooSoon = await site.form("/admin/partners", { ...details, ...paperwork, status: "verified" }, cookie);
  assert.equal(tooSoon.status, 400, "a new company can't start as approved");
  assert.match(await tooSoon.text(), /Add this company as Applied first/);
  assert.equal((await site.form("/admin/partners", { ...details, check_registration: "on", check_license: "on" }, cookie)).status, 303);
  const company = (await pool.query("select * from partners where company = 'Harbor <Fence> Co'")).rows[0];
  const row = async () => (await pool.query("select * from partners where id = $1", [company.id])).rows[0];
  const companyPath = "/admin/partners/" + company.id;
  const visitPath = companyPath + "/visit";
  const see = async (path) => (await site.get(path, cookie)).text();
  const SAFE = "Site is safe and tidy";
  const ESTIMATE = "Written estimate for every job";
  const YEARS = "Five years in business";
  const WARRANTY = "Two-year warranty";
  const FAST = "Starts priority jobs within two weeks";
  const visit = (fields) => site.form(visitPath, { csrf: admin.csrf, visit_on: today, ...fields }, cookie);
  let list;
  let companyPage = await see(companyPath);
  assert.match(companyPage, /<h2>Site visit<\/h2>/);
  assert.match(companyPage, /Written estimate for every job/);
  assert.match(companyPage, /Two-year warranty <span class="optional">\(2 points\)<\/span>/);
  assert.ok(companyPage.includes('name="' + itemKey(SAFE) + '">'), "boxes are named after the item, and start empty");
  list = await see("/admin/partners");
  assert.match(list, /Check their paperwork and visit a job/);
  assert.match(list, /Fence<br>Applied as Premium</, "until the owner places them, a company's tier is the one it applied as");
  assert.ok(list.includes('href="' + companyPath + '">Harbor'), "paperwork comes first, at the top of the company's page");
  assert.ok(companyPage.includes('<a class="secondary" href="#visit">Go to the site visit</a>'));
  assert.match(companyPage, /<label for="tier">Tier they applied as<\/label>/);

  // A visit that misses a must-meet item can be saved, but not approved.
  const missed = await visit({ place: "Job at <12> Oak St", then: "approve", ...tick(SAFE, YEARS) });
  assert.equal(missed.status, 400);
  const missedPage = await missed.text();
  assert.match(missedPage, /The visit wasn’t saved\. It doesn’t meet every must-meet item/);
  assert.ok(missedPage.includes('value="Job at &lt;12&gt; Oak St"'), "what the owner entered is kept, and escaped");
  assert.ok(missedPage.includes('name="' + itemKey(SAFE) + '" checked') && missedPage.includes('name="' + itemKey(ESTIMATE) + '">'));
  assert.equal((await row()).status, "applied");
  assert.deepEqual((await row()).visit, {});
  assert.equal((await visit({ visit_on: "2999-01-01", then: "save", ...tick(SAFE) })).status, 400, "no visits in the future");
  assert.equal((await visit({ visit_on: "not a date", then: "save" })).status, 400);
  assert.equal((await site.form(visitPath, { visit_on: today, then: "save" }, cookie)).status, 403, "needs the form token");
  assert.equal((await visit({ place: "Job at <12> Oak St", visit_notes: "Estimate was <verbal>.", then: "save", ...tick(SAFE, YEARS) })).status, 303);
  let now = await row();
  assert.equal(now.status, "applied");
  assert.equal(now.visit.passed, false);
  assert.equal(now.visit.mustMet, 1);
  assert.equal(now.visit.points, 2);
  companyPage = await see(companyPath);
  assert.match(companyPage, /Met 1 of 2 must-meet items\. Not met: Written estimate for every job\. They can&rsquo;t be approved/);
  assert.ok(companyPage.includes("Job at &lt;12&gt; Oak St") && companyPage.includes("Estimate was &lt;verbal&gt;.") && !/<12>|<verbal>/.test(companyPage));
  // Coming back to check what they fixed: the boxes start as they were left.
  assert.match(companyPage, /The boxes start as you left them on /);
  assert.ok(companyPage.includes('name="' + itemKey(SAFE) + '" checked') && companyPage.includes('name="' + itemKey(ESTIMATE) + '">'));
  list = await see("/admin/partners");
  assert.match(list, /<h2>Working toward approval<\/h2>[\s\S]*Harbor &lt;Fence&gt; Co/);
  assert.match(list, /Visit again when they’ve fixed what was missed/);
  assert.ok(list.includes('href="' + companyPath + '#visit">Harbor'), "the row opens the company's page at the site visit");
  assert.equal((await site.get(companyPath + "/certificate", cookie)).status, 404, "no certificate before approval");

  // The visit meets the standard, but the paperwork isn't finished. The visit is kept, and the page says what's left.
  const early = await visit({ place: "Job at 12 Oak St", visit_notes: "Clean site.", then: "approve", ...tick(SAFE, ESTIMATE, YEARS, FAST) });
  assert.equal(early.status, 303);
  assert.equal(early.headers.get("location"), companyPath + "#visit");
  now = await row();
  assert.equal(now.status, "applied", "not approved without the paperwork");
  assert.equal(now.visit.passed, true);
  assert.equal(now.visit.points, 3);
  assert.equal(now.visit.tier, "Mid-range", "3 points: at least the 2 for mid-range, short of the 4 for premium");
  assert.equal(now.tier, "Premium", "still the tier they asked for");
  companyPage = await see(companyPath);
  assert.match(companyPage, /Scored 3 of 5 tier points, which suggests Mid-range\./);
  assert.match(companyPage, /Points for: Five years in business; Starts priority jobs within two weeks\./);
  assert.match(companyPage, /tick these paperwork checks above and save: insurance, references\./);
  assert.ok(!companyPage.includes("/approve"), "no approve button until the paperwork is done");
  assert.ok(!companyPage.includes(" checked> <span>" + SAFE), "a new scorecard starts empty after a visit that passed");
  assert.match(await see("/admin/partners"), /Finish their paperwork checks/);
  const blocked = await site.form(companyPath + "/approve", { csrf: admin.csrf }, cookie);
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /Tick these checks before approving this company: insurance, references\./);

  // With the paperwork ticked, one button approves the company into the tier its points suggest.
  const lastCheck = await site.form(companyPath, { ...details, ...paperwork }, cookie);
  assert.equal(lastCheck.status, 303);
  assert.equal(lastCheck.headers.get("location"), companyPath + "#visit", "straight to the approve button");
  assert.match(await see("/admin/partners"), /Ready to approve/);
  companyPage = await see(companyPath);
  assert.match(companyPage, new RegExp('action="' + companyPath + '/approve"[\\s\\S]*?<button class="primary" type="submit">Approve as Mid-range</button>'));
  assert.match(companyPage, /their paperwork is checked\. They applied as Premium\./);
  assert.equal((await site.form(companyPath + "/approve", {}, cookie)).status, 403, "needs the form token");
  const approvedNow = await site.form(companyPath + "/approve", { csrf: admin.csrf }, cookie);
  assert.equal(approvedNow.status, 303);
  now = await row();
  assert.equal(now.status, "verified");
  assert.equal(now.tier, "Mid-range");
  assert.equal(now.approved_on, today);
  companyPage = await see(companyPath);
  assert.match(companyPage, /<label for="tier">Tier<\/label>/);
  assert.match(companyPage, new RegExp('<a class="secondary" href="' + companyPath + '/certificate">Open the certificate</a>'));
  assert.match(await see("/admin/partners"), /Fence<br>Mid-range</);
  const monthsOut = (months) => new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + months, 1)).toISOString().slice(0, 7);
  assert.equal(now.review_due.slice(0, 7), monthsOut(6), "the next visit is six months out, as the standard says");

  // A later visit that meets the standard renews the approval: the first date stays, and the owner's tier choice wins.
  await pool.query("update partners set approved_on = '2026-01-15', review_due = '2026-07-15' where id = $1", [company.id]);
  assert.match(await see("/admin/partners"), /Another visit is due/);
  assert.match(await see(companyPath + "/certificate"), /This certificate&rsquo;s date has passed/);
  companyPage = await see(companyPath);
  assert.match(companyPage, /renews their approval for 6 months/);
  assert.ok(!companyPage.includes("Save the visit and approve"));
  assert.equal((await visit({ then: "save", visit_tier: "Premium", ...tick(SAFE, ESTIMATE) })).status, 303);
  now = await row();
  assert.equal(now.tier, "Premium");
  assert.equal(now.approved_on, "2026-01-15");
  assert.equal(now.review_due.slice(0, 7), monthsOut(6));
  assert.match(await see(companyPath), /Scored 0 of 5 tier points, which suggests Affordable\. They are in Premium\./);

  // The approved list, on the page and as an Excel file.
  const number = "AV-" + (1000 + company.id);
  list = await see("/admin/partners");
  const approvedPart = list.slice(list.indexOf("<h2>Approved vendors</h2>"), list.indexOf("<h2>Your own crew</h2>"));
  assert.ok(approvedPart.includes("Harbor &lt;Fence&gt; Co") && approvedPart.includes(number + ", approved Jan 15, 2026<br>Visit again by "));
  assert.match(approvedPart, /<a href="tel:8135550155">813-555-0155<\/a>/, "an approved vendor is still one tap to call");
  assert.ok(!approvedPart.includes("AT Legacy Services"), "the owner's own crew is not a vendor");
  assert.doesNotMatch(approvedPart, /needs-you/);
  assert.match(list, /href="\/admin\/approved\.xlsx">Download the approved list for Excel/);
  const sheet = await site.get("/admin/approved.xlsx", cookie);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get("content-disposition"), /attachment; filename="AT-Legacy-approved-vendors-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const files = unzip(Buffer.from(await sheet.arrayBuffer()));
  const rows = files["xl/worksheets/sheet1.xml"];
  assert.ok(rows.includes(">" + number + "<") && rows.includes(">Harbor &lt;Fence&gt; Co<") && rows.includes(">Premium<"));
  assert.ok(!Object.values(files).some((xml) => /<f[ >]/.test(xml)), "no formulas");
  assert.equal((await site.get("/admin/approved.xlsx")).status, 303, "signed out: sent to the login page");

  // The certificate.
  const certificate = await site.get(companyPath + "/certificate", cookie);
  assert.equal(certificate.status, 200);
  const certificateText = await certificate.text();
  assert.ok(certificateText.includes("Harbor &lt;Fence&gt; Co") && certificateText.includes(number) && certificateText.includes("Jan 15, 2026"));
  assert.match(certificateText, /It is not a state license/);
  assert.doesNotMatch(certificateText, /date has passed/);
  assert.ok(certificateText.includes('href="' + companyPath + '#visit">Back to the company</a>'));
  assert.equal((await site.get(companyPath + "/certificate")).status, 303);

  // An approved company that misses a must-meet item at a later visit stays approved until the owner pauses it.
  assert.equal((await visit({ then: "save", ...tick(SAFE) })).status, 303);
  now = await row();
  assert.equal(now.status, "verified");
  assert.equal(now.visit.passed, false);
  assert.match(await see(companyPath), /Not met: Written estimate for every job\. They stay approved until you pause them\./);
  assert.match(await see("/admin/partners"), /The last visit missed a must-meet item/);
  // Its details can still be corrected, and pausing takes it off the approved list without losing its dates.
  assert.equal((await site.form(companyPath, { ...details, ...paperwork, phone: "813-555-0156", status: "verified" }, cookie)).status, 303);
  assert.equal((await site.form(companyPath, { ...details, ...paperwork, status: "paused" }, cookie)).status, 303);
  now = await row();
  assert.equal(now.approved_on, "2026-01-15");
  list = await see("/admin/partners");
  assert.ok(!list.slice(list.indexOf("<h2>Approved vendors</h2>"), list.indexOf("<h2>Paused</h2>")).includes("Harbor"));
  assert.equal((await site.get(companyPath + "/certificate", cookie)).status, 404);
  // It can't come back while its last visit is a miss.
  const back = await site.form(companyPath, { ...details, ...paperwork, status: "verified" }, cookie);
  assert.equal(back.status, 400);
  assert.match(await back.text(), /Record a site visit that meets your standard/);
  // Moving it back to Applied withdraws the certification.
  assert.equal((await site.form(companyPath, { ...details, ...paperwork }, cookie)).status, 303);
  now = await row();
  assert.equal(now.approved_on, "");
  assert.equal(now.review_due, "");

  // A scorecard opened before the standard changed can't tick the wrong item: boxes go by wording, not position.
  assert.equal((await site.form("/admin/standard", { csrf: admin.csrf, label_0: ESTIMATE, kind_0: "must", label_1: WARRANTY, kind_1: "3", mid: "1", premium: "3", review_months: "12" }, cookie)).status, 303);
  assert.equal((await visit({ then: "approve", met_0: "on", met_1: "on", ...tick(SAFE, WARRANTY) })).status, 400, "the must-meet item wasn't ticked");
  assert.equal((await visit({ then: "approve", ...tick(SAFE, ESTIMATE, WARRANTY) })).status, 303);
  now = await row();
  assert.equal(now.status, "verified");
  assert.equal(now.visit.points, 3);
  assert.equal(now.tier, "Premium");
  assert.equal(now.approved_on, today);
  assert.deepEqual(now.visit.items.map((item) => item.label), [ESTIMATE, WARRANTY], "a visit keeps the wording it was scored against");

  // The owner's own crew is not scored.
  const crew = (await pool.query("select id from partners where trade = 'Home repairs and upkeep'")).rows[0];
  assert.ok(!(await see("/admin/partners/" + crew.id)).includes("<h2>Site visit</h2>"));
  assert.equal((await site.form("/admin/partners/" + crew.id + "/visit", { csrf: admin.csrf, visit_on: today, then: "save" }, cookie)).status, 404);
  assert.equal((await site.form("/admin/partners/" + crew.id + "/approve", { csrf: admin.csrf }, cookie)).status, 404);

  // Put the starting standard back for the tests that follow.
  await pool.query("delete from settings where key = 'standard'");
});

test("full flow: request, invites, quotes, choice, and fee", async () => {
  const site = await start({ FEE_PERCENT: "5" });
  const admin = await login(site);
  const budget = await addVerifiedPartner(site, admin, "Budget Fence LLC", "Affordable");
  const premium = await addVerifiedPartner(site, admin, "Crown Fence & Gate", "Premium");
  const unverified = (await pool.query(
    "insert into partners (company, contact_name, trade, tier) values ('Unchecked Fence', 'U', 'Fence', 'Affordable') returning id"
  )).rows[0];

  const { url, row } = await createRequest(site, { details: "Fence please <script>alert(1)</script>" });
  assert.deepEqual(row.tiers, ["Affordable", "Premium"]);
  assert.equal(row.status, "new");

  // The customer's page escapes what they typed and shows no quotes yet.
  let customerPage = await (await site.get(url)).text();
  assert.doesNotMatch(customerPage, /<script>alert/);
  assert.match(customerPage, /&lt;script&gt;alert/);
  assert.match(customerPage, /lining up a verified company/);

  // Only verified partners can be sent the brief.
  const invite = (partner, tier) => site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, tier, partner: String(partner) }, { cookie: admin.cookie });
  await invite(unverified.id, "Affordable");
  assert.equal((await pool.query("select count(*) from quotes where request_id = $1", [row.id])).rows[0].count, "0");
  await invite(budget.id, "Affordable");
  await invite(premium.id, "Premium");
  await invite(premium.id, "Mid-range"); // not a tier the customer asked for
  const quotes = (await pool.query("select * from quotes where request_id = $1 order by tier", [row.id])).rows;
  assert.equal(quotes.length, 2);
  assert.equal((await pool.query("select status from requests where id = $1", [row.id])).rows[0].status, "collecting");

  const detail = await (await site.get("/admin/requests/" + row.id, { cookie: admin.cookie })).text();
  assert.match(detail, new RegExp("https://example.test/q/" + quotes[0].token));
  // Without PUBLIC_URL, links use the address the dashboard was opened on.
  const plain = await start({ PUBLIC_URL: "" });
  const plainAdmin = await login(plain);
  const plainDetail = await (await plain.get("/admin/requests/" + row.id, { cookie: plainAdmin.cookie })).text();
  assert.match(plainDetail, new RegExp(plain.base.replace(/\./g, "\\.") + "/q/" + quotes[0].token));
  assert.match(detail, /813-555-0100/);

  // The partner sees the job, but not who the customer is.
  const [affordable, top] = quotes;
  let partnerPage = await (await site.get("/q/" + affordable.token)).text();
  assert.match(partnerPage, /Budget Fence LLC/);
  assert.match(partnerPage, /34637/);
  assert.doesNotMatch(partnerPage, /Dana Customer|813-555-0100/);
  assert.match(partnerPage, /5% of the job total/);

  const bad = await site.form("/q/" + affordable.token, { action: "submit", amount: "cheap", timeline: "2 weeks", includes: "All of it" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /dollar amount/);
  await site.form("/q/" + affordable.token, { action: "submit", amount: "$4,950", timeline: "Start in 2 weeks", includes: "Materials, labor, one gate", warranty: "1 year" });
  await site.form("/q/" + top.token, { action: "visit" });
  assert.equal((await pool.query("select status from quotes where id = $1", [top.id])).rows[0].status, "visit");
  await site.form("/q/" + top.token, { action: "submit", amount: "6800.00", timeline: "Start in 1 week", includes: "Premium vinyl, labor, gate, haul-away", warranty: "5 years" });

  customerPage = await (await site.get(url)).text();
  assert.match(customerPage, /Budget Fence LLC/);
  assert.match(customerPage, /\$4,950/);
  assert.match(customerPage, /\$6,800/);
  assert.match(customerPage, /Choose Crown Fence &amp; Gate/);

  // A quote from another request can't be chosen here.
  const other = await createRequest(site);
  await site.form("/r/" + other.row.token + "/choose", { quote: String(affordable.id) });
  assert.equal((await pool.query("select status from requests where id = $1", [other.row.id])).rows[0].status, "new");

  const chosen = await site.form("/r/" + row.token + "/choose", { quote: String(affordable.id) });
  assert.equal(chosen.status, 303);
  const after = (await pool.query("select status, chosen_quote_id from requests where id = $1", [row.id])).rows[0];
  assert.deepEqual(after, { status: "chosen", chosen_quote_id: affordable.id });

  // The winner now gets the customer's contact details. The other company doesn't.
  partnerPage = await (await site.get("/q/" + affordable.token)).text();
  assert.match(partnerPage, /Dana Customer/);
  assert.match(partnerPage, /813-555-0100/);
  const loserPage = await (await site.get("/q/" + top.token)).text();
  assert.match(loserPage, /chose another company/);
  assert.doesNotMatch(loserPage, /Dana Customer|813-555-0100/);

  // Nothing changes after the choice.
  await site.form("/q/" + top.token, { action: "submit", amount: "1", timeline: "now", includes: "x" });
  assert.equal((await pool.query("select amount_cents from quotes where id = $1", [top.id])).rows[0].amount_cents, "680000");
  await site.form("/r/" + row.token + "/choose", { quote: String(top.id) });
  assert.equal((await pool.query("select chosen_quote_id from requests where id = $1", [row.id])).rows[0].chosen_quote_id, affordable.id);

  // Fee: 5% of $4,950 is $247.50, then 5% of the $5,200 final total is $260.
  let fees = await (await site.get("/admin/fees", { cookie: admin.cookie })).text();
  assert.match(fees, /Owed to you now: \$247\.50/);
  await site.form("/admin/fees/" + affordable.id, { csrf: admin.csrf, final: "5200", paid: "on" }, { cookie: admin.cookie });
  fees = await (await site.get("/admin/fees", { cookie: admin.cookie })).text();
  assert.match(fees, /Owed to you now: \$0\. Collected so far: \$260\./);

  // The owner can undo a choice.
  await site.form("/admin/requests/" + row.id + "/status", { csrf: admin.csrf, status: "reopen" }, { cookie: admin.cookie });
  assert.equal((await pool.query("select status from requests where id = $1", [row.id])).rows[0].status, "collecting");
});

test("the dashboard is marked as the owner's, says what needs them, and builds safe send links", async () => {
  await pool.query("delete from quotes; delete from requests; delete from partners where company <> 'AT Legacy Services'");
  const site = await start();
  const admin = await login(site);
  const see = async (path) => (await site.get(path, { cookie: admin.cookie })).text();

  // Pages point at stylesheet and script addresses that change whenever the files do,
  // so a browser can't show a new page with styles it saved before an update.
  const framed = await see("/admin");
  const styles = /<link rel="stylesheet" href="(\/styles\.css\?v=[0-9a-f]{10})">/.exec(framed);
  const script = /<script src="(\/app\.js\?v=[0-9a-f]{10})" defer>/.exec(framed);
  assert.ok(styles && script);
  assert.equal((await site.get(styles[1])).status, 200);
  assert.equal((await site.get(script[1])).status, 200);
  assert.match(await (await site.get(styles[1])).text(), /\.owner-strip/);

  // Every dashboard page carries the owner strip and marks its tab. Pages for other people never do.
  for (const [path, tab] of [["/admin", "Requests"], ["/admin/partners", "Partners"], ["/admin/partners/new", "Partners"], ["/admin/fees", "Fees"], ["/admin/links", "Links"]]) {
    const html = await see(path);
    assert.match(html, /class="owner-strip"><strong>Owner dashboard<\/strong>/, path);
    assert.match(html, new RegExp('aria-current="page">' + tab + "<"), path);
    assert.match(html, /<title>Dashboard: /, path);
  }
  assert.match(await see("/admin"), /Nothing right now\./);
  assert.match(await see("/admin"), /No requests yet\./);

  // People type anything into phone and email fields.
  const application = {
    company: "Budget <i>Fence</i>", trade: "Fence", tier: "Affordable", years: "6", license: "", insured: "Yes, I can send proof",
    areas: "Land O' Lakes", website: "", name: "Pat O'Partner", phone: '813-555-0199"><script>', email: "pat@example.test?cc=x&body=hi"
  };
  assert.equal((await site.json("/api/partners", application)).status, 201);
  const partner = (await pool.query("select * from partners where trade = 'Fence'")).rows[0];
  let home = await see("/admin");
  assert.match(home, /<a href="\/admin\/partners">1 company needs a check or a visit<\/a>/);
  let partnersPage = await see("/admin/partners");
  assert.match(partnersPage, /class="owner-row needs-you"/);
  assert.match(partnersPage, /Check their paperwork and visit a job/);
  assert.match(partnersPage, /<a href="tel:8135550199">813-555-0199&quot;&gt;&lt;script&gt;<\/a>/);
  assert.doesNotMatch(partnersPage, /<script>|<i>Fence/);
  const paperwork = await site.form("/admin/partners/" + partner.id, {
    csrf: admin.csrf, company: partner.company, contact_name: partner.contact_name, phone: partner.phone, email: partner.email,
    trade: "Fence", tier: "Affordable", status: "applied",
    check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on"
  }, { cookie: admin.cookie });
  assert.equal(paperwork.status, 303);
  const verify = await site.form("/admin/partners/" + partner.id + "/visit", {
    csrf: admin.csrf, visit_on: todayInFlorida(), place: "A job in Lutz", visit_tier: "Affordable", then: "approve", ...(await everyItem())
  }, { cookie: admin.cookie });
  assert.equal(verify.status, 303);
  partnersPage = await see("/admin/partners");
  assert.match(partnersPage, /<h2>Approved vendors<\/h2>/);
  assert.match(partnersPage, new RegExp("AV-" + (1000 + partner.id) + ", approved "));
  assert.doesNotMatch(partnersPage, /class="owner-row needs-you"/);

  const { url, row } = await createRequest(site, { name: 'Dana <b>Customer</b>', phone: "(813) 555-0100 <x>", email: "dana+quotes@example.test", contact: "Email" });
  for (const path of ["/", "/quote", "/partners", url]) {
    assert.doesNotMatch(await (await site.get(path)).text(), /owner-strip|Owner dashboard/, path);
  }

  // A new request needs companies.
  home = await see("/admin");
  assert.match(home, new RegExp('<a href="/admin/requests/' + row.id + '">1 request needs companies</a>'));
  assert.match(home, /class="owner-row needs-you"/);
  assert.match(home, /Choose companies/);
  assert.match(home, /0 of 2 quotes in/);
  assert.match(home, /Fence <span>for Dana &lt;b&gt;Customer&lt;\/b&gt;<\/span>/);
  let detail = await see("/admin/requests/" + row.id);
  assert.match(detail, /<strong>Next:<\/strong> Choose a company for each tier below\./);
  assert.match(detail, /Back to all requests/);

  // With one tier filled, the company's link can be texted or emailed in one tap.
  const invite = (tier) => site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, partner: String(partner.id), tier }, { cookie: admin.cookie });
  await invite("Affordable");
  const quote = (await pool.query("select * from quotes where request_id = $1", [row.id])).rows[0];
  home = await see("/admin");
  assert.match(home, /1 tier still needs a company/);
  detail = await see("/admin/requests/" + row.id);
  // The link ends with the request's reference, the tier, and the company. Never the customer's name.
  const link = "https://example.test/q/" + quote.token + "/r" + (1000 + row.id) + "-affordable-budget-i-fence-i";
  const said = "AT Legacy Services has a fence job for you to quote in 34637. The details and your quote form are here:";
  assert.ok(detail.includes('href="sms:8135550199?&amp;body=' + encodeURIComponent(said + " " + link) + '" data-track-event="texted">Text it to Pat</a>'));
  // The typed email can't add recipients or text of its own: everything after the @ stays part of the address.
  assert.ok(detail.includes('href="mailto:pat@example.test%3Fcc%3Dx%26body%3Dhi?subject=' + encodeURIComponent("Fence job to quote") + "&amp;body=" + encodeURIComponent(said + "\n\n" + link) + '" data-track-event="emailed">Email it to Pat</a>'));
  assert.ok(detail.includes('<a href="' + link + '?owner=1" target="_blank" rel="noopener">Open the company’s page</a>'));
  assert.ok(detail.includes("Ends in <strong>r" + (1000 + row.id) + "-affordable-budget-i-fence-i</strong>"));
  assert.ok(detail.includes('data-share-url="' + link + '"'));
  // The customer: call, text, email, and their private page.
  assert.match(detail, /<a href="tel:8135550100">Call<\/a> <a href="sms:8135550100\?&amp;body=">Text<\/a>/);
  assert.match(detail, /href="mailto:dana%2Bquotes@example\.test\?subject=/);
  assert.ok(detail.includes("Text it to Dana</a>"));
  assert.equal(url, "/r/" + row.token + "/r" + (1000 + row.id) + "-dana");
  assert.ok(detail.includes('<a href="https://example.test' + url + '?owner=1" target="_blank" rel="noopener">Open the customer’s page</a>'));
  assert.match(detail, /This is the page the customer sees\./);
  assert.doesNotMatch(detail, /<b>Customer|<script>|0100 <x>/);

  // Every tier filled: nothing to do until the companies answer.
  await invite("Premium");
  home = await see("/admin");
  assert.match(home, /Waiting on 2 quotes/);
  assert.match(home, /Nothing right now\./);
  assert.doesNotMatch(home, /owner-row needs-you/);
  const quotes = (await pool.query("select * from quotes where request_id = $1 order by tier", [row.id])).rows;

  // Everyone passes: the owner is needed again. One price in: the customer is choosing.
  for (const q of quotes) await site.form("/q/" + q.token, { action: "decline" });
  home = await see("/admin");
  assert.match(home, /Every company passed/);
  assert.match(home, /1 request needs companies/);
  await pool.query("update quotes set status = 'submitted', amount_cents = 495000, includes = 'All of it', timeline = '2 weeks' where id = $1", [quotes[0].id]);
  home = await see("/admin");
  assert.match(home, /Customer is choosing/);
  assert.match(home, /1 of 2 quotes in/);

  // Chosen: the fee shows up as money to collect. Closed: nothing more to say.
  await site.form("/r/" + row.token + "/choose", { quote: String(quotes[0].id) });
  home = await see("/admin");
  assert.match(home, /Budget &lt;i&gt;Fence&lt;\/i&gt; was chosen/);
  assert.match(home, /<a href="\/admin\/fees">\$247\.50 in finder’s fees to collect<\/a>/);
  detail = await see("/admin/requests/" + row.id);
  assert.match(detail, /When the job is done, enter the final total under Fees\./);
  const fees = await see("/admin/fees");
  assert.match(fees, /class="owner-row fee-row needs-you"/);
  assert.match(fees, /Owed to you/);
  await site.form("/admin/fees/" + quotes[0].id, { csrf: admin.csrf, final: "", paid: "on" }, { cookie: admin.cookie });
  assert.doesNotMatch(await see("/admin"), /fees to collect/);

  // The Links page lists every fixed page with its full address.
  const links = await see("/admin/links");
  for (const address of ["https://example.test/admin", "https://example.test/quote", "https://example.test/", "https://example.test/partners"]) {
    assert.ok(links.includes('data-copy-text="' + address + '"'), address);
  }
  assert.match(links, /example\.test<wbr>\/quote/);
  assert.match(partnersPage = await see("/admin/partners"), /data-copy-text="https:\/\/example\.test\/partners"/);
});

// Reads a zip the plain way: the directory at the end, then each file. Checks every file's checksum.
function unzip(buffer) {
  const zlib = require("node:zlib");
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const files = {};
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const packedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buffer.subarray(start, start + packedSize));
    assert.equal(zlib.crc32(data), buffer.readUInt32LE(at + 16), name);
    files[name] = data.toString("utf8");
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}

test("private links carry a readable name, and the dashboard knows when each was sent and opened", async () => {
  await pool.query("delete from quotes; delete from requests; delete from partners where company <> 'AT Legacy Services'");
  const site = await start();
  const admin = await login(site);
  const see = async (path) => (await site.get(path, { cookie: admin.cookie })).text();
  const browser = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
  const partner = await addVerifiedPartner(site, admin, "Budget Fence LLC", "Affordable");
  const { url, row } = await createRequest(site, { name: "Zoë O'Customer-Smith", email: "zoe@example.test" });
  const ref = "R" + (1000 + row.id);
  const opens = async (quoteId = null) => (await pool.query(
    "select count(*)::int as n from link_events where request_id = $1 and quote_id is not distinct from $2 and event = 'opened'", [row.id, quoteId])).rows[0].n;

  // The customer's link ends with the reference and their first name. The secret alone still opens the page.
  assert.equal(url, "/r/" + row.token + "/" + ref.toLowerCase() + "-zoe");
  for (const path of [url, "/r/" + row.token, "/r/" + row.token + "/some-other-name"]) {
    const response = await site.get(path, browser);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), new RegExp("Reference " + ref + ", for Zoë\\."), path);
  }
  assert.equal((await site.get("/r/" + row.token + "x/" + ref.toLowerCase() + "-zoe", browser)).status, 404);

  // Three visits in a row count as one open. A later visit counts again.
  assert.equal(await opens(), 1);
  await pool.query("update link_events set created_at = created_at - interval '3 minutes' where request_id = $1", [row.id]);
  await site.get(url, browser);
  assert.equal(await opens(), 2);

  // The owner's own look and a message app's preview are not the customer opening it.
  await pool.query("update link_events set created_at = created_at - interval '3 minutes' where request_id = $1", [row.id]);
  const preview = await (await site.get(url + "?owner=1", browser)).text();
  assert.match(preview, /class="owner-preview"><strong>Owner preview\.<\/strong> This is the customer&rsquo;s page/);
  assert.doesNotMatch(await (await site.get(url, browser)).text(), /owner-preview/);
  await pool.query("delete from link_events where request_id = $1 and created_at > now() - interval '1 minute'", [row.id]);
  for (const agent of ["Mozilla/5.0 (Macintosh) AppleWebKit/601.2.4 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0", "WhatsApp/2.23", "Slackbot-LinkExpanding 1.0", "curl/8.5.0", ""]) {
    await site.get(url, { "user-agent": agent });
  }
  await site.get(url + "?owner=1", browser);
  assert.equal(await opens(), 2);

  // A company's link ends with the reference, the tier, and the company. It never names the customer.
  await site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, partner: String(partner.id), tier: "Affordable" }, { cookie: admin.cookie });
  const quote = (await pool.query("select * from quotes where request_id = $1", [row.id])).rows[0];
  const companyPath = "/q/" + quote.token + "/" + ref.toLowerCase() + "-affordable-budget-fence-llc";
  let detail = await see("/admin/requests/" + row.id);
  assert.ok(detail.includes('value="https://example.test' + companyPath + '"'));
  assert.ok(detail.includes("Ends in <strong>" + ref.toLowerCase() + "-affordable-budget-fence-llc</strong>"));
  assert.ok(detail.includes("Ends in <strong>" + ref.toLowerCase() + "-zoe</strong>"));
  assert.doesNotMatch(companyPath, /zoe|customer|smith/);
  assert.match(detail, new RegExp("Reference " + ref + "\\. Received"));
  assert.ok(detail.includes('<div class="link-row" data-track="' + row.id + '" data-track-quote="' + quote.id + '" data-csrf="' + admin.csrf + '">'));
  assert.ok(detail.includes('<div class="link-row" data-track="' + row.id + '" data-csrf="' + admin.csrf + '">'));
  assert.match(detail, /data-copy="link-\d+" data-track-event="copied">Copy</);
  assert.match(detail, /<p class="link-activity">Not sent from here yet\. Not opened yet\.<\/p>/);
  assert.match(detail, /<p class="link-activity">Not sent from here yet\. Opened 2 times, last [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M\.<\/p>/);

  // The company's page says which request and which company it is for, and counts their visit.
  for (const path of [companyPath, "/q/" + quote.token]) {
    const page = await (await site.get(path, browser)).text();
    assert.match(page, new RegExp("Request " + ref + ", for Budget Fence LLC\\. You’re the affordable quote"), path);
    assert.doesNotMatch(page, /Zoë|owner-preview/, path);
  }
  assert.match(await (await site.get(companyPath + "?owner=1", browser)).text(), /Owner preview\.<\/strong> This is the company&rsquo;s page/);
  assert.equal(await opens(quote.id), 1);
  const answered = await site.form("/q/" + quote.token, { action: "submit", amount: "4950", timeline: "2 weeks", includes: "All of it" });
  assert.equal(answered.headers.get("location"), companyPath);
  const picked = await site.form("/r/" + row.token + "/choose", { quote: "0" });
  assert.equal(picked.headers.get("location"), url);

  // The dashboard reports each send. It takes only real links, known kinds of send, and the owner's own form token.
  const report = (fields, headers = { cookie: admin.cookie }) => site.form("/admin/link-events", fields, headers);
  assert.equal((await report({ csrf: admin.csrf, request: String(row.id), quote: String(quote.id), event: "texted" })).status, 204);
  assert.equal((await report({ csrf: admin.csrf, request: String(row.id), quote: "", event: "emailed" })).status, 204);
  assert.equal((await report({ csrf: "wrong", request: String(row.id), quote: "", event: "copied" })).status, 403);
  assert.equal((await report({ csrf: admin.csrf, request: String(row.id), quote: "", event: "opened" })).status, 400);
  assert.equal((await report({ csrf: admin.csrf, request: "999999", quote: "", event: "copied" })).status, 404);
  assert.equal((await report({ csrf: admin.csrf, request: String(row.id), quote: "999999", event: "copied" })).status, 404);
  assert.equal((await report({ csrf: admin.csrf, request: String(row.id), quote: "", event: "copied" }, {})).status, 303);
  detail = await see("/admin/requests/" + row.id);
  assert.match(detail, /<p class="link-activity">Texted [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M\. Opened 1 time, last /);
  assert.match(detail, /<p class="link-activity">Emailed [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M\. Opened 2 times, last /);

  // Removing a company removes its link's history with it.
  await pool.query("update quotes set status = 'invited' where id = $1", [quote.id]);
  await site.form("/admin/requests/" + row.id + "/uninvite", { csrf: admin.csrf, quote: String(quote.id) }, { cookie: admin.cookie });
  assert.equal((await pool.query("select count(*)::int as n from link_events where quote_id = $1", [quote.id])).rows[0].n, 0);
  assert.equal((await site.get(companyPath, browser)).status, 404);
});

test("the spreadsheet view and the Excel file list every open request, straight from the site", async () => {
  await pool.query("delete from quotes; delete from requests; delete from partners where company <> 'AT Legacy Services'");
  const site = await start();
  const admin = await login(site);
  const see = (path) => site.get(path, { cookie: admin.cookie });
  const budget = await addVerifiedPartner(site, admin, "Budget Fence LLC", "Affordable");
  const premier = await addVerifiedPartner(site, admin, "Premier Fence Co", "Premium");
  const invite = (request, partner, tier) => site.form("/admin/requests/" + request.id + "/invite", { csrf: admin.csrf, partner: String(partner.id), tier }, { cookie: admin.cookie });

  // One request with a price and a company still to answer, one with a formula for a name, one closed.
  const first = await createRequest(site, { email: "dana@example.test" });
  await invite(first.row, budget, "Affordable");
  await invite(first.row, premier, "Premium");
  const quotes = (await pool.query("select * from quotes where request_id = $1 order by tier", [first.row.id])).rows;
  await site.form("/q/" + quotes[0].token, { action: "submit", amount: "$4,950.50", timeline: "Start in 2 weeks", includes: "Materials & labor <all>", warranty: "1 year" });
  await site.get(first.url, { "user-agent": "Mozilla/5.0 Safari" });
  const tricky = await createRequest(site, { name: '=HYPERLINK("http://evil.test","Click")', tiers: ["Mid-range"] });
  const closed = await createRequest(site, { name: "Closed Customer" });
  await site.form("/admin/requests/" + closed.row.id + "/status", { csrf: admin.csrf, status: "closed" }, { cookie: admin.cookie });
  const ref = (request) => "R" + (1000 + request.row.id);

  // Only the owner gets either one.
  for (const path of ["/admin/tracker", "/admin/tracker.xlsx"]) {
    const stranger = await site.get(path);
    assert.equal(stranger.status, 303, path);
    assert.equal(stranger.headers.get("location"), "/admin/login", path);
  }

  // The page: a row per open request, oldest first, that reloads itself.
  const response = await see("/admin/tracker");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await response.text();
  assert.match(page, /<meta http-equiv="refresh" content="60">/);
  assert.match(page, /2 open requests\. Read from the site at /);
  assert.ok(page.includes('<th scope="row"><a href="/admin/requests/' + first.row.id + '">' + ref(first) + "</a></th>"));
  assert.ok(page.indexOf(ref(first)) < page.indexOf(ref(tricky)));
  assert.ok(page.includes("<td>Budget Fence LLC: $4,950.50</td>"));
  assert.ok(page.includes("<td>Premier Fence Co: waiting for quote</td>"));
  assert.ok(page.includes('<td class="num">1 of 2</td>'));
  assert.ok(page.includes("<td>No company yet</td>"));
  assert.ok(page.includes("=HYPERLINK(&quot;http://evil.test&quot;,&quot;Click&quot;)"));
  assert.doesNotMatch(page, /Closed Customer/);
  assert.match(page, /href="\/admin\/tracker\.xlsx">Download for Excel</);
  assert.match(await (await see("/admin")).text(), /href="\/admin\/tracker">Open the spreadsheet view<\/a> <a class="secondary" href="\/admin\/tracker\.xlsx">Download for Excel</);

  // The Excel file: a real workbook, built when asked for.
  const download = await see("/admin/tracker.xlsx");
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="AT-Legacy-requests-\d{4}-\d\d-\d\d\.xlsx"$/);
  assert.equal(download.headers.get("cache-control"), "no-store");
  const files = unzip(Buffer.from(await download.arrayBuffer()));
  assert.match(files["xl/workbook.xml"], /<sheet name="Open requests" sheetId="1" r:id="rId1"\/><sheet name="Company quotes" sheetId="2" r:id="rId2"\/><sheet name="All requests" sheetId="3" r:id="rId3"\/>/);
  const [openSheet, quoteSheet, allSheet] = [1, 2, 3].map((n) => files["xl/worksheets/sheet" + n + ".xml"]);

  // Open requests: two rows under a frozen, filterable header. Dates and money are real numbers.
  assert.match(openSheet, /<dimension ref="A1:U3"\/>/);
  assert.match(openSheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(openSheet, /<autoFilter ref="A1:U3"\/>/);
  assert.ok(openSheet.includes('<c r="A2" t="inlineStr" s="6"><is><t xml:space="preserve">' + ref(first) + "</t></is></c>"));
  assert.match(openSheet, /<c r="B2" s="3"><v>\d{5}\.\d+<\/v><\/c>/);
  assert.ok(openSheet.includes('<c r="L2" s="5"><v>1</v></c><c r="M2" s="5"><v>2</v></c><c r="N2" s="4"><v>4950.5</v></c>'));
  assert.ok(openSheet.includes("Budget Fence LLC: $4,950.50"));
  assert.ok(openSheet.includes('<c r="T2" s="5"><v>1</v></c>'));
  assert.ok(openSheet.includes(ref(first).toLowerCase() + "-dana</t>"));
  const openLinks = files["xl/worksheets/_rels/sheet1.xml.rels"];
  assert.ok(openLinks.includes('Target="' + site.base + "/admin/requests/" + first.row.id + '" TargetMode="External"'));
  // The file names each private link but holds no address that opens one.
  for (const [name, xml] of Object.entries(files)) {
    assert.ok(!xml.includes(first.row.token), name);
    for (const quote of quotes) assert.ok(!xml.includes(quote.token), name);
    assert.doesNotMatch(xml, /\/r\/|\/q\//, name);
  }
  assert.doesNotMatch(openSheet, /Closed Customer/);

  // What a customer typed stays text. Nothing in the workbook is a formula.
  assert.ok(openSheet.includes('<is><t xml:space="preserve">=HYPERLINK(&quot;http://evil.test&quot;,&quot;Click&quot;)</t></is>'));
  for (const [name, xml] of Object.entries(files)) assert.doesNotMatch(xml, /<f[ >]/, name);

  // Company quotes: one row per company on the open requests.
  assert.match(quoteSheet, /<dimension ref="A1:S3"\/>/);
  assert.ok(quoteSheet.includes("Budget Fence LLC") && quoteSheet.includes("Premier Fence Co"));
  assert.ok(quoteSheet.includes('<c r="I2" s="4"><v>4950.5</v></c>'));
  assert.ok(quoteSheet.includes("Materials &amp; labor &lt;all&gt;"));
  assert.ok(quoteSheet.includes("Waiting for quote"));
  assert.ok(quoteSheet.includes(">" + ref(first).toLowerCase() + "-affordable-budget-fence-llc</t>"));
  assert.ok(files["xl/worksheets/_rels/sheet2.xml.rels"].includes('Target="' + site.base + "/admin/requests/" + first.row.id + '" TargetMode="External"'));

  // All requests: the closed one too.
  assert.match(allSheet, /<dimension ref="A1:M4"\/>/);
  assert.ok(allSheet.includes("Closed Customer") && allSheet.includes(">Closed<"));

  // A fee shows up once a customer chooses.
  await site.form("/r/" + first.row.token + "/choose", { quote: String(quotes[0].id) });
  const later = unzip(Buffer.from(await (await see("/admin/tracker.xlsx")).arrayBuffer()));
  assert.ok(later["xl/worksheets/sheet3.xml"].includes('<c r="I2" s="4"><v>4950.5</v></c>'));
  assert.ok(later["xl/worksheets/sheet3.xml"].includes('<c r="K2" s="0"><v>5</v></c><c r="L2" s="4"><v>247.53</v></c>'));
  assert.ok(later["xl/worksheets/sheet3.xml"].includes(">No</t>"));
});

// A 16 by 12 pixel photo that carries what a phone writes into a picture: a GPS position,
// the camera's name, and a comment.
const PHOTO = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4QC8RXhpZgAATU0AKgAAAAgAAwEPAAIAAAANAAAAMgEQAAIAAAANAAAAQIglAAQAAAABAAAATgAAAABUZXN0Q2FtTWFrZXIAAFRlc3RDYW1Nb2RlbAAAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAIQAAwACAAAAAlcAAAAABAAFAAAAAwAAAJwAAAAAAAAAHAAAAAEAAAANAAAAAQAAAB4AAAABAAAAUgAAAAEAAAAbAAAAAQAAAA8AAAAB//4AFXRha2VuIGF0IDEyMyBPYWsgU3T/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDKJTy3ZpGaJm/ezfx3Dddq57dDz7E87Vp/7xZv4UnRfolon/xXPuQT3c8RpMxt5bwALJE6RRAdIgQx+X3+Xr7k9eakESC4S1xmJYPPZc/6xvK3/MfTt7DOOSSbez/rpf8AL/LRLXlX9ff/AF+e5//Z", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("pictures and files: sent by the customer, cleaned, and shown only to the right people", async () => {
  const files = require("../server/lib/files");
  const site = await start({ SITE_ORIGINS: "https://www.example.test" });
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };

  // The picture arrives with a GPS position, a camera name, and a comment. None of it is kept.
  assert.ok(PHOTO.includes("Exif") && PHOTO.includes("TestCamMaker") && PHOTO.includes("123 Oak St"));
  const cleaned = files.stripJpegMetadata(PHOTO);
  assert.ok(cleaned.length < PHOTO.length && cleaned[0] === 0xff && cleaned[1] === 0xd8);
  assert.ok(!cleaned.includes("Exif") && !cleaned.includes("TestCamMaker") && !cleaned.includes("123 Oak St"));
  assert.ok(cleaned.includes(Buffer.from([0xff, 0xc0])) && cleaned.includes(Buffer.from([0xff, 0xda])), "the picture itself is untouched");
  assert.deepEqual(cleaned.subarray(cleaned.indexOf(Buffer.from([0xff, 0xda]))), PHOTO.subarray(PHOTO.indexOf(Buffer.from([0xff, 0xda]))));
  assert.deepEqual(files.stripJpegMetadata(cleaned), cleaned, "cleaning twice changes nothing");
  assert.equal(files.stripJpegMetadata(PHOTO.subarray(0, 300)), null, "half a picture is not a picture");
  assert.equal(files.stripJpegMetadata(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), PHOTO.subarray(6)])), null, "a length that runs past the end");
  assert.equal(files.stripJpegMetadata(PNG), null);
  assert.equal(files.sniff(PDF), "application/pdf");
  assert.equal(files.sniff(PNG), "");
  assert.equal(files.cleanName("../../etc/Dana\u0000 Smith  yard.HEIC", "image/jpeg"), "Dana Smith yard.jpg");
  assert.equal(files.cleanName("", "application/pdf"), "document.pdf");
  // Companies get plain names, numbered the way the page lays the files out, and steady when one is held back.
  const pdf = "application/pdf";
  assert.deepEqual([...files.plainNames([{ id: 4, kind: "idea" }, { id: 5, kind: "document", mime: pdf }, { id: 6, kind: "site" }, { id: 7, kind: "document" }, { id: 8, kind: "site" }])],
    [[6, "Picture 1"], [8, "Picture 2"], [4, "Picture 3"], [5, "Document 1"], [7, "Document picture 1"]]);
  assert.equal(files.cleanName("C:\\Users\\dana\\survey.final.pdf", "application/pdf"), "survey.final.pdf");

  const { url, row } = await createRequest(site);
  const token = row.token;
  const send = (kind, name, body, type = "image/jpeg", to = token, headers = {}) => fetch(
    site.base + "/api/requests/" + to + "/files?kind=" + kind + "&name=" + encodeURIComponent(name),
    { method: "POST", headers: { "content-type": type, ...headers }, body }
  );
  const stored = async () => (await pool.query("select id, kind, name, mime, size, sharing from request_files where request_id = $1 order by id", [row.id])).rows;

  // A page on the site's own address may send a file to the hub.
  const preflight = await fetch(site.base + "/api/requests/" + token + "/files?kind=site&name=a.jpg", {
    method: "OPTIONS", headers: { origin: "https://www.example.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.example.test");
  assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/);

  // Pictures of the area and of ideas, and a document.
  const first = await send("site", "Dana <b>back yard.JPG", PHOTO, "image/jpeg", token, { origin: "https://www.example.test" });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("access-control-allow-origin"), "https://www.example.test");
  const firstFile = await first.json();
  assert.deepEqual({ kind: firstFile.kind, name: firstFile.name, size: firstFile.size }, { kind: "site", name: "Dana <b>back yard.jpg", size: cleaned.length });
  assert.equal((await send("idea", "pinterest.png", PHOTO)).status, 201);
  assert.equal((await send("document", "Smith survey.pdf", PDF, "application/pdf")).status, 201);
  let saved = await stored();
  assert.deepEqual(saved.map((file) => [file.kind, file.mime, file.sharing]), [["site", "image/jpeg", "shared"], ["idea", "image/jpeg", "shared"], ["document", "application/pdf", "review"]]);
  assert.equal(saved[1].name, "pinterest.jpg", "a picture's name ends the way the stored file does");
  const kept = (await pool.query("select data from request_files where id = $1", [saved[0].id])).rows[0].data;
  assert.deepEqual(kept, cleaned, "what is stored is the cleaned picture");

  // What is refused, and why.
  const refused = async (response, status, pattern) => {
    assert.equal(response.status, status);
    assert.match((await response.json()).error, pattern);
  };
  await refused(await send("site", "a.png", PNG), 415, /pictures and PDF files/);
  await refused(await send("site", "a.jpg", PHOTO.subarray(0, 300)), 415, /couldn’t read that picture/);
  await refused(await send("site", "plan.pdf", PDF, "application/pdf"), 415, /under Plans or documents/);
  await refused(await send("site", "a.txt", "hello", "text/plain"), 415, /pictures and PDF files/);
  await refused(await send("site", "a.jpg", Buffer.alloc(0)), 400, /empty/);
  await refused(await send("garden", "a.jpg", PHOTO), 400, /where this file belongs/);
  await refused(await send("site", "a.jpg", PHOTO, "image/jpeg", "not-a-real-secret"), 404, /couldn’t find that request/);
  await refused(await send("document", "big.pdf", Buffer.concat([PDF, Buffer.alloc(files.LIMITS.pdfBytes)]), "application/pdf"), 413, /over 3 MB/);
  await refused(await send("document", "huge.pdf", Buffer.concat([PDF, Buffer.alloc(files.BODY_LIMIT)]), "application/pdf"), 413, /too large/);
  await refused(await send("site", "big.jpg", Buffer.concat([PHOTO, Buffer.alloc(files.LIMITS.jpegBytes)])), 413, /too large/);
  assert.equal((await stored()).length, 3, "nothing refused was kept");

  // The customer's page shows them, lets the customer add more, and serves each one safely.
  const customerPage = await (await site.get(url)).text();
  assert.match(customerPage, /<h2>Pictures and files<\/h2>/);
  assert.match(customerPage, /<script src="\/uploads\.js\?v=[a-f0-9]{10}" defer><\/script>/);
  assert.ok(customerPage.includes('data-upload-to="' + token + '" data-upload-room="7"'));
  assert.ok(customerPage.includes("Dana &lt;b&gt;back yard.jpg") && !customerPage.includes("<b>back"));
  assert.match(customerPage, /Smith survey\.pdf[\s\S]*Only we can see this for now\./);
  const base = "/r/" + token + "/files/";
  const picture = await site.get(base + saved[0].id);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get("content-type"), "image/jpeg");
  assert.equal(picture.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
  assert.equal(picture.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(picture.headers.get("content-disposition"), 'inline; filename="Dana _b_back yard.jpg"');
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), cleaned);
  const survey = await site.get(base + saved[2].id);
  assert.equal(survey.headers.get("content-type"), "application/pdf");
  assert.match(survey.headers.get("content-disposition"), /^attachment; filename="Smith survey\.pdf"$/);
  assert.equal((await site.get(base + "999999")).status, 404);
  assert.equal((await site.get(base + "abc")).status, 404);
  // Another customer's secret doesn't open this customer's files.
  const other = await createRequest(site, { name: "Other Person" });
  assert.equal((await site.get("/r/" + other.row.token + "/files/" + saved[0].id)).status, 404);

  // The owner sees everything, and is told a document is waiting.
  const home = await (await site.get("/admin", cookie)).text();
  assert.ok(home.includes('<a href="/admin/requests/' + row.id + '#files">1 document to check before any company sees it</a>'));
  assert.match(home, /pictures and files use \d KB of the 200 MB set aside for them/);
  const ownerPage = await (await site.get("/admin/requests/" + row.id, cookie)).text();
  assert.match(ownerPage, /<section class="app-section" id="files">/);
  assert.ok(ownerPage.includes("Dana &lt;b&gt;back yard.jpg") && !ownerPage.includes("<b>back") && ownerPage.includes("Smith survey.pdf"));
  assert.match(ownerPage, /class="file-state needs-you">No company can see this until you decide\./);
  const ownerFile = "/admin/requests/" + row.id + "/files/";
  assert.equal((await site.get(ownerFile + saved[2].id, cookie)).status, 200);
  assert.equal((await site.get(ownerFile + saved[2].id)).status, 303, "signed out: sent to the login page");
  assert.equal((await site.get("/admin/requests/" + other.row.id + "/files/" + saved[2].id, cookie)).status, 404);

  // Two companies are invited. Each sees the pictures under plain names, and not the document.
  const budget = await addVerifiedPartner(site, admin, "Budget Fence LLC", "Affordable");
  const crown = await addVerifiedPartner(site, admin, "Crown Fence & Gate", "Premium");
  for (const [partner, tier] of [[budget, "Affordable"], [crown, "Premium"]]) {
    assert.equal((await site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, partner: String(partner.id), tier }, cookie)).status, 303);
  }
  const quotes = (await pool.query("select * from quotes where request_id = $1 order by id", [row.id])).rows;
  const companyUrl = "/q/" + quotes[0].token;
  let companyPage = await (await site.get(companyUrl)).text();
  assert.match(companyPage, /<h2>Pictures from the customer<\/h2>/);
  assert.ok(companyPage.includes('alt="Picture 1"') && companyPage.includes('alt="Picture 2"'));
  assert.ok(companyPage.includes("<h3>Ideas the customer likes</h3>") && !companyPage.includes("Ideas you like"));
  assert.ok(!/Dana|Smith|yard|survey|pinterest|Document/.test(companyPage), "no file names, and no document");
  assert.ok(!companyPage.includes("uploads.js") && !companyPage.includes("/remove"));
  const shownPicture = await site.get(companyUrl + "/files/" + saved[0].id);
  assert.equal(shownPicture.status, 200);
  assert.equal(shownPicture.headers.get("content-disposition"), 'inline; filename="Picture 1.jpg"');
  assert.equal((await site.get(companyUrl + "/files/" + saved[2].id)).status, 404, "the document is not shared yet");
  const elsewhere = await createRequest(site, { name: "Third Person" });
  assert.equal((await site.form("/admin/requests/" + elsewhere.row.id + "/invite", { csrf: admin.csrf, partner: String(budget.id), tier: "Affordable" }, cookie)).status, 303);
  const otherQuote = (await pool.query("select token from quotes where request_id = $1", [elsewhere.row.id])).rows[0];
  assert.equal((await site.get("/q/" + otherQuote.token + "/files/" + saved[0].id)).status, 404, "a quote link opens only its own request's files");
  assert.doesNotMatch(await (await site.get("/q/" + otherQuote.token)).text(), /Pictures from the customer/);

  // The owner shares the document and holds back a picture.
  const share = (id, sharing, fields = { csrf: admin.csrf }) => site.form(ownerFile + id + "/sharing", { ...fields, sharing }, cookie);
  assert.equal((await share(saved[2].id, "shared", {})).status, 403, "needs the form token");
  assert.equal((await share(saved[2].id, "review")).status, 303);
  assert.equal((await stored())[2].sharing, "review", "review is where a document starts, not a choice");
  const shared = await share(saved[2].id, "shared");
  assert.equal(shared.status, 303);
  assert.equal(shared.headers.get("location"), "/admin/requests/" + row.id + "#files");
  assert.equal((await share(saved[1].id, "private")).status, 303);
  assert.deepEqual((await stored()).map((file) => file.sharing), ["shared", "private", "shared"]);
  companyPage = await (await site.get(companyUrl)).text();
  assert.ok(companyPage.includes('alt="Picture 1"') && !companyPage.includes('alt="Picture 2"') && companyPage.includes("Document 1"));
  const sharedSurvey = await site.get(companyUrl + "/files/" + saved[2].id);
  assert.equal(sharedSurvey.status, 200);
  assert.equal(sharedSurvey.headers.get("content-disposition"), 'attachment; filename="Document 1.pdf"');
  assert.equal((await site.get(companyUrl + "/files/" + saved[1].id)).status, 404, "the picture the owner held back");
  assert.doesNotMatch(await (await site.get("/admin", cookie)).text(), /to check before any company/);
  assert.match(await (await site.get(url)).text(), /Smith survey\.pdf[\s\S]*Shared with the companies quoting\./);

  // The customer takes a picture back, and adds until the request is full.
  const removed = await site.form(base + saved[1].id + "/remove", {});
  assert.equal(removed.status, 303);
  assert.match(removed.headers.get("location"), /#files$/);
  assert.equal((await site.form("/r/" + other.row.token + "/files/" + saved[0].id + "/remove", {})).status, 303);
  assert.deepEqual((await stored()).map((file) => file.id), [saved[0].id, saved[2].id], "only their own file, and only with their own secret");
  for (let count = 2; count < files.LIMITS.filesPerRequest; count += 1) {
    assert.equal((await send("idea", "idea " + count + ".jpg", PHOTO)).status, 201);
  }
  await refused(await send("idea", "one too many.jpg", PHOTO), 409, /can hold 10 files/);
  // Uploads that arrive at the same moment are still counted one at a time.
  await pool.query("delete from request_files where id = (select max(id) from request_files where request_id = $1)", [row.id]);
  const together = await Promise.all([1, 2, 3, 4].map((n) => send("idea", "together " + n + ".jpg", PHOTO)));
  assert.deepEqual(together.map((response) => response.status).sort(), [201, 409, 409, 409]);
  assert.equal((await stored()).length, files.LIMITS.filesPerRequest);
  const fullPage = await (await site.get(url)).text();
  assert.match(fullPage, /This request holds 10 files/);
  assert.ok(!fullPage.includes("data-upload-to"));

  // Once the customer chooses, the company that wasn't chosen no longer sees the files. The chosen one does.
  for (const quote of quotes) {
    assert.equal((await site.form("/q/" + quote.token, { action: "submit", amount: "4000", timeline: "2 weeks", includes: "Everything" })).status, 303);
  }
  assert.equal((await site.form("/r/" + token + "/choose", { quote: String(quotes[1].id) })).status, 303);
  assert.equal((await site.get(companyUrl + "/files/" + saved[0].id)).status, 404);
  assert.doesNotMatch(await (await site.get(companyUrl)).text(), /Pictures from the customer/);
  assert.equal((await site.get("/q/" + quotes[1].token + "/files/" + saved[0].id)).status, 200);
  assert.match(await (await site.get("/q/" + quotes[1].token)).text(), /Pictures from the customer/);

  // A closed request takes nothing more, and keeps what it has.
  assert.equal((await site.form("/admin/requests/" + other.row.id + "/status", { csrf: admin.csrf, status: "closed" }, cookie)).status, 303);
  await refused(await send("site", "late.jpg", PHOTO, "image/jpeg", other.row.token), 409, /closed/);
  await pool.query("insert into request_files (request_id, kind, name, mime, size, data) values ($1, 'site', 'kept.jpg', 'image/jpeg', $2, $3)", [other.row.id, cleaned.length, cleaned]);
  const keptFile = (await pool.query("select id from request_files where request_id = $1", [other.row.id])).rows[0];
  assert.equal((await site.form("/r/" + other.row.token + "/files/" + keptFile.id + "/remove", {})).status, 303);
  assert.equal((await pool.query("select count(*)::int as n from request_files where request_id = $1", [other.row.id])).rows[0].n, 1);
  const closedPage = await (await site.get(other.url)).text();
  assert.ok(!closedPage.includes("data-upload-to") && !closedPage.includes("/remove"));

  // The storage set aside for files is a hard stop, and the owner is warned before it fills.
  const realTotal = files.LIMITS.totalBytes;
  files.LIMITS.totalBytes = (await files.storageUsed(pool)) + 100;
  const fresh = await createRequest(site, { name: "Fourth Person" });
  await refused(await send("site", "no room.jpg", PHOTO, "image/jpeg", fresh.row.token), 507, /can’t take more files right now/);
  assert.match(await (await site.get("/admin", cookie)).text(), /Picture storage is 9\d% full/);
  files.LIMITS.totalBytes = realTotal;
  assert.equal((await send("site", "room again.jpg", PHOTO, "image/jpeg", fresh.row.token)).status, 201);

  // Deleting a request takes its files with it.
  await pool.query("delete from quotes where request_id = $1", [fresh.row.id]);
  await pool.query("delete from requests where id = $1", [fresh.row.id]);
  assert.equal((await pool.query("select count(*)::int as n from request_files where request_id = $1", [fresh.row.id])).rows[0].n, 0);
});

test("the request form carries the same file buttons as the customer's page, and the build ships the uploader", () => {
  const files = require("../server/lib/files");
  const site = path.join(__dirname, "..", "site");
  const squash = (html) => html.replace(/\s+/g, " ").replace(/> </g, "><").trim();
  const form = fs.readFileSync(path.join(site, "quote.html"), "utf8");
  const picker = form.slice(form.indexOf('<div class="file-groups" data-uploads>'), form.indexOf("</section>", form.indexOf('<div class="file-groups" data-uploads>')));
  assert.equal(squash(picker), squash(files.pickerHtml()));
  // The uploader loads before the form's own script, which uses it.
  assert.ok(form.indexOf('src="uploads.js"') > 0 && form.indexOf('src="uploads.js"') < form.indexOf('src="quote.js"'));
  // The limits the browser checks are the ones the server enforces.
  const uploader = fs.readFileSync(path.join(site, "uploads.js"), "utf8");
  assert.ok(uploader.includes("var MAX_FILES = " + files.LIMITS.filesPerRequest + ";"));
  assert.ok(uploader.includes("var PDF_BYTES = 3 * 1024 * 1024;") && files.LIMITS.pdfBytes === 3 * 1024 * 1024);
  assert.ok(Number(/var JPEG_BYTES = (\d+);/.exec(uploader)[1]) < files.LIMITS.jpegBytes);
  // The pictures a browser may show are its own files and ones it drew itself. The uploader needs nothing more.
  assert.ok(!/createObjectURL|innerHTML|\.style\./.test(uploader));
});

test("business details: one file fills every page, and an empty detail takes its section away", async () => {
  const business = require("../server/lib/business");
  const filled = business.details({ phone: "(813) 555-0142", owner: " Ty ", about: ["Built here. <b>", "  "], hours: "Monday to Saturday", reply: "one business day", email: "hello@example.test", emailReady: true });
  assert.deepEqual([filled.phone, filled.phoneHref, filled.smsHref, filled.owner, filled.about, filled.email, filled.direct],
    ["(813) 555-0142", "tel:+18135550142", "sms:+18135550142", "Ty", ["Built here. <b>"], "hello@example.test", true]);
  assert.equal(business.details({ phone: "555-0142" }).phone, "", "a number that can't be dialed is not shown");
  assert.equal(business.details({ email: "hello@example.test" }).email, "", "an address is shown only once it is marked as working");
  const page = "A<!--if:phone-->[{{phone}}|{{phoneHref}}]<!--/if:phone-->B<!--if:!phone-->none<!--/if:!phone-->C<!--if:about-->{{aboutParagraphs}}<!--/if:about-->";
  assert.equal(business.fill(page, filled), "A[(813) 555-0142|tel:+18135550142]BC<p>Built here. &lt;b&gt;</p>");
  assert.equal(business.fill(page, business.details({})), "ABnoneC");

  // The repository's own file starts empty, so the live pages show no phone number, no email, and nothing half filled.
  const site = await start();
  const names = ["", "quote", "partners", "about", "standard", "approved", "contact", "privacy", "terms"];
  for (const name of names) {
    const response = await site.get("/" + name);
    assert.equal(response.status, 200, name);
    const html = await response.text();
    assert.ok(!/\{\{|<!--\/?if:/.test(html), name + " has nothing left unfilled");
    assert.ok(!html.includes("hello@atlegacyservices.com") && !html.includes("tel:"), name + " shows no contact detail that isn't set");
    assert.ok(html.includes('href="/privacy"') && html.includes('href="/terms"') && html.includes('href="/contact"'), name + " links the policy pages");
    assert.ok(html.includes('rel="canonical" href="https://atlegacyservices.com/' + name + '"'), name + " names its own address");
    assert.ok(html.includes('rel="apple-touch-icon"'), name);
    assert.equal((await site.get("/" + name + (name ? ".html" : "index.html"))).status, 200);
  }
  const about = await (await site.get("/about")).text();
  assert.match(about, /run by AT Legacy Group LLC, a Florida company based in Land O&rsquo; Lakes/);
  assert.doesNotMatch(await (await site.get("/contact")).text(), /Reach us directly/);
  const home = await (await site.get("/")).text();
  assert.match(home, /<strong>One company gets your number<\/strong>/);
  assert.match(home, /<summary>Who gets my phone number\?<\/summary>/);
  assert.match(home, /<section class="band reviews" id="reviews" aria-labelledby="reviews-title" hidden>/);
  assert.ok(home.indexOf('src="config.js') > 0 && home.indexOf('src="config.js') < home.indexOf('src="home.js'), "the home page knows where the API is");
  assert.doesNotThrow(() => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)[1]));
  for (const file of ["apple-touch-icon.png", "favicon-48.png", "favicon.ico", "contact.js", "standard.js"]) assert.equal((await site.get("/" + file)).status, 200, file);
  const map = fs.readFileSync(path.join(__dirname, "..", "site", "sitemap.xml"), "utf8");
  for (const name of names) assert.ok(map.includes("<loc>https://atlegacyservices.com/" + name + "</loc>"), name);
  assert.ok(!map.includes(".html"));

  // With details filled in, the same pages show them. Checked on the built copy, which is what the public site serves.
  const root = path.join(__dirname, "..");
  const real = fs.readFileSync(path.join(root, "business.json"), "utf8");
  try {
    fs.writeFileSync(path.join(root, "business.json"), JSON.stringify({ phone: "813-555-0142", owner: "Ty Sample", about: ["I started this after one too many pushy sales calls."], hours: "Monday to Saturday, 8 to 6", reply: "one business day", email: "hello@atlegacyservices.com", emailReady: true }));
    const built = spawnSync(process.execPath, ["scripts/build-site.js"], { cwd: root, env: { ...process.env, HUB_URL: "https://hub.example.test" }, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const read = (name) => fs.readFileSync(path.join(root, "dist", name), "utf8");
    assert.match(read("index.html"), /Call or text <a class="plain-link" href="tel:\+18135550142">813-555-0142<\/a>/);
    assert.equal(JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read("index.html"))[1]).telephone, "813-555-0142");
    assert.match(read("about.html"), /<p>I started this after one too many pushy sales calls\.<\/p>\s*<p class="read-sign">Ty Sample, Owner<\/p>/);
    assert.doesNotMatch(read("about.html"), /run by AT Legacy Group LLC, a Florida company/);
    assert.match(read("contact.html"), /Reach us directly[\s\S]*813-555-0142<\/a>, Monday to Saturday, 8 to 6[\s\S]*mailto:hello@atlegacyservices\.com/);
    assert.match(read("contact.html"), /We answer within one business day\./);
    for (const name of fs.readdirSync(path.join(root, "dist")).filter((file) => file.endsWith(".html"))) assert.ok(!/\{\{|<!--\/?if:/.test(read(name)), name);
    assert.match(read("contact.html"), /src="contact\.js\?v=[a-f0-9]{10}"/);
  } finally {
    fs.writeFileSync(path.join(root, "business.json"), real);
    fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
  }
});

test("contact messages, coverage, and the public standard", async () => {
  const mail = [];
  const site = await start({ RESEND_API_KEY: "test-key", NOTIFY_FROM: "site@example.test", NOTIFY_TO: "owner@example.test", SITE_ORIGINS: "https://www.example.test" },
    async (url, options) => { mail.push(JSON.parse(options.body)); return { ok: true, status: 200 }; });
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };

  // A message from the contact page.
  const bad = async (body, pattern) => {
    const response = await site.json("/api/messages", body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, pattern);
  };
  await bad({ name: "", reach: "813-555-0100", message: "Hello there" }, /your name/);
  await bad({ name: "Pat", reach: "call me", message: "Hello there" }, /phone number or an email/);
  await bad({ name: "Pat", reach: "pat@example.test", message: "Hi" }, /Write your message/);
  assert.equal((await site.json("/api/messages", { name: "Bot", reach: "bot@example.test", message: "Buy my links", company_url: "http://spam.test" })).status, 201);
  assert.equal((await pool.query("select count(*)::int as n from messages")).rows[0].n, 0, "a filled trap field is thrown away");
  assert.equal((await site.json("/api/messages", { name: "Pat <b>Lee", reach: "(813) 555-0100", message: "Do you cover Lutz?\n\n\n\nThanks <script>" })).status, 201);
  assert.equal((await site.json("/api/messages", { name: "Sam", reach: "sam@example.test", message: "A second question" })).status, 201);
  assert.deepEqual(mail.map((m) => [m.to[0], m.subject]), [["owner@example.test", "New message from Pat <b>Lee"], ["owner@example.test", "New message from Sam"]]);
  assert.match(await (await site.get("/admin", cookie)).text(), /<a href="\/admin\/messages">2 messages to answer<\/a>/);
  let inbox = await (await site.get("/admin/messages", cookie)).text();
  assert.ok(inbox.includes("Pat &lt;b&gt;Lee") && inbox.includes('<a href="tel:8135550100">(813) 555-0100</a>') && inbox.includes('<a href="mailto:sam@example.test">sam@example.test</a>'));
  assert.ok(inbox.includes("Do you cover Lutz?\n\nThanks &lt;script&gt;") && !inbox.includes("<script>"));
  assert.equal((await site.get("/admin/messages")).status, 303, "signed out: sent to the login page");
  const first = (await pool.query("select id from messages order by id limit 1")).rows[0].id;
  assert.equal((await site.form("/admin/messages/" + first + "/handled", { handled: "1" }, cookie)).status, 403, "needs the form token");
  assert.equal((await site.form("/admin/messages/" + first + "/handled", { csrf: admin.csrf, handled: "1" }, cookie)).status, 303);
  assert.match(await (await site.get("/admin", cookie)).text(), /1 message to answer/);
  // An answered message can be deleted. One still waiting can't.
  const second = (await pool.query("select id from messages order by id desc limit 1")).rows[0].id;
  assert.equal((await site.form("/admin/messages/" + second + "/handled", { csrf: admin.csrf, handled: "delete" }, cookie)).status, 303);
  assert.equal((await pool.query("select count(*)::int as n from messages")).rows[0].n, 2);
  assert.match(await (await site.get("/admin/messages", cookie)).text(), /value="delete">Delete it<\/button>/);
  assert.equal((await site.form("/admin/messages/" + first + "/handled", { csrf: admin.csrf, handled: "delete" }, cookie)).status, 303);
  assert.deepEqual((await pool.query("select name from messages")).rows.map((row) => row.name), ["Sam"]);
  for (let count = 0; count < 4; count += 1) await site.json("/api/messages", { name: "Again", reach: "again@example.test", message: "One more message" });
  assert.equal((await site.json("/api/messages", { name: "Again", reach: "again@example.test", message: "One more message" })).status, 429, "ten tries an hour from one connection");

  // Coverage: which tiers have an approved company. The owner's own crew always covers its service.
  // (Other tests approve fence companies in the same database, so this one uses water softeners.)
  let coverage = await (await site.get("/api/coverage")).json();
  assert.deepEqual(coverage["Water softener"], []);
  assert.deepEqual(coverage["Home repairs and upkeep"], ["Affordable", "Mid-range", "Premium"]);
  await addVerifiedPartner(site, admin, "Coverage Water Co", "Premium", "Water softener");
  await site.form("/admin/partners", { csrf: admin.csrf, company: "Not Yet Water", contact_name: "A", trade: "Water softener", tier: "Affordable", status: "applied" }, cookie);
  coverage = await (await site.get("/api/coverage")).json();
  assert.deepEqual(coverage["Water softener"], ["Premium"], "an applicant doesn't count");
  assert.deepEqual(coverage["Lawn pest control"], []);
  assert.deepEqual(Object.keys(coverage).length, 12);

  // The public standard: the owner's wording, without the points or the numbers each tier needs.
  const { DEFAULT_STANDARD } = require("../server/lib/standard");
  const standard = await (await site.get("/api/standard")).json();
  assert.deepEqual(Object.keys(standard).sort(), ["months", "more", "must"]);
  assert.deepEqual(standard.must, DEFAULT_STANDARD.items.filter((item) => item.kind === "must").map((item) => item.label));
  assert.equal(standard.more.length, DEFAULT_STANDARD.items.filter((item) => item.kind === "points").length);
  assert.equal(standard.months, 12);
  assert.ok(!/points|premium|mid/i.test(JSON.stringify(Object.keys(standard))) && typeof standard.more[0] === "string");
  assert.match(await (await site.get("/admin/standard", cookie)).text(), /Customers can read these items\./);
  // The public pages live at another address and read these answers from there.
  for (const path of ["/api/standard", "/api/coverage", "/api/reviews"]) {
    const fromSite = await fetch(site.base + path, { headers: { origin: "https://www.example.test" } });
    assert.equal(fromSite.headers.get("access-control-allow-origin"), "https://www.example.test", path);
  }
});

test("a quote line by line: the company record, the side-by-side table, the link to keep, and a rating after the job", async () => {
  const mail = [];
  const site = await start({ RESEND_API_KEY: "test-key", NOTIFY_FROM: "site@example.test", NOTIFY_TO: "owner@example.test" },
    async (url, options) => { mail.push(JSON.parse(options.body)); return { ok: true, status: 200 }; });
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };
  const { url, row } = await createRequest(site, { email: "dana@example.test" });
  // The customer who gave an email gets their private link by email.
  const copy = mail.find((m) => m.to[0] === "dana@example.test");
  assert.ok(copy && copy.text.includes("https://example.test" + url) && copy.subject === "Your quote request with AT Legacy Services");
  assert.ok(mail.some((m) => m.to[0] === "owner@example.test" && /New quote request/.test(m.subject)));

  const budget = await addVerifiedPartner(site, admin, "Budget Fence LLC", "Affordable");
  const crown = await addVerifiedPartner(site, admin, "Crown <Fence> & Gate", "Premium");
  await pool.query("update partners set license_no = 'CFC1429999' where id = $1", [crown.id]);
  await pool.query("update partners set license_no = 'UNCHECKED-1', check_license = false where id = $1", [budget.id]);
  for (const [partner, tier] of [[budget, "Affordable"], [crown, "Premium"]]) {
    assert.equal((await site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, partner: String(partner.id), tier }, cookie)).status, 303);
  }
  const quotes = (await pool.query("select * from quotes where request_id = $1 order by id", [row.id])).rows;

  // Before any quote: a way to keep the link, and nothing to compare or rate.
  let page = await (await site.get(url)).text();
  assert.match(page, /<h2>Keep this page<\/h2>/);
  assert.ok(page.includes('data-copy-text="' + site.base + url + '"') && page.includes('href="sms:?&amp;body=') && page.includes('href="mailto:?subject='));
  assert.ok(!page.includes("compare") && !page.includes("data-print") && !page.includes('id="rating"'));
  assert.doesNotMatch(await (await site.get(url + "?owner=1")).text(), /Keep this page/, "the owner's preview has no use for it");

  // The company's form asks for the lines customers compare.
  const form = await (await site.get("/q/" + quotes[1].token)).text();
  for (const name of ["excludes", "start_by", "permit", "payment_terms", "warranty"]) assert.ok(form.includes('name="' + name + '"'), name);
  mail.length = 0;
  assert.equal((await site.form("/q/" + quotes[1].token, {
    action: "submit", amount: "9,800", timeline: "5 working days", includes: "Remove the old fence. New vinyl fence and one gate.", warranty: "5 years on labor",
    excludes: "Tree removal <stumps>", start_by: "The week of December 8", payment_terms: "30% to start, the rest when done", permit: "No permit is needed"
  })).status, 303);
  assert.equal((await site.form("/q/" + quotes[0].token, { action: "submit", amount: "6400", timeline: "About 2 weeks", includes: "New vinyl fence and one gate.", permit: "Something made up" })).status, 303);
  assert.deepEqual(mail.map((m) => m.subject), ["A quote is in from Crown <Fence> & Gate", "A quote is in from Budget Fence LLC"]);
  const saved = (await pool.query("select excludes, start_by, payment_terms, permit from quotes where id = $1", [quotes[1].id])).rows[0];
  assert.deepEqual(saved, { excludes: "Tree removal <stumps>", start_by: "The week of December 8", payment_terms: "30% to start, the rest when done", permit: "No permit is needed" });
  assert.equal((await pool.query("select permit from quotes where id = $1", [quotes[0].id])).rows[0].permit, "", "only the listed permit answers are kept");
  assert.ok((await (await site.get("/q/" + quotes[1].token)).text()).includes('<option selected>No permit is needed</option>'));

  // Each quote reads in the same order, and carries what we have on file about its company.
  page = await (await site.get(url)).text();
  const card = (company) => {
    const from = page.indexOf('<p class="quote-company">' + company);
    const next = page.indexOf('<p class="quote-company">', from + 10);
    return page.slice(from, next > 0 ? next : page.indexOf("Each quote comes from", from));
  };
  const crownCard = card("Crown &lt;Fence&gt; &amp; Gate");
  assert.deepEqual([...crownCard.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["Included", "Not included", "Timeline", "Earliest start", "Payment terms", "Permit", "Warranty"]);
  assert.ok(crownCard.includes("Tree removal &lt;stumps&gt;") && !crownCard.includes("<stumps>"));
  assert.match(crownCard, /<h4>Company record<\/h4>/);
  assert.ok(crownCard.includes("Approved vendor AV-" + (1000 + crown.id) + ", since "));
  assert.match(crownCard, /Passed our site visit on [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  assert.ok(crownCard.includes("License checked: County license where required, number CFC1429999") && crownCard.includes("Proof of liability insurance on file") && crownCard.includes("Local references checked"));
  assert.match(crownCard, /<p class="record-shown">Shown at our visit<\/p>\s*<ul>\s*<li>In business 3 years or more<\/li>/);
  const budgetCard = card("Budget Fence LLC");
  assert.deepEqual([...budgetCard.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["Included", "Timeline"]);
  assert.ok(!budgetCard.includes("UNCHECKED-1") && !budgetCard.includes("License checked"), "a license number we haven't checked is not shown");
  assert.doesNotMatch(page, /myfloridalicense/, "a county license can't be looked up on the state's site");
  // A trade the state licenses names that license, and points to where the customer can look it up.
  await pool.query("update partners set trade = 'Pool' where id = $1", [crown.id]);
  const asPool = await (await site.get(url)).text();
  assert.ok(asPool.includes("License checked: DBPR pool contractor license, number CFC1429999"));
  assert.match(asPool, /look up a Florida contractor&rsquo;s license yourself at <a href="https:\/\/www\.myfloridalicense\.com"/);
  await pool.query("update partners set trade = 'Fence' where id = $1", [crown.id]);
  assert.match(page, /<section class="app-section quote-list has-compare">/);
  assert.match(page, /<button class="secondary" type="button" data-print>Print or save as a PDF<\/button>/);

  // Two quotes: a table that lines them up.
  const table = page.slice(page.indexOf('<table class="compare">'), page.indexOf("</table>"));
  assert.deepEqual([...table.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]),
    ["Price", "Included", "Not included", "Timeline", "Earliest start", "Payment terms", "Permit", "Warranty", "Company record"]);
  assert.match(table, /<th scope="col">Affordable<span>Budget Fence LLC<\/span><\/th><th scope="col">Premium<span>Crown &lt;Fence&gt; &amp; Gate<\/span><\/th>/);
  assert.match(table, /<th scope="row">Price<\/th><td><strong>\$6,400<\/strong><\/td><td><strong>\$9,800<\/strong><\/td>/);
  assert.match(table, /<th scope="row">Warranty<\/th><td><span class="compare-none">Not stated<\/span><\/td><td>5 years on labor<\/td>/);

  // A rating is only for a customer who chose, and only once.
  assert.equal((await site.form("/r/" + row.token + "/rating", { stars: "5", again: "yes" })).status, 303);
  assert.equal((await pool.query("select count(*)::int as n from ratings")).rows[0].n, 0, "nothing to rate before choosing");
  mail.length = 0;
  assert.equal((await site.form("/r/" + row.token + "/choose", { quote: String(quotes[1].id) })).status, 303);
  assert.deepEqual(mail.map((m) => m.subject), ["A customer chose Crown <Fence> & Gate"]);
  page = await (await site.get(url)).text();
  assert.match(page, /<h2>When the job is done<\/h2>/);
  assert.doesNotMatch(page, /Keep this page/);
  for (const wrong of [{ stars: "6", again: "yes" }, { stars: "abc", again: "yes" }, { stars: "4", again: "maybe" }, { stars: "4" }]) {
    assert.equal((await site.form("/r/" + row.token + "/rating", wrong)).status, 303);
  }
  assert.equal((await pool.query("select count(*)::int as n from ratings")).rows[0].n, 0);
  const rated = await site.form("/r/" + row.token + "/rating", { stars: "4", again: "yes", comment: "On time and tidy. <b>Would</b> call again.", may_publish: "on" });
  assert.equal(rated.status, 303);
  assert.match(rated.headers.get("location"), /#rating$/);
  assert.equal((await site.form("/r/" + row.token + "/rating", { stars: "1", again: "no", comment: "changed my mind" })).status, 303);
  const rating = (await pool.query("select * from ratings")).rows;
  assert.equal(rating.length, 1);
  assert.deepEqual([rating[0].stars, rating[0].again, rating[0].may_publish, rating[0].published, rating[0].quote_id], [4, true, true, false, quotes[1].id]);
  page = await (await site.get(url)).text();
  assert.match(page, /You gave Crown &lt;Fence&gt; &amp; Gate 4 out of 5/);
  assert.ok(page.includes("On time and tidy. &lt;b&gt;Would&lt;/b&gt; call again.") && !page.includes('action="/r/' + row.token + '/rating"'));

  // The owner reads it, and decides whether it goes on the site.
  assert.match(await (await site.get("/admin", cookie)).text(), /<a href="\/admin\/ratings">1 new rating to read<\/a>/);
  assert.deepEqual(await (await site.get("/api/reviews")).json(), [], "nothing is public until the owner turns it on");
  const ratings = await (await site.get("/admin/ratings", cookie)).text();
  assert.ok(ratings.includes("★★★★☆") && ratings.includes("Crown &lt;Fence&gt; &amp; Gate") && ratings.includes("&lt;b&gt;Would&lt;/b&gt;") && ratings.includes("The customer said you may show this."));
  assert.doesNotMatch(await (await site.get("/admin", cookie)).text(), /new rating/, "reading the page marks it read");
  assert.equal((await site.form("/admin/ratings/" + rating[0].id + "/published", { published: "1" }, cookie)).status, 403, "needs the form token");
  assert.equal((await site.form("/admin/ratings/" + rating[0].id + "/published", { csrf: admin.csrf, published: "1" }, cookie)).status, 303);
  const reviews = await (await site.get("/api/reviews")).json();
  assert.equal(reviews.length, 1);
  assert.deepEqual([reviews[0].stars, reviews[0].name, reviews[0].service, reviews[0].company, reviews[0].comment], [4, "Dana", "Fence", "Crown <Fence> & Gate", "On time and tidy. <b>Would</b> call again."]);
  assert.ok(!JSON.stringify(reviews).includes("Customer") && !JSON.stringify(reviews).includes("813"), "a first name only, and no contact details");
  assert.match(await (await site.get("/admin/partners/" + crown.id, cookie)).text(), /<h2>Customer ratings<\/h2>\s*<p class="form-note">4\.0 out of 5, from 1 job\./);
  // A rating the customer didn't agree to share can never be shown.
  await pool.query("update ratings set may_publish = false, published = false");
  assert.equal((await site.form("/admin/ratings/" + rating[0].id + "/published", { csrf: admin.csrf, published: "1" }, cookie)).status, 303);
  assert.equal((await pool.query("select published from ratings")).rows[0].published, false);
  assert.deepEqual(await (await site.get("/api/reviews")).json(), []);
  assert.match(await (await site.get("/admin/ratings", cookie)).text(), /didn&rsquo;t agree to show this publicly/);

  // The owner can delete a request for good, as the privacy page promises. It asks first, and takes everything with it.
  assert.match(await (await site.get("/admin/requests/" + row.id, cookie)).text(), new RegExp('href="/admin/requests/' + row.id + '/delete">Delete this request</a>'));
  const ask = await (await site.get("/admin/requests/" + row.id + "/delete", cookie)).text();
  assert.match(ask, /<h1[^>]*>Delete this request\?<\/h1>/);
  assert.ok(ask.includes("2 quotes and the links sent for them") && ask.includes("The customer&rsquo;s rating") && ask.includes("The customer chose Crown &lt;Fence&gt; &amp; Gate") && ask.includes("($490)"));
  assert.equal((await site.get("/admin/requests/" + row.id + "/delete")).status, 303, "signed out: sent to the login page");
  assert.equal((await site.form("/admin/requests/" + row.id + "/delete", { confirm: "yes" }, cookie)).status, 403, "needs the form token");
  assert.equal((await site.form("/admin/requests/" + row.id + "/delete", { csrf: admin.csrf }, cookie)).headers.get("location"), "/admin/requests/" + row.id, "nothing happens without the confirmation");
  assert.equal((await pool.query("select count(*)::int as n from requests where id = $1", [row.id])).rows[0].n, 1);
  const gone = await site.form("/admin/requests/" + row.id + "/delete", { csrf: admin.csrf, confirm: "yes" }, cookie);
  assert.deepEqual([gone.status, gone.headers.get("location")], [303, "/admin"]);
  for (const table of ["quotes", "ratings", "link_events", "request_files"]) {
    assert.equal((await pool.query(`select count(*)::int as n from ${table} where request_id = $1`, [row.id])).rows[0].n, 0, table);
  }
  assert.equal((await pool.query("select count(*)::int as n from requests where id = $1", [row.id])).rows[0].n, 0);
  assert.equal((await site.get(url)).status, 404, "the customer's link stops working");
  assert.equal((await site.get("/admin/requests/" + row.id + "/delete", cookie)).status, 404);
  assert.equal((await pool.query("select count(*)::int as n from partners where id = any($1)", [[budget.id, crown.id]])).rows[0].n, 2, "the companies stay");
});

test("services: the owner switches each one on or off, and the site follows", async () => {
  const site = await start();
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };
  const { SERVICE_NAMES } = require("../server/lib/catalog");
  const save = (...names) => site.form("/admin/services", [["csrf", admin.csrf], ...names.map((name) => ["live", name])], cookie);
  const rowOf = (page, name) => page.slice(page.indexOf('value="' + name + '"'), page.indexOf("</li>", page.indexOf('value="' + name + '"')));
  const mowing = { ...JOB, ...CONTACT, service: "Lawn mowing", tiers: ["Affordable"] };
  try {
    // To start, every service is on.
    assert.deepEqual(await (await site.get("/api/services")).json(), { off: [] });
    let page = await (await site.get("/admin/services", cookie)).text();
    assert.match(page, /<a href="\/admin\/services" aria-current="page">Services<\/a>/);
    assert.equal((page.match(/role="switch" name="live"/g) || []).length, 12);
    assert.equal((page.match(/role="switch" name="live" value="[^"]+" checked>/g) || []).length, 12);
    assert.match(page, /12 of 12 services are on your website\./);
    assert.equal((await site.get("/admin/services")).status, 303, "signed out: sent to the login page");
    assert.equal((await site.form("/admin/services", { live: "Pool" }, cookie)).status, 403, "needs the form token");
    assert.deepEqual(await (await site.get("/api/services")).json(), { off: [] });

    // Each row says how many approved companies the service has, tier by tier.
    assert.match(rowOf(page, "Lawn mowing"), /<span class="pill pill-none">No companies yet<\/span> <\/p>\s*<p class="service-warn">/);
    assert.match(rowOf(page, "Home repairs and upkeep"), /Your crew<\/span> No partner company needed\./);
    assert.ok(!rowOf(page, "Something else").includes("pill") && !rowOf(page, "Home repairs and upkeep").includes("service-warn"));
    await addVerifiedPartner(site, admin, "Switch Mowing Co", "Premium", "Lawn mowing");
    await site.form("/admin/partners", { csrf: admin.csrf, company: "Not Yet Mowing", contact_name: "A", trade: "Lawn mowing", tier: "Affordable", status: "applied" }, cookie);
    page = await (await site.get("/admin/services", cookie)).text();
    assert.match(rowOf(page, "Lawn mowing"), /<span class="pill pill-part">1 of 3 tiers<\/span> Affordable 0, Mid-range 0, Premium 1\. 1 company working toward approval<\/p>/);
    assert.ok(!rowOf(page, "Lawn mowing").includes("service-warn"));
    for (const tier of ["Affordable", "Mid-range"]) await addVerifiedPartner(site, admin, "Switch Mowing " + tier, tier, "Lawn mowing");
    assert.match(rowOf(await (await site.get("/admin/services", cookie)).text(), "Lawn mowing"), /<span class="pill pill-ready">All 3 tiers<\/span> Affordable 1, Mid-range 1, Premium 1\./);

    // Turn two off. The public answer lists them, in the catalog's order.
    const saved = await save(...SERVICE_NAMES.filter((name) => name !== "Lawn mowing" && name !== "Pool"));
    assert.deepEqual([saved.status, saved.headers.get("location")], [303, "/admin/services?saved=1"]);
    const answer = await site.get("/api/services");
    assert.deepEqual(await answer.json(), { off: ["Pool", "Lawn mowing"] });
    assert.equal(answer.headers.get("cache-control"), "no-cache", "a switch shows on the next page view");
    page = await (await site.get("/admin/services?saved=1", cookie)).text();
    assert.match(page, /<strong>Saved\.<\/strong> Your website now offers 10 services\. The change is live now\. <a class="plain-link" href="https:\/\/example\.test\/#services">See the home page<\/a>/);
    assert.match(page, /10 of 12 services are on your website\./);
    assert.ok(rowOf(page, "Pool").startsWith('value="Pool">') && rowOf(page, "Fence").startsWith('value="Fence" checked>'));

    // A service that is off takes no new request, even from a page that still lists it.
    for (const path of ["/api/brief", "/api/requests"]) {
      const refused = await site.json(path, mowing);
      assert.equal(refused.status, 400, path);
      assert.match((await refused.json()).error, /We aren’t taking requests for this service right now\./);
    }
    assert.equal((await pool.query("select count(*)::int as n from requests where service = 'Lawn mowing'")).rows[0].n, 0);
    assert.equal((await site.json("/api/requests", { ...mowing, service: "House cleaning" })).status, 201, "a service that is on still works");
    // Companies can still apply for it. That is how it gets enough of them to turn on.
    assert.equal((await site.json("/api/partners", {
      company: "Pool Hopeful LLC", trade: "Pool", tier: "Premium", years: "4", license: "CPC1450000", insured: "Yes, I can send proof",
      areas: "Lutz", website: "", name: "Pat Owner", phone: "813-555-0143", email: "pat@example.test"
    })).status, 201);

    // The public pages carry what the switch needs: a place for the note, and the script that reads the answer.
    assert.match(await (await site.get("/quote")).text(), /<p class="form-note" id="service-note" role="status" hidden>We aren&rsquo;t taking requests for that service right now\./);
    assert.match(await (await site.get("/quote.js")).text(), /\/api\/services/);
    assert.match(await (await site.get("/home.js")).text(), /\/api\/services/);

    // At least one stays on. Names it doesn't know are ignored. One name alone works.
    const none = await save();
    assert.equal(none.status, 400);
    assert.match(await none.text(), /<p class="form-error" role="alert">Keep at least one service on\./);
    assert.deepEqual((await (await site.get("/api/services")).json()).off, ["Pool", "Lawn mowing"], "a refused save changes nothing");
    assert.equal((await save("Not a service")).status, 400);
    assert.equal((await save("Fence", "Not a service")).status, 303);
    assert.deepEqual((await (await site.get("/api/services")).json()).off, SERVICE_NAMES.filter((name) => name !== "Fence"));
    assert.match(await (await site.get("/admin/services", cookie)).text(), /1 of 12 services is on your website\./);

    // Back on: requests are taken again.
    assert.equal((await save(...SERVICE_NAMES)).status, 303);
    assert.deepEqual(await (await site.get("/api/services")).json(), { off: [] });
    assert.equal((await site.json("/api/requests", mowing)).status, 201);
  } finally {
    // Later tests expect every service to be on.
    await pool.query("delete from settings where key = 'services_off'");
  }
});

test("the public approved list: a company is named only when the owner turns it on, with a record anyone can check", async () => {
  const site = await start({ SITE_ORIGINS: "https://www.example.test" });
  const admin = await login(site);
  const cookie = { cookie: admin.cookie };
  const { certificateNo } = require("../server/lib/standard");
  const record = require("../server/lib/record");
  assert.deepEqual(["AV-1003", "av-1003", " AV-1003 ", "AV-1000", "AV-99", "1003", "AV-1003x", ""].map(record.idFromCertificate), [3, 3, 3, null, null, null, null, null]);

  // The pages are there, with the words the site now stands on.
  const page = await (await site.get("/approved")).text();
  assert.match(page, /<h1 id="approved-title">Approved companies<\/h1>/);
  assert.match(page, /src="approved\.js\?v=[a-f0-9]{10}"/);
  assert.equal((await site.get("/approved.html")).status, 200);
  assert.match(await (await site.get("/about")).text(), /<h2>Our mission<\/h2>\s*<p class="read-lead">AT Legacy Services helps good small companies earn the trust a big company gets on name alone\./);
  assert.match(await (await site.get("/partners")).text(), /<p class="partner-mission">You do big-company work\. We give you the proof:/);
  const standard = await (await site.get("/standard")).text();
  assert.match(standard, /<h2>How a company comes off the list<\/h2>/);
  assert.match(standard, /A customer brings us a complaint about its work and the company doesn&rsquo;t put it right\./);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "site", "sitemap.xml"), "utf8").includes("<loc>https://atlegacyservices.com/approved</loc>"));
  for (const name of ["approved", "about", "partners", "standard"]) assert.ok(!/certified|guarantee[ds]?\b(?! of)/i.test(await (await site.get("/" + name)).text()), name + " doesn't call an approval certified or guaranteed");

  // Three companies in a trade no other test uses, so the names here are only these.
  const lit = await addVerifiedPartner(site, admin, "Bright <Yard> Lighting", "Premium", "Outdoor lighting");
  const dim = await addVerifiedPartner(site, admin, "Dim Yard Lighting", "Affordable", "Outdoor lighting");
  await pool.query("update partners set license_no = 'EC13001234' where id = $1", [lit.id]);
  const names = async () => (await (await site.get("/api/approved")).json()).companies.map((c) => c.company);
  assert.ok(!(await names()).includes("Bright <Yard> Lighting"), "approved, but not named until the owner turns it on");
  const no = certificateNo(lit.id);
  assert.equal((await site.get("/api/approved/" + no)).status, 404);

  // The owner's switch, on the company's page.
  let own = await (await site.get("/admin/partners/" + lit.id, cookie)).text();
  assert.match(own, /<h2>Public record page<\/h2>\s*<p class="form-note"><strong>Off\.<\/strong> Only a customer with a quote from Bright &lt;Yard&gt; Lighting sees its record\./);
  assert.equal((await site.form("/admin/partners/" + lit.id + "/listed", { listed: "1" }, cookie)).status, 403, "needs the form token");
  const on = await site.form("/admin/partners/" + lit.id + "/listed", { csrf: admin.csrf, listed: "1" }, cookie);
  assert.deepEqual([on.status, on.headers.get("location")], [303, "/admin/partners/" + lit.id + "#public"]);
  own = await (await site.get("/admin/partners/" + lit.id, cookie)).text();
  assert.match(own, /<strong>On\.<\/strong> Bright &lt;Yard&gt; Lighting is named on your website&rsquo;s approved list/);
  assert.ok(own.includes('data-copy-text="https://example.test/approved?id=' + no + '"') && own.includes(">Take it off the website</button>"));
  assert.match(await (await site.get("/admin/links", cookie)).text(), /Approved companies<\/p>[\s\S]*?example\.test<wbr>\/approved/);

  // The list names it, and counts every company whether named or not.
  const list = await (await site.get("/api/approved", { origin: "https://www.example.test" })).json();
  const entry = list.companies.find((c) => c.no === no);
  assert.deepEqual([entry.company, entry.service, entry.tier], ["Bright <Yard> Lighting", "Outdoor lighting", "Premium"]);
  assert.match(entry.since, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.ok(!list.companies.some((c) => c.company === "Dim Yard Lighting"));
  assert.deepEqual(Object.keys(list.numbers).sort(), ["approved", "notApproved", "removed", "working"]);
  const before = list.numbers;
  assert.ok(before.approved >= 2);
  assert.ok(!JSON.stringify(list).includes("813-555") && !JSON.stringify(list).includes("pat@example.test"), "no contact details");
  assert.equal((await fetch(site.base + "/api/approved", { headers: { origin: "https://www.example.test" } })).headers.get("access-control-allow-origin"), "https://www.example.test");

  // Its record: what the owner checked and saw, and nothing the company claimed.
  let rec = await (await site.get("/api/approved/" + no.toLowerCase())).json();
  assert.deepEqual([rec.no, rec.company, rec.service, rec.tier, rec.stateLicense, rec.ratings, rec.reviews], [no, "Bright <Yard> Lighting", "Outdoor lighting", "Premium", true, null, []]);
  assert.equal(rec.items[0], "Approved vendor " + no + ", since " + entry.since);
  assert.ok(rec.items.includes("License checked: DBPR electrical license for wired systems, number EC13001234") && rec.items.includes("Proof of liability insurance on file"));
  assert.ok(rec.shown.includes("In business 3 years or more"));
  assert.deepEqual(Object.keys(rec).sort(), ["company", "items", "no", "ratings", "reviews", "service", "shown", "since", "stateLicense", "tier"]);

  // Ratings: every one counts toward the average, which shows from the third on. Words show only when published.
  const rate = async (stars, comment, share, publish) => {
    const { row } = await createRequest(site, { service: "Outdoor lighting", tiers: ["Premium"], name: "Robin Customer" });
    await site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, partner: String(lit.id), tier: "Premium" }, cookie);
    const quote = (await pool.query("select * from quotes where request_id = $1", [row.id])).rows[0];
    await site.form("/q/" + quote.token, { action: "submit", amount: "4000", timeline: "1 week", includes: "Path lights." });
    await site.form("/r/" + row.token + "/choose", { quote: String(quote.id) });
    await site.form("/r/" + row.token + "/rating", { stars: String(stars), again: "yes", comment, ...(share ? { may_publish: "on" } : {}) });
    if (publish) await pool.query("update ratings set published = true where request_id = $1", [row.id]);
  };
  await rate(5, "Neat work.", true, true);
  await rate(2, "Late twice.", false, false);
  rec = await (await site.get("/api/approved/" + no)).json();
  assert.equal(rec.ratings, null, "two ratings: no average yet");
  assert.deepEqual(rec.reviews.map((r) => [r.stars, r.comment, r.name]), [[5, "Neat work.", "Robin"]]);
  await rate(4, "Private words <b>", true, false);
  rec = await (await site.get("/api/approved/" + no)).json();
  assert.deepEqual(rec.ratings, { count: 3, average: 3.7 }, "the 2-star rating counts, though its words aren't shown");
  assert.equal(rec.reviews.length, 1);
  assert.ok(!JSON.stringify(rec).includes("Late twice") && !JSON.stringify(rec).includes("Private words") && !JSON.stringify(rec).includes("Customer"));
  const asked = await (await site.get("/r/" + (await pool.query("select token from requests order by id desc limit 1")).rows[0].token)).text();
  assert.ok(!asked.includes("rating-form"), "already rated");

  // Paused: off the list that day, counted as taken off, and its number answers "not on the list".
  const form = { csrf: admin.csrf, company: "Bright <Yard> Lighting", contact_name: "Pat Partner", phone: "813-555-0199", email: "pat@example.test", trade: "Outdoor lighting", tier: "Premium",
    check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on", license_no: "EC13001234" };
  assert.equal((await site.form("/admin/partners/" + lit.id, { ...form, status: "paused" }, cookie)).status, 303);
  const gone = await site.get("/api/approved/" + no);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /No company with that number is on our public list today\./);
  const after = (await (await site.get("/api/approved")).json());
  assert.ok(!after.companies.some((c) => c.no === no));
  assert.deepEqual([after.numbers.approved, after.numbers.removed], [before.approved - 1, before.removed + 1]);
  assert.doesNotMatch(await (await site.get("/admin/partners/" + lit.id, cookie)).text(), /Public record page/, "nothing to switch while it is paused");
  // An applicant who is paused was never approved, so it counts as not approved.
  await site.form("/admin/partners", { csrf: admin.csrf, company: "Never Lighting", contact_name: "A", trade: "Outdoor lighting", tier: "Affordable", status: "applied" }, cookie);
  const never = (await pool.query("select id from partners where company = 'Never Lighting'")).rows[0].id;
  const working = (await (await site.get("/api/approved")).json()).numbers;
  assert.equal(working.working, after.numbers.working + 1);
  await site.form("/admin/partners/" + never, { csrf: admin.csrf, company: "Never Lighting", contact_name: "A", trade: "Outdoor lighting", tier: "Affordable", status: "paused" }, cookie);
  const final = (await (await site.get("/api/approved")).json()).numbers;
  assert.deepEqual([final.working, final.notApproved], [after.numbers.working, after.numbers.notApproved + 1]);
  // The owner's own crew is never on the list, and never counted.
  const crew = (await pool.query("select id from partners where trade = 'Home repairs and upkeep' limit 1")).rows[0];
  if (crew) {
    await site.form("/admin/partners/" + crew.id + "/listed", { csrf: admin.csrf, listed: "1" }, cookie);
    assert.equal((await pool.query("select listed from partners where id = $1", [crew.id])).rows[0].listed, false);
    assert.equal((await site.get("/api/approved/" + certificateNo(crew.id))).status, 404);
  }
  for (const bad of ["AV-999999", "nonsense", "AV-1000", "%27%20or%201=1"]) assert.equal((await site.get("/api/approved/" + bad)).status, 404, bad);
});

test("repairs go to our own crew with no fee", async () => {
  const site = await start();
  const admin = await login(site);
  const { row } = await createRequest(site, { service: "Home repairs and upkeep", tiers: ["Premium"] });
  assert.deepEqual(row.tiers, ["Our crew"]);
  const crew = (await pool.query("select id from partners where trade = 'Home repairs and upkeep'")).rows[0];
  await site.form("/admin/requests/" + row.id + "/invite", { csrf: admin.csrf, tier: "Our crew", partner: String(crew.id) }, { cookie: admin.cookie });
  const quote = (await pool.query("select * from quotes where request_id = $1", [row.id])).rows[0];
  assert.equal(Number(quote.fee_percent), 0);
  assert.doesNotMatch(await (await site.get("/q/" + quote.token)).text(), /finder/);
});

test("repeated submissions from one connection are limited", async () => {
  const site = await start();
  let last;
  for (let i = 0; i < 11; i += 1) last = await site.json("/api/requests", { ...JOB, ...CONTACT });
  assert.equal(last.status, 429);
  let attempt;
  for (let i = 0; i < 11; i += 1) attempt = await site.form("/admin/login", { password: "guess" + i });
  assert.equal(attempt.status, 429);
});
