// End-to-end tests against a real Postgres database.
// Set TEST_DATABASE_URL to a database these tests are allowed to wipe.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPool, migrate, loadSecret } = require("../server/db");
const { createApp, readConfig } = require("../server/app");
const { parseAiBrief } = require("../server/lib/brief");
const { dollarsToCents, formatDollars } = require("../server/lib/validate");
const { spawnSync } = require("node:child_process");
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

async function addVerifiedPartner(site, admin, company, tier, trade = "Fence") {
  const response = await site.form("/admin/partners", {
    csrf: admin.csrf, company, contact_name: "Pat Partner", phone: "813-555-0199", email: "pat@example.test",
    trade, tier, status: "verified",
    check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on"
  }, { cookie: admin.cookie });
  assert.equal(response.status, 303);
  return (await pool.query("select * from partners where company = $1", [company])).rows[0];
}

test.before(async () => {
  pool = createPool(DATABASE_URL);
  await pool.query("drop table if exists link_events, quotes, requests, partners, settings cascade");
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
  assert.match(await home.text(), /One request\. Three quotes/);
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
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
  // config.js loads before the script that reads it.
  for (const page of ["quote", "partners"]) {
    const html = fs.readFileSync(path.join(dist, page + ".html"), "utf8");
    assert.ok(html.indexOf('src="config.js"') > 0 && html.indexOf('src="config.js"') < html.indexOf('src="' + page + '.js"'), page);
  }
  fs.rmSync(dist, { recursive: true, force: true });
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
  const verified = await site.form("/admin/partners/" + applied.id, {
    ...fields, check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on"
  }, { cookie: admin.cookie });
  assert.equal(verified.status, 303);
  assert.equal((await pool.query("select status from partners where id = $1", [applied.id])).rows[0].status, "verified");
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
  assert.match(home, /<a href="\/admin\/partners">1 partner application to review<\/a>/);
  let partnersPage = await see("/admin/partners");
  assert.match(partnersPage, /class="owner-row needs-you"/);
  assert.match(partnersPage, /Review their application/);
  assert.match(partnersPage, /<a href="tel:8135550199">813-555-0199&quot;&gt;&lt;script&gt;<\/a>/);
  assert.doesNotMatch(partnersPage, /<script>|<i>Fence/);
  const verify = await site.form("/admin/partners/" + partner.id, {
    csrf: admin.csrf, company: partner.company, contact_name: partner.contact_name, phone: partner.phone, email: partner.email,
    trade: "Fence", tier: "Affordable", status: "verified",
    check_registration: "on", check_license: "on", check_insurance: "on", check_references: "on"
  }, { cookie: admin.cookie });
  assert.equal(verify.status, 303);

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
