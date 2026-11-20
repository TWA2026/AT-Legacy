const { customerPath } = require("../lib/links");
const express = require("express");
const { InputError, text, oneOf } = require("../lib/validate");
const { SERVICE_NAMES, TIERS, OWN_CREW_SERVICE, OWN_CREW_TIER } = require("../lib/catalog");
const { buildBrief, plainBrief } = require("../lib/brief");
const { newToken, sign, safeEqual, rateLimiter } = require("../lib/security");

const PROPERTIES = ["My home", "My rental property", "Other"];
const TIMINGS = ["As soon as possible", "Within a month", "In 1 to 3 months", "I’m flexible"];
const CONTACT_METHODS = ["Call", "Text", "Email"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readJob(body) {
  const service = oneOf(body, "service", SERVICE_NAMES, "Service");
  const job = {
    service,
    property: oneOf(body, "property", PROPERTIES, "Property type"),
    location: text(body, "location", { max: 60, label: "Neighborhood or ZIP code" }),
    timing: oneOf(body, "timing", TIMINGS, "Timing"),
    size: text(body, "size", { max: 80, required: false, label: "Size" }),
    details: text(body, "details", { max: 1000, label: "Job description" })
  };
  if (service === OWN_CREW_SERVICE) {
    job.tiers = [OWN_CREW_TIER];
  } else {
    const chosen = Array.isArray(body.tiers) ? body.tiers : [];
    job.tiers = TIERS.filter((tier) => chosen.includes(tier));
    if (!job.tiers.length) throw new InputError("Choose at least one tier.");
  }
  return job;
}

function briefSignature(secret, brief) {
  return sign(secret, "brief:" + JSON.stringify([brief.summary, brief.scope, brief.questions, brief.ai]));
}

module.exports = function publicRoutes({ pool, secret, config, fetchImpl, notify }) {
  const router = express.Router();
  const briefLimit = rateLimiter({ limit: 20, windowMs: 3600 * 1000 });
  const requestLimit = rateLimiter({ limit: 10, windowMs: 3600 * 1000 });
  const partnerLimit = rateLimiter({ limit: 5, windowMs: 3600 * 1000 });
  // Across all visitors. Past this many AI briefs in a day, briefs are built without AI.
  const aiDailyBudget = rateLimiter({ limit: 300, windowMs: 24 * 3600 * 1000 });

  router.use(express.json({ limit: "20kb" }));

  function guard(limit) {
    return (req, res, next) => {
      if (limit(req.ip)) return next();
      res.status(429).json({ error: "Too many requests from this connection. Try again in an hour." });
    };
  }

  // Step 2 of the request form: turn the answers into a brief the customer can check.
  router.post("/brief", guard(briefLimit), async (req, res, next) => {
    try {
      const job = readJob(req.body || {});
      const useAi = Boolean(config.anthropicKey) && aiDailyBudget("all");
      const brief = await buildBrief(job, { apiKey: useAi ? config.anthropicKey : "", model: config.aiModel, fetchImpl });
      res.json({ brief, signature: briefSignature(secret, brief) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/requests", guard(requestLimit), async (req, res, next) => {
    try {
      const body = req.body || {};
      // Bots fill every field, including this hidden one. Pretend it worked.
      if (body.company_url) return res.json({ url: "/" });

      const job = readJob(body);
      const name = text(body, "name", { max: 80, label: "Name" });
      const phone = text(body, "phone", { max: 30, label: "Phone" });
      const contact = oneOf(body, "contact", CONTACT_METHODS, "Contact method");
      const email = text(body, "email", { max: 100, required: contact === "Email", label: "Email" });
      if (email && !EMAIL_PATTERN.test(email)) throw new InputError("Enter a valid email address.");

      // Keep the brief the customer reviewed only if this server produced it.
      let brief = plainBrief(job);
      const sent = body.brief;
      if (sent && typeof body.signature === "string" && Array.isArray(sent.scope) && Array.isArray(sent.questions) &&
          safeEqual(body.signature, briefSignature(secret, sent))) {
        brief = { summary: sent.summary, scope: sent.scope, questions: sent.questions, ai: sent.ai };
      }

      const answers = [];
      const given = Array.isArray(body.answers) ? body.answers : [];
      brief.questions.forEach((question, index) => {
        const answer = typeof given[index] === "string" ? given[index].trim().slice(0, 300) : "";
        if (answer) answers.push({ q: question, a: answer });
      });

      const token = newToken();
      const saved = await pool.query(
        `insert into requests (token, service, property, location, timing, size, details, tiers, answers, brief, name, phone, email, contact_method)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [token, job.service, job.property, job.location, job.timing, job.size, job.details, job.tiers,
          JSON.stringify(answers), JSON.stringify({ summary: brief.summary, scope: brief.scope, ai: brief.ai }),
          name, phone, email, contact]
      );
      notify("New quote request: " + job.service, "A new request for " + job.service + " in " + job.location + " is waiting in your dashboard." + (config.publicUrl ? "\n\n" + config.publicUrl + "/admin" : ""));
      res.status(201).json({ url: customerPath({ id: saved.rows[0].id, token, name }) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/partners", guard(partnerLimit), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.company_url) return res.json({ ok: true });

      const partner = {
        company: text(body, "company", { max: 100, label: "Company name" }),
        trade: oneOf(body, "trade", SERVICE_NAMES.filter((name) => name !== OWN_CREW_SERVICE), "Main service"),
        tier: oneOf(body, "tier", TIERS, "Pricing tier"),
        years: text(body, "years", { max: 3, label: "Years in business" }),
        license: text(body, "license", { max: 40, required: false, label: "License number" }),
        insured: oneOf(body, "insured", ["Yes, I can send proof", "Not yet"], "Insurance answer"),
        areas: text(body, "areas", { max: 120, label: "Areas you serve" }),
        website: text(body, "website", { max: 120, required: false, label: "Website" }),
        name: text(body, "name", { max: 80, label: "Name" }),
        phone: text(body, "phone", { max: 30, label: "Phone" }),
        email: text(body, "email", { max: 100, label: "Email" })
      };
      if (!EMAIL_PATTERN.test(partner.email)) throw new InputError("Enter a valid email address.");

      await pool.query(
        `insert into partners (company, contact_name, phone, email, trade, tier, years, license_no, insured, areas, website)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [partner.company, partner.name, partner.phone, partner.email, partner.trade, partner.tier, partner.years,
          partner.license, partner.insured, partner.areas, partner.website]
      );
      notify("New partner application: " + partner.company, partner.company + " applied for " + partner.trade + " (" + partner.tier + ")." + (config.publicUrl ? "\n\n" + config.publicUrl + "/admin/partners" : ""));
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (error instanceof InputError) return res.status(400).json({ error: error.message });
    if (error.type === "entity.too.large" || error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "The request couldn’t be read." });
    }
    next(error);
  });

  return router;
};
