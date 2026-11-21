// What we have on file about a company. Every line is something the owner checked or saw.
// Nothing here is the company's own claim. A quote shows it to the customer, and a company on the
// public list shows it to anyone.
//
// `company` is a row of partners, or the same fields picked out of a quote's row:
//   id, trade, approved_on, visit, check_license, license_no, check_insurance, check_references

const { OWN_CREW_SERVICE, licenseCheck } = require("./catalog");
const { certificateNo } = require("./standard");
const { formatDay } = require("./html");

function recordItems(company) {
  if (company.trade === OWN_CREW_SERVICE) return ["Done by AT Legacy Services’ own crew"];
  const items = [];
  const visit = company.visit && company.visit.on ? company.visit : null;
  if (company.approved_on) items.push("Approved vendor " + certificateNo(company.id) + ", since " + formatDay(company.approved_on));
  if (visit && visit.passed) items.push("Passed our site visit on " + formatDay(visit.on));
  const license = licenseCheck(company.trade);
  if (company.check_license && license) items.push("License checked: " + license + (company.license_no ? ", number " + company.license_no : ""));
  if (company.check_insurance) items.push("Proof of liability insurance on file");
  if (company.check_references) items.push("Local references checked");
  return items;
}

// The items past the basics that the company showed at its site visit. They are what set its tier.
function shownAtVisit(company) {
  const visit = company.visit && company.visit.on && company.visit.passed ? company.visit : null;
  if (!visit || company.trade === OWN_CREW_SERVICE) return [];
  return (visit.items || []).filter((item) => item.kind === "points" && item.met).map((item) => item.label);
}

// A license anyone can look up on the state's own site: the ones the DBPR issues.
function stateLicense(company) {
  return Boolean(company.check_license && company.license_no && /^DBPR\b/.test(licenseCheck(company.trade)));
}

// "AV-1003" back to the company's id. Null for anything that isn't a certificate number.
function idFromCertificate(text) {
  const match = /^AV-(\d{4,9})$/i.exec(String(text || "").trim());
  const id = match ? Number(match[1]) - 1000 : 0;
  return id > 0 ? id : null;
}

module.exports = { recordItems, shownAtVisit, stateLicense, idFromCertificate };
