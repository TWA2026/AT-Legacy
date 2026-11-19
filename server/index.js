const { createPool, loadSecret } = require("./db");
const { createApp, readConfig } = require("./app");

(async () => {
  const pool = createPool(process.env.DATABASE_URL);
  const secret = await loadSecret(pool);
  const config = readConfig(process.env);
  const app = createApp({ pool, secret, config });
  const port = Number(process.env.PORT) || 3000;

  const server = app.listen(port, "0.0.0.0", () => {
    console.log("Listening on port " + port);
    if (config.workosKey && config.workosClientId) {
      console.log("Dashboard sign-in: WorkOS." + (config.adminEmails.length ? "" : " ADMIN_EMAILS is empty, so nobody can sign in yet."));
    } else if (config.adminPassword) {
      console.log("Dashboard sign-in: password.");
    } else {
      console.log("Dashboard sign-in is not set up. The dashboard is locked until ADMIN_PASSWORD or the WorkOS keys are added.");
    }
    console.log(config.anthropicKey ? "AI review is on." : "AI review is off (no ANTHROPIC_API_KEY). Briefs are built from the customer's answers.");
  });

  // Let in-flight requests finish when the host replaces this process.
  process.on("SIGTERM", () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10000).unref();
  });
})().catch((error) => {
  console.error("Could not start:", error.message);
  process.exit(1);
});
