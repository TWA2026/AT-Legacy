// The owner's certification standard.
//
// At a site visit the owner scores a company against this list. "Must meet" items decide whether
// the company can be approved at all. "Points" items add up to suggest its tier. The owner edits
// the list in the dashboard, and it is stored in the settings table.

const crypto = require("node:crypto");
const { TIERS } = require("./catalog");

const MAX_ITEMS = 40;
const MAX_LABEL = 140;
const MAX_POINTS = 5;

// A starting point. The owner is expected to change it.
const DEFAULT_STANDARD = {
  items: [
    { label: "The job site is safe and kept clean", kind: "must", points: 0 },
    { label: "The work matches what was quoted", kind: "must", points: 0 },
    { label: "Customers get a written estimate or contract", kind: "must", points: 0 },
    { label: "Permits are pulled when a job needs one", kind: "must", points: 0 },
    { label: "The owner or a lead is on site or easy to reach", kind: "must", points: 0 },
    { label: "In business 3 years or more", kind: "points", points: 1 },
    { label: "In business 10 years or more", kind: "points", points: 1 },
    { label: "Written warranty on every job", kind: "points", points: 1 },
    { label: "Warranty of 2 years or longer", kind: "points", points: 1 },
    { label: "Can start a priority job within 2 weeks", kind: "points", points: 1 },
    { label: "Answers calls and messages within one business day", kind: "points", points: 1 },
    { label: "Marked vehicles or uniforms", kind: "points", points: 1 },
    { label: "Three or more recent local references check out", kind: "points", points: 1 }
  ],
  mid: 3,
  premium: 6,
  reviewMonths: 12
};

function possiblePoints(standard) {
  return standard.items.reduce((sum, item) => sum + (item.kind === "points" ? item.points : 0), 0);
}

function wholeNumber(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

// Returns a tidy copy of a standard, or a sentence saying what is wrong with it.
function checkStandard(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const items = [];
  for (const item of Array.isArray(source.items) ? source.items : []) {
    const label = String((item && item.label) || "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    if (!label) continue;
    const must = !item || item.kind !== "points";
    const points = must ? 0 : Math.min(MAX_POINTS, Math.max(1, wholeNumber(item.points, 1)));
    items.push({ label, kind: must ? "must" : "points", points });
  }
  if (!items.length) return { problem: "Keep at least one item in the standard." };
  if (items.length > MAX_ITEMS) return { problem: "Keep the standard to " + MAX_ITEMS + " items or fewer." };
  if (new Set(items.map((item) => item.label.toLowerCase())).size !== items.length) return { problem: "Two items say the same thing. Change or remove one." };

  const standard = {
    items,
    mid: wholeNumber(source.mid, -1),
    premium: wholeNumber(source.premium, -1),
    reviewMonths: wholeNumber(source.reviewMonths, -1)
  };
  const possible = possiblePoints(standard);
  if (standard.mid < 0 || standard.premium < 0) return { problem: "Enter whole numbers for the points each tier needs." };
  if (standard.mid > standard.premium) return { problem: "Premium should need at least as many points as mid-range." };
  if (standard.premium > possible) return { problem: "Premium needs " + standard.premium + " points, but the items only add up to " + possible + "." };
  if (standard.reviewMonths < 1 || standard.reviewMonths > 60) return { problem: "Set the next visit between 1 and 60 months after approval." };
  return { standard };
}

async function loadStandard(pool) {
  const saved = (await pool.query("select value from settings where key = 'standard'")).rows[0];
  if (saved) {
    try {
      const checked = checkStandard(JSON.parse(saved.value));
      if (checked.standard) return checked.standard;
    } catch (error) {
      // Fall through to the starting standard.
    }
  }
  return checkStandard(DEFAULT_STANDARD).standard;
}

async function saveStandard(pool, standard) {
  await pool.query(
    "insert into settings (key, value) values ('standard', $1) on conflict (key) do update set value = excluded.value",
    [JSON.stringify(standard)]
  );
}

// The dashboard's form sends one row per item: label_0, kind_0, label_1, kind_1, and so on.
// kind is "must", or the number of points the item is worth. A row with no label is dropped.
function standardFromForm(body) {
  const items = [];
  for (let index = 0; index < MAX_ITEMS + 10; index += 1) {
    if (body["label_" + index] === undefined) break;
    const kind = String(body["kind_" + index] || "must");
    items.push({ label: body["label_" + index], kind: kind === "must" ? "must" : "points", points: kind === "must" ? 0 : Number(kind) });
  }
  return checkStandard({ items, mid: body.mid, premium: body.premium, reviewMonths: body.review_months });
}

function tierFor(points, standard) {
  if (points >= standard.premium) return TIERS[2];
  if (points >= standard.mid) return TIERS[1];
  return TIERS[0];
}

// The form field for one item's checkbox. It is made from the item's wording, not its place in the
// list, so a scorecard that was opened before the standard changed can never tick the wrong item.
function itemKey(label) {
  return "met_" + crypto.createHash("sha256").update(String(label).toLowerCase()).digest("hex").slice(0, 12);
}

// The positions of the items a submitted scorecard ticked.
function metFromForm(standard, body) {
  return new Set(standard.items.map((item, index) => (body[itemKey(item.label)] ? index : -1)).filter((index) => index >= 0));
}

// Scores one visit. `met` holds the positions of the items the owner ticked.
// The result keeps each item's wording, so an old visit still reads correctly after the standard changes.
function scoreVisit(standard, met) {
  const items = standard.items.map((item, index) => ({ ...item, met: met.has(index) }));
  const must = items.filter((item) => item.kind === "must");
  const points = items.reduce((sum, item) => sum + (item.kind === "points" && item.met ? item.points : 0), 0);
  const passed = must.every((item) => item.met);
  return {
    items,
    mustMet: must.filter((item) => item.met).length,
    mustTotal: must.length,
    points,
    possible: possiblePoints(standard),
    passed,
    tier: passed ? tierFor(points, standard) : ""
  };
}

function certificateNo(partnerId) {
  return "AV-" + (1000 + Number(partnerId));
}

function isDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

// Today's date where the business is, as 2026-11-20.
function today(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// The same day of the month, that many months later. Jan 31 plus one month is the last day of February.
function addMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

module.exports = {
  DEFAULT_STANDARD, MAX_ITEMS, MAX_LABEL, MAX_POINTS,
  checkStandard, loadStandard, saveStandard, standardFromForm, possiblePoints, tierFor, itemKey, metFromForm, scoreVisit,
  certificateNo, isDay, today, addMonths
};
