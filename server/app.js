const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { page } = require("./lib/html");
const { stampPage } = require("./lib/stamp");
const { createNotifier } = require("./lib/notify");

const SITE_DIR = path.join(__dirname, "..", "site");
// The files a dashboard page loads: styles, the copy-button script, the icon, and fonts.
const DASHBOARD_FILES = /^\/(?:styles\.css|app\.js|favicon\.svg|fonts\/[\w.-]+\.woff2)$/;

function readConfig(env) {
  const fee = Number(env.FEE_PERCENT);
  const dashboardUrl = (env.DASHBOARD_URL || "").replace(/\/+$/, "");
  return {
    adminPassword: env.ADMIN_PASSWORD || "",
    workosKey: env.WORKOS_API_KEY || "",
    workosClientId: env.WORKOS_CLIENT_ID || "",
    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    aiModel: env.AI_MODEL || "",
    feePercent: Number.isFinite(fee) && fee >= 0 && fee <= 50 && env.FEE_PERCENT !== undefined && env.FEE_PERCENT !== "" ? fee : 5,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
    // The dashboard can run as its own service. See server/lib/edge.js.
    dashboardOnly: env.DASHBOARD_ONLY === "1",
    dashboardUrl,
    // The host's sign-in wall guards the dashboard. Only honored on a dashboard-only service with an https address.
    hostSignin: env.DASHBOARD_ONLY === "1" && env.ADMIN_SIGNIN === "host" && dashboardUrl.startsWith("https://"),
    // Other addresses whose pages may call the request API, such as a static copy of the public pages.
    siteOrigins: new Set((env.SITE_ORIGINS || "").split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean)),
    resendKey: env.RESEND_API_KEY || "",
    notifyFrom: env.NOTIFY_FROM || "",
    notifyTo: env.NOTIFY_TO || ""
  };
}

function createApp({ pool, secret, config, fetchImpl = fetch }) {
  const app = express();
  const notify = createNotifier({ apiKey: config.resendKey, from: config.notifyFrom, to: config.notifyTo, fetchImpl });
  const shared = { pool, secret, config, fetchImpl, notify };

  app.disable("x-powered-by");
  // One proxy (the host's edge) sits in front of the app.
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    next();
  });

  // Log once which address visitors use, as this app sees it through the host's proxy.
  let addressLogged = false;
  app.use((req, res, next) => {
    if (!addressLogged && req.path !== "/healthz" && req.get("x-forwarded-for")) {
      addressLogged = true;
      console.log("Serving visitors at " + req.protocol + "://" + req.hostname);
    }
    next();
  });

  app.get("/healthz", async (req, res) => {
    try {
      await pool.query("select 1");
      res.type("text").send("ok");
    } catch (error) {
      res.status(503).type("text").send("database unavailable");
    }
  });

  // Private pages: never cached, never indexed.
  const privatePage = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    next();
  };

  if (config.dashboardOnly) {
    // The dashboard service: the owner's pages and the few files they load. Nothing public.
    app.get("/", (req, res) => res.redirect(302, "/admin"));
    app.use("/admin", privatePage, require("./routes/admin")(shared));
    const files = express.static(SITE_DIR, { index: false, maxAge: "10m" });
    app.use((req, res, next) => (DASHBOARD_FILES.test(req.path) ? files(req, res, next) : next()));
    app.use(privatePage, (req, res) => {
      res.status(404).send(page({
        title: "Page not found",
        heading: "Page not found",
        body: '    <p>This address only serves the dashboard. <a class="plain-link" href="/admin">Open the dashboard</a>.</p>'
      }));
    });
  } else {
    app.use("/api", (req, res, next) => {
      // The public pages may be served from another address (SITE_ORIGINS). Let those pages read the answers.
      // No cookies or logins are involved here, so this opens nothing else.
      const origin = req.get("origin");
      if (origin && config.siteOrigins.has(origin)) {
        res.set("Access-Control-Allow-Origin", origin);
        res.vary("Origin");
        if (req.method === "OPTIONS") {
          res.set({ "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" });
          return res.status(204).end();
        }
      }
      next();
    });
    app.use("/api", require("./routes/public")(shared));
    app.use("/r", privatePage, require("./routes/customer")(shared));
    app.use("/q", privatePage, require("./routes/partner")(shared));
    if (config.dashboardUrl) {
      // The dashboard runs as its own service. Send the owner there.
      app.use("/admin", privatePage, (req, res) => res.redirect(302, config.dashboardUrl + "/admin"));
    } else {
      app.use("/admin", privatePage, require("./routes/admin")(shared));
    }

    // The public pages. Each names its stylesheet and scripts by fingerprint and is checked again on
    // every visit, so a new page never loads with a stylesheet a browser saved from an older one.
    const PAGES = { "/": "index.html", "/index.html": "index.html", "/quote": "quote.html", "/quote.html": "quote.html", "/partners": "partners.html", "/partners.html": "partners.html" };
    const stampedPages = new Map();
    const sitePage = (file) => {
      if (!stampedPages.has(file)) stampedPages.set(file, stampPage(fs.readFileSync(path.join(SITE_DIR, file), "utf8"), SITE_DIR));
      return stampedPages.get(file);
    };
    app.get(Object.keys(PAGES), (req, res) => {
      res.set("Cache-Control", "no-cache").type("html").send(sitePage(PAGES[req.path]));
    });

    app.use(express.static(SITE_DIR, { extensions: ["html"], maxAge: "10m" }));

    app.use((req, res) => {
      res.status(404).set("Cache-Control", "no-cache").type("html").send(sitePage("404.html"));
    });
  }

  app.use((error, req, res, next) => {
    console.error(req.method, req.path, "failed:", error.message);
    if (res.headersSent) return next(error);
    res.status(500).send(page({
      title: "Something went wrong",
      heading: "Something went wrong",
      body: '    <p>That didn&rsquo;t work. Go back and try again, or email <a class="plain-link" href="mailto:hello@atlegacyservices.com">hello@atlegacyservices.com</a>.</p>'
    }));
  });

  return app;
}

module.exports = { createApp, readConfig };
