// The business's own details, kept in one file: business.json at the top of the repository.
//
// Every public page reads from it, so a phone number or an About paragraph is typed once.
// A detail that is still empty takes its whole section off the page: nothing shows half filled.
//
//   phone       shown as "call or text" wherever people look for a number
//   owner       the name on the About page
//   ownerRole   what follows the name, such as Owner
//   about       paragraphs for the About page, in the owner's own words
//   hours       when someone answers, such as "Monday to Saturday, 8 to 6"
//   reply       how fast a new request gets an answer, such as "one business day". A promise: leave it empty until it is true
//   email       the public address
//   emailReady  true once mail to that address really arrives. Until then the address is not shown anywhere
//
// In a page, <!--if:phone--> ... <!--/if:phone--> keeps its contents only when the detail is filled,
// <!--if:!phone--> keeps them only when it is empty, and {{phone}} is replaced by the detail itself.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "..", "business.json");

function escape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// The details as pages use them. Phone links are built from the digits, so any way of typing the number works.
function details(raw) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const phone = text(raw.phone);
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const dial = digits.length === 10 ? "+1" + digits : "";
  const about = (Array.isArray(raw.about) ? raw.about : []).map(text).filter(Boolean);
  const email = raw.emailReady === true ? text(raw.email) : "";
  return {
    phone: dial ? phone : "",
    phoneHref: dial ? "tel:" + dial : "",
    smsHref: dial ? "sms:" + dial : "",
    owner: text(raw.owner),
    ownerRole: text(raw.ownerRole) || "Owner",
    about,
    hours: text(raw.hours),
    reply: text(raw.reply),
    email,
    // True when there is any direct way to reach the business besides the contact form.
    direct: Boolean(dial || email)
  };
}

function load(file = FILE) {
  return details(JSON.parse(fs.readFileSync(file, "utf8")));
}

// Fills one page. `business` is what details() returns.
function fill(html, business) {
  const filled = (key) => {
    const value = business[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  };
  // A section can sit inside another one, so keep going until none are left.
  const section = /<!--if:(!?)([a-zA-Z]+)-->([\s\S]*?)<!--\/if:\1\2-->\n?/g;
  let out = html;
  for (let pass = 0; pass < 5 && section.test(out); pass += 1) {
    section.lastIndex = 0;
    out = out.replace(section, (match, not, key, inner) => (filled(key) !== Boolean(not) ? inner : ""));
  }
  return out
    .replace(/\{\{aboutParagraphs\}\}/g, business.about.map((paragraph) => "<p>" + escape(paragraph) + "</p>").join("\n        "))
    .replace(/\{\{([a-zA-Z]+)\}\}/g, (match, key) => (typeof business[key] === "string" ? escape(business[key]) : match));
}

module.exports = { FILE, details, load, fill };
