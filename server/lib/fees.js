// The finder's fee: one rule for every size of job.
//
//   fee = a percentage of the price the company quoted,
//         never less than the minimum, never more than the maximum
//
// The owner sets the numbers in the dashboard (Fees, then Fee settings). Each quote keeps the terms
// that were in force when its brief was sent, so changing the rule never changes what a company
// already agreed to. The fee is owed only on a job the customer chose, and the owner can waive it.

const { formatDollars } = require("./validate");

const DEFAULT_FEE = { percent: 5, minCents: 2500, maxCents: 75000, dueDays: 14, payLink: "" };

function defaultFee(config) {
  const percent = config && Number.isFinite(config.feePercent) ? config.feePercent : DEFAULT_FEE.percent;
  return { ...DEFAULT_FEE, percent };
}

// A payment page the owner pastes in: https only, a real host, no sign-in details inside it.
function cleanPayLink(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.length > 300) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch (error) {
    return null;
  }
}

// Reads the dashboard's form. Amounts arrive in dollars. Returns { fee } or { problem }.
function checkFee(form) {
  const number = (value) => (/^\d{1,5}(\.\d{1,2})?$/.test(String(value === undefined ? "" : value).trim()) ? Number(value) : NaN);
  const percent = number(form.percent);
  const min = number(form.min === "" || form.min === undefined ? "0" : form.min);
  const max = number(form.max === "" || form.max === undefined ? "0" : form.max);
  const days = number(form.days);
  if (!(percent > 0 && percent <= 20)) return { problem: "Enter the percentage as a number from 0.5 to 20." };
  if (!(min >= 0 && min <= 500)) return { problem: "The smallest fee can be from $0 to $500." };
  if (!(max >= 0 && max <= 10000)) return { problem: "The largest fee can be up to $10,000. Leave it empty for no limit." };
  if (max > 0 && max < min) return { problem: "The largest fee can’t be less than the smallest." };
  if (!(Number.isInteger(days) && days >= 0 && days <= 90)) return { problem: "Enter the days to pay as a whole number from 0 to 90." };
  const payLink = cleanPayLink(form.pay_link);
  if (payLink === null) return { problem: "The payment link has to be a full address that starts with https://" };
  return { fee: { percent, minCents: Math.round(min * 100), maxCents: Math.round(max * 100), dueDays: days, payLink } };
}

async function loadFee(pool, config) {
  const base = defaultFee(config);
  const saved = (await pool.query("select value from settings where key = 'fee'")).rows[0];
  if (!saved) return base;
  try {
    const value = JSON.parse(saved.value);
    const checked = checkFee({ percent: value.percent, min: value.minCents / 100, max: value.maxCents / 100, days: value.dueDays, pay_link: value.payLink });
    return checked.fee || base;
  } catch (error) {
    return base;
  }
}

async function saveFee(pool, fee) {
  await pool.query(
    "insert into settings (key, value) values ('fee', $1) on conflict (key) do update set value = excluded.value",
    [JSON.stringify(fee)]
  );
}

// The terms a quote carries, as stored on its row.
const termsOf = (quote) => ({ percent: Number(quote.fee_percent), minCents: Number(quote.fee_min_cents) || 0, maxCents: Number(quote.fee_max_cents) || 0 });

// What a won job owes, in cents, from the price the company quoted.
function feeCents(quote) {
  const { percent, minCents, maxCents } = termsOf(quote);
  if (!(percent > 0)) return 0;
  let fee = Math.round((Number(quote.amount_cents) || 0) * percent / 100);
  if (minCents > 0) fee = Math.max(fee, minCents);
  if (maxCents > 0) fee = Math.min(fee, maxCents);
  return fee;
}

// The same sum inside a query, for totals. `q` is the quotes table's alias.
const FEE_SQL = "least(greatest(round(q.amount_cents * q.fee_percent / 100.0), nullif(q.fee_min_cents, 0)), nullif(q.fee_max_cents, 0))";

const percentText = (percent) => String(Number(percent)) + "%";

// "5% of the price you quote, at least $25 and at most $750"
function ruleText(terms, basis = "the price you quote") {
  const limits = [];
  if (terms.minCents > 0) limits.push("at least " + formatDollars(terms.minCents));
  if (terms.maxCents > 0) limits.push("at most " + formatDollars(terms.maxCents));
  return percentText(terms.percent) + " of " + basis + (limits.length ? ", " + limits.join(" and ") : "");
}

// "Never less than $25 or more than $750 a job."
function limitsText(terms) {
  if (terms.minCents > 0 && terms.maxCents > 0) return "Never less than " + formatDollars(terms.minCents) + " or more than " + formatDollars(terms.maxCents) + " a job.";
  if (terms.minCents > 0) return "Never less than " + formatDollars(terms.minCents) + " a job.";
  if (terms.maxCents > 0) return "Never more than " + formatDollars(terms.maxCents) + " a job.";
  return "";
}

// How one job's fee came out: "5% of $70,000 is $3,500, held to the $750 maximum"
function workingText(quote) {
  const terms = termsOf(quote);
  const straight = Math.round((Number(quote.amount_cents) || 0) * terms.percent / 100);
  const fee = feeCents(quote);
  let text = percentText(terms.percent) + " of " + formatDollars(quote.amount_cents) + " is " + formatDollars(straight);
  if (fee > straight) text += ", raised to the " + formatDollars(fee) + " minimum";
  if (fee < straight) text += ", held to the " + formatDollars(fee) + " maximum";
  return text;
}

// The owner's payment page, tagged with the job's reference where the page can take one (Stripe's can),
// so a payment can be matched to its job. The reference is a job number, never anything personal.
function payUrl(link, reference) {
  if (!link) return "";
  try {
    const url = new URL(link);
    if (/(^|\.)stripe\.com$/.test(url.hostname) && !url.searchParams.has("client_reference_id")) {
      url.searchParams.set("client_reference_id", String(reference).replace(/[^A-Za-z0-9_-]/g, ""));
    }
    return url.toString();
  } catch (error) {
    return "";
  }
}

// The day a fee is due: so many days after the customer chose. "Dec 5, 2026"
function dueDay(chosenAt, dueDays) {
  if (!chosenAt) return "";
  const due = new Date(new Date(chosenAt).getTime() + Number(dueDays) * 86400000);
  return due.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

// The rule as the public pages state it.
function shownFee(fee) {
  return { percent: percentText(fee.percent), rule: ruleText(fee), limits: limitsText(fee), days: fee.dueDays };
}

// The For companies page and the Terms carry the rule in their own HTML. Each page's script then
// swaps in the current rule, in case the owner has changed it since the page was built.
function fillFeePage(html, shown) {
  const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html
    .replace(/<!--fee:percent-->/g, () => escape(shown.percent))
    .replace(/<!--fee:rule-->/g, () => escape(shown.rule))
    .replace(/<!--fee:limits-->/g, () => escape(shown.limits))
    .replace(/<!--fee:days-->/g, () => escape(shown.days));
}

module.exports = {
  DEFAULT_FEE, FEE_SQL, defaultFee, checkFee, loadFee, saveFee, termsOf, feeCents, ruleText, limitsText, workingText,
  payUrl, dueDay, shownFee, fillFeePage, percentText
};
