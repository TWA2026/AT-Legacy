const { customerPath } = require("../lib/links");
const express = require("express");
const { InputError, text, oneOf } = require("../lib/validate");
const { SERVICE_NAMES, TIERS, OWN_CREW_SERVICE, OWN_CREW_TIER } = require("../lib/catalog");
const { buildBrief, plainBrief } = require("../lib/brief");
const { newToken, sign, safeEqual, rateLimiter } = require("../lib/security");
const { BODY_LIMIT, FileError, saveFile } = require("../lib/files");
const { loadStandard } = require("../lib/standard");

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

  // Pictures and files: enough for a customer adding to a few requests, not for filling the disk.
  const uploadLimit = rateLimiter({ limit: 60, windowMs: 3600 * 1000 });

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
      const url = customerPath({ id: saved.rows[0].id, token, name });
      // The customer's own copy of their link, when they gave an email address and email is set up.
      if (email && notify.send) {
        notify.send(email, "Your quote request with AT Legacy Services",
          "We have your " + job.service.toLowerCase() + " request. Your quotes will appear on your private page:\n\n" + config.publicUrl + url +
          "\n\nKeep this link. It is the only way back to your quotes.\n\nAT Legacy Services");
      }
      res.status(201).json({ url });
    } catch (error) {
      next(error);
    }
  });

  // A message from the contact page. It lands in the dashboard's Messages tab.
  // Ten tries an hour from one connection: room for a few typos, not for a flood.
  const messageLimit = rateLimiter({ limit: 10, windowMs: 3600 * 1000 });
  router.post("/messages", guard(messageLimit), async (req, res, next) => {
    try {
      const body = req.body || {};
      const clean = (value, max) => String(value == null ? "" : value).replace(/[ \t]+/g, " ").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
      // A hidden field that people leave empty and form-filling bots do not.
      if (clean(body.company_url, 200)) return res.status(201).json({ ok: true });
      const message = { name: clean(body.name, 100).replace(/\n/g, " "), reach: clean(body.reach, 200).replace(/\n/g, " "), text: clean(body.message, 2000) };
      if (!message.name) return res.status(400).json({ error: "Enter your name." });
      if (message.reach.replace(/\D/g, "").length < 10 && !/^\S+@\S+\.\S+$/.test(message.reach)) {
        return res.status(400).json({ error: "Enter a phone number or an email address, so we can answer you." });
      }
      if (message.text.length < 5) return res.status(400).json({ error: "Write your message." });
      await pool.query("insert into messages (name, reach, body) values ($1, $2, $3)", [message.name, message.reach, message.text]);
      notify("New message from " + message.name, message.name + " sent a message from the contact page. It is waiting in your dashboard.");
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Which tiers have an approved company for each service, so the request form can say so plainly.
  router.get("/coverage", async (req, res, next) => {
    try {
      const rows = (await pool.query("select distinct trade, tier from partners where status = 'verified'")).rows;
      const coverage = {};
      for (const name of SERVICE_NAMES) coverage[name] = name === OWN_CREW_SERVICE ? TIERS.slice() : TIERS.filter((tier) => rows.some((row) => row.trade === name && row.tier === tier));
      res.set("Cache-Control", "public, max-age=60").json(coverage);
    } catch (error) {
      next(error);
    }
  });

  // The standard every approved company is held to, as the public page shows it.
  // The wording is the owner's. Points and the numbers each tier needs stay private.
  router.get("/standard", async (req, res, next) => {
    try {
      const standard = await loadStandard(pool);
      res.set("Cache-Control", "public, max-age=60").json({
        must: standard.items.filter((item) => item.kind === "must").map((item) => item.label),
        more: standard.items.filter((item) => item.kind === "points").map((item) => item.label),
        months: standard.reviewMonths
      });
    } catch (error) {
      next(error);
    }
  });

  // Ratings the customer agreed to share and the owner chose to show.
  router.get("/reviews", async (req, res, next) => {
    try {
      const rows = (await pool.query(
        `select g.stars, g.comment, g.created_at, r.name, r.service, p.company
           from ratings g join requests r on r.id = g.request_id join quotes q on q.id = g.quote_id join partners p on p.id = q.partner_id
          where g.published and g.may_publish order by g.created_at desc limit 12`
      )).rows;
      res.set("Cache-Control", "public, max-age=60").json(rows.map((row) => ({
        stars: row.stars,
        comment: row.comment,
        // A first name only.
        name: String(row.name).trim().split(/\s+/)[0],
        service: row.service,
        company: row.company,
        when: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" }).format(row.created_at)
      })));
    } catch (error) {
      next(error);
    }
  });

  // A customer adds one picture or file to their request. The request's secret is the permission.
  // The body is the file itself: a JPEG the browser made from a picture, or a PDF.
  //   POST /api/requests/<secret>/files?kind=site|idea|document&name=<file name>
  const fileBody = express.raw({ type: ["image/jpeg", "application/pdf"], limit: BODY_LIMIT });
  router.post("/requests/:token/files", guard(uploadLimit), (req, res, next) => {
    fileBody(req, res, (error) => {
      if (error && error.type === "entity.too.large") return res.status(413).json({ error: "That file is too large to send." });
      next(error);
    });
  }, async (req, res, next) => {
    try {
      const request = (await pool.query("select id, status from requests where token = $1", [String(req.params.token)])).rows[0];
      if (!request) return res.status(404).json({ error: "We couldn’t find that request." });
      if (!Buffer.isBuffer(req.body)) throw new FileError(415, "We can take pictures and PDF files. This file is neither.");
      const file = await saveFile(pool, request, { kind: String(req.query.kind || ""), name: String(req.query.name || ""), data: req.body });
      if (file.sharing === "review") notify("A document is waiting for your check", "A customer added a document to a request. No company can see it until you decide. It is in your dashboard.");
      res.status(201).json({ id: file.id, kind: file.kind, name: file.name, size: file.size });
    } catch (error) {
      if (error instanceof FileError) return res.status(error.status).json({ error: error.message });
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
