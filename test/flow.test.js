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
  const row = (await pool.query("select * from requests where token = $1", [url.slice(3)])).rows[0];
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
  await pool.query("drop table if exists quotes, requests, partners, settings cascade");
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
  for (const path of ["/styles.css", "/app.js", "/favicon.svg", "/fonts/public-sans-latin-400-normal.woff2", "/healthz"]) {
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
  await site.form(other.url + "/choose", { quote: String(affordable.id) });
  assert.equal((await pool.query("select status from requests where id = $1", [other.row.id])).rows[0].status, "new");

  const chosen = await site.form(url + "/choose", { quote: String(affordable.id) });
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
  await site.form(url + "/choose", { quote: String(top.id) });
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
