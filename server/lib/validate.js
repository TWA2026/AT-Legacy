// Reads and checks form input. Every field is trimmed and length-limited.

class InputError extends Error {}

function text(source, name, { max, required = true, label }) {
  const raw = source[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value && required) throw new InputError((label || name) + " is required.");
  if (value.length > max) throw new InputError((label || name) + " is too long.");
  return value;
}

function oneOf(source, name, allowed, label) {
  const value = text(source, name, { max: 80, label });
  if (!allowed.includes(value)) throw new InputError("Choose a valid " + (label || name).toLowerCase() + ".");
  return value;
}

// "$4,950.50" -> 495050. Returns null when the text isn't a dollar amount.
function dollarsToCents(raw) {
  const cleaned = String(raw || "").replace(/[$,\s]/g, "");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

function formatDollars(cents) {
  if (cents === null || cents === undefined) return "";
  const amount = Number(cents) / 100;
  return "$" + amount.toLocaleString("en-US", {
    minimumFractionDigits: amount % 1 ? 2 : 0,
    maximumFractionDigits: 2
  });
}

module.exports = { InputError, text, oneOf, dollarsToCents, formatDollars };
