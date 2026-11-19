const path = require("node:path");
const express = require("express");
const { page } = require("./lib/html");
const { createNotifier } = require("./lib/notify");

const SITE_DIR = path.join(__dirname, "..", "site");

function readConfig(env) {
  const fee = Number(env.FEE_PERCENT);
  return {
    adminPassword: env.ADMIN_PASSWORD || "",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    aiModel: env.AI_MODEL || "",
    feePercent: Number.isFinite(fee) && fee >= 0 && fee <= 50 && env.FEE_PERCENT !== undefined && env.FEE_PERCENT !== "" ? fee : 5,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
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

  app.get("/healthz", async (req, res) => {
    try {
      await pool.query("select 1");
      res.type("text").send("ok");
    } catch (error) {
      res.status(503).type("text").send("database unavailable");
    }
  });

  app.use("/api", require("./routes/public")(shared));

  // Private pages: never cached, never indexed.
  const privatePage = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    next();
  };
  app.use("/r", privatePage, require("./routes/customer")(shared));
  app.use("/q", privatePage, require("./routes/partner")(shared));
  app.use("/admin", privatePage, require("./routes/admin")(shared));

  app.use(express.static(SITE_DIR, { extensions: ["html"], maxAge: "10m" }));

  app.use((req, res) => {
    res.status(404).sendFile(path.join(SITE_DIR, "404.html"));
  });

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
