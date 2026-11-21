// Which services the public site offers right now. The owner switches each one on or off in the
// dashboard's Services tab. What is stored is the list of services that are off, so a service is
// on until someone turns it off.

const { SERVICE_NAMES } = require("./catalog");

async function loadOff(pool) {
  const saved = (await pool.query("select value from settings where key = 'services_off'")).rows[0];
  if (!saved) return [];
  try {
    const names = JSON.parse(saved.value);
    return Array.isArray(names) ? SERVICE_NAMES.filter((name) => names.includes(name)) : [];
  } catch (error) {
    return [];
  }
}

// `live` is what the dashboard's form sent: the names that stay on. Anything else known is off.
// At least one service has to stay on, or the request form would have nothing to offer.
async function saveLive(pool, live) {
  const on = SERVICE_NAMES.filter((name) => [].concat(live || []).includes(name));
  if (!on.length) return { problem: "Keep at least one service on. With none, the request form has nothing to offer." };
  const off = SERVICE_NAMES.filter((name) => !on.includes(name));
  await pool.query(
    "insert into settings (key, value) values ('services_off', $1) on conflict (key) do update set value = excluded.value",
    [JSON.stringify(off)]
  );
  return { on, off };
}

module.exports = { loadOff, saveLive };
