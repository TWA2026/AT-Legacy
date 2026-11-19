const { createPool, migrate } = require("./db");

const ATTEMPTS = 20;
const WAIT_MS = 3000;
// Errors that mean "the database isn't accepting connections yet", worth waiting out.
const NOT_READY = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "57P03"];

(async () => {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await migrate(pool);
        break;
      } catch (error) {
        if (!NOT_READY.includes(error.code) || attempt === ATTEMPTS) throw error;
        console.log("Database isn't ready yet. Trying again in " + WAIT_MS / 1000 + " seconds.");
        await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      }
    }
    console.log("Database is up to date.");
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
