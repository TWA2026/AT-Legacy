const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

function createPool(url) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new Pool({ connectionString: url, max: 5 });
}

// Creates the tables, the signing secret, and the in-house partner record.
async function migrate(pool) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  await pool.query(
    "insert into settings (key, value) values ('secret', $1) on conflict (key) do nothing",
    [crypto.randomBytes(32).toString("hex")]
  );
  await pool.query(
    `insert into partners (company, contact_name, email, trade, tier, status, notes)
     select 'AT Legacy Services', 'AT Legacy Services', 'hello@atlegacyservices.com',
            'Home repairs and upkeep', 'Our crew', 'verified', 'Our own crew.'
     where not exists (select 1 from partners where trade = 'Home repairs and upkeep')`
  );
}

async function loadSecret(pool) {
  const result = await pool.query("select value from settings where key = 'secret'");
  if (!result.rows.length) throw new Error("Run the migration before starting the server");
  return result.rows[0].value;
}

module.exports = { createPool, migrate, loadSecret };
