const express = require("express");
const { esc, page, briefHtml, formatDate } = require("../lib/html");
const { dollarsToCents, formatDollars } = require("../lib/validate");
const { OWN_CREW_TIER } = require("../lib/catalog");
const { requestRef, companyPath, isOwnerPreview, recordOpen } = require("../lib/links");
const { listFiles, loadFile, sendFile, plainNames, galleryHtml } = require("../lib/files");
const { ruleText, termsOf } = require("../lib/fees");
const { invoiceRef, statusOf, working, invoiceForQuote } = require("../lib/invoices");

const OWNER_NOTE = '<p class="owner-preview"><strong>Owner preview.</strong> This is the company&rsquo;s page, as they see it. Your visit isn&rsquo;t counted as them opening it.</p>';

function pathFor(quote) {
  return companyPath({ token: quote.token, requestId: quote.r_id, tier: quote.tier, company: quote.company });
}

async function loadQuote(pool, token) {
  const found = await pool.query(
    `select q.*, p.company,
            r.id as r_id, r.service, r.property, r.location, r.timing, r.size, r.brief, r.answers,
            r.status as request_status, r.chosen_quote_id, r.chosen_at, r.name as customer_name, r.phone as customer_phone,
            r.email as customer_email, r.contact_method
       from quotes q
       join partners p on p.id = q.partner_id
       join requests r on r.id = q.request_id
      where q.token = $1`,
    [token]
  );
  return found.rows[0] || null;
}

// A company sees the customer's files while it can still quote, and after it is chosen.
// It never sees one the owner hasn't shared, and it gets plain names: a file's own name can say who the customer is.
function canSeeFiles(quote) {
  const decided = quote.request_status === "chosen" || quote.request_status === "closed";
  return !decided || quote.chosen_quote_id === quote.id;
}

async function sharedFiles(pool, quote) {
  if (!canSeeFiles(quote)) return [];
  const files = await listFiles(pool, quote.r_id);
  const names = plainNames(files);
  return files.filter((file) => file.sharing === "shared").map((file) => ({ ...file, shown: names.get(file.id) }));
}

// The answers a company can give about a permit. The customer sees them side by side.
const PERMITS = ["We pull the permit, and it is in the price", "We pull the permit, and its cost is extra", "No permit is needed", "Not sure yet"];

function quoteForm(quote, error) {
  const value = (name) => esc(quote.form ? quote.form[name] : quote[name] || "");
  const amount = quote.form ? quote.form.amount : (quote.amount_cents ? formatDollars(quote.amount_cents) : "");
  return `<form class="quote-form" method="post" action="/q/${esc(quote.token)}">
      ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
      <div class="fields">
        <div class="field">
          <label for="amount">Your price</label>
          <input id="amount" name="amount" type="text" inputmode="decimal" maxlength="14" value="${esc(amount)}" aria-describedby="amount-help" required>
          <span class="help" id="amount-help">The total the customer would pay, in dollars.</span>
        </div>
        <div class="field">
          <label for="timeline">When you could start or finish</label>
          <input id="timeline" name="timeline" type="text" maxlength="120" value="${value("timeline")}" required>
        </div>
        <div class="field wide">
          <label for="includes">What the price includes</label>
          <textarea id="includes" name="includes" rows="4" maxlength="600" required>${value("includes")}</textarea>
        </div>
        <div class="field wide">
          <label for="excludes">What it doesn&rsquo;t include <span class="optional">(optional)</span></label>
          <input id="excludes" name="excludes" type="text" maxlength="300" value="${value("excludes")}" aria-describedby="excludes-help">
          <span class="help" id="excludes-help">Anything the customer might expect that isn&rsquo;t in this price.</span>
        </div>
        <div class="field">
          <label for="start_by">Earliest start <span class="optional">(optional)</span></label>
          <input id="start_by" name="start_by" type="text" maxlength="120" value="${value("start_by")}">
        </div>
        <div class="field">
          <label for="permit">Permit <span class="optional">(optional)</span></label>
          <select id="permit" name="permit">
            <option value="">Choose one</option>
            ${PERMITS.map((choice) => `<option${(quote.form ? quote.form.permit : quote.permit) === choice ? " selected" : ""}>${esc(choice)}</option>`).join("")}
          </select>
        </div>
        <div class="field wide">
          <label for="payment_terms">Payment terms <span class="optional">(optional)</span></label>
          <input id="payment_terms" name="payment_terms" type="text" maxlength="200" value="${value("payment_terms")}" aria-describedby="terms-help">
          <span class="help" id="terms-help">For example: 30% to start, the rest when the job is done.</span>
        </div>
        <div class="field wide">
          <label for="warranty">Warranty <span class="optional">(optional)</span></label>
          <input id="warranty" name="warranty" type="text" maxlength="200" value="${value("warranty")}">
        </div>
      </div>
      <p class="form-note">The customer sees your quote beside the others, line by line, so the more of this you fill in the better it compares.</p>
      <div class="done-actions">
        <button class="primary" type="submit" name="action" value="submit">${quote.status === "submitted" ? "Update my quote" : "Send my quote"}</button>
        <button class="secondary" type="submit" name="action" value="visit" formnovalidate>I need a site visit first</button>
        <button class="secondary" type="submit" name="action" value="decline" formnovalidate>Pass on this job</button>
      </div>
    </form>`;
}

// What the company owes on a job it won, on the page it already uses, with the way to its invoice.
function feeDue(invoice) {
  if (!invoice) return "";
  const status = statusOf(invoice);
  const page = "/q/invoice/" + invoice.token;
  if (status.key === "void") return '<p class="form-note">There is no finder&rsquo;s fee on this job.</p>';
  if (status.key === "refunded") return '<p class="form-note">Your finder&rsquo;s fee was refunded. Nothing is owed on this job.</p>';
  if (status.key === "paid") {
    return `<p class="form-note">Your finder&rsquo;s fee of ${esc(formatDollars(invoice.amount_cents))} is paid. Thank you. <a class="plain-link" href="${esc(page)}">See your receipt</a></p>`;
  }
  return `<div class="fee-due">
        <h3>Your finder&rsquo;s fee is ${esc(formatDollars(invoice.amount_cents))}</h3>
        <p>${esc(working(invoice))}. Invoice ${esc(invoiceRef(invoice))} is ${status.overdue ? "overdue. It was due " : "due by "}${esc(formatDate(invoice.due_at))}. If the job falls through before any work starts, <a class="plain-link" href="/contact">tell us</a> and you owe nothing.</p>
        <p class="fee-pay"><a class="primary" href="${esc(page)}">${status.pending ? "See your invoice" : "See and pay your invoice"}</a></p>
      </div>`;
}

function render(quote, error, ownerPreview, files = [], invoice = null) {
  const won = quote.chosen_quote_id === quote.id;
  const decided = quote.request_status === "chosen" || quote.request_status === "closed";
  const ownCrew = quote.tier === OWN_CREW_TIER;
  let status;

  if (won) {
    status = `<section class="app-section">
      <h2>You were chosen</h2>
      <p>Contact the customer to schedule the work. They hire and pay you directly.</p>
      <dl class="brief">
        <dt>Customer</dt><dd>${esc(quote.customer_name)}</dd>
        <dt>Phone</dt><dd>${esc(quote.customer_phone)}</dd>
        ${quote.customer_email ? `<dt>Email</dt><dd>${esc(quote.customer_email)}</dd>` : ""}
        <dt>Prefers</dt><dd>${esc(quote.contact_method)}</dd>
        <dt>Your quote</dt><dd>${esc(formatDollars(quote.amount_cents))}</dd>
      </dl>
      ${ownCrew ? "" : feeDue(invoice)}
    </section>`;
  } else if (decided) {
    status = `<section class="app-section"><h2>This request is closed</h2><p>${quote.request_status === "chosen" ? "The customer chose another company." : "The customer is no longer collecting quotes."} Thanks for your time.</p></section>`;
  } else {
    let note = "";
    if (quote.status === "submitted") note = `<p class="quote-chosen">Your quote of ${esc(formatDollars(quote.amount_cents))} is with the customer. You can update it until they choose.</p>`;
    if (quote.status === "visit") note = `<p class="quote-chosen">You asked for a site visit. We&rsquo;ll contact you to set it up. Come back to this page to enter your price.</p>`;
    if (quote.status === "declined") note = `<p class="quote-chosen">You passed on this job. If that changes, you can still send a price below.</p>`;
    status = `<section class="app-section">
      <h2>Your quote</h2>
      ${note}
      ${quoteForm(quote, error)}
      ${ownCrew ? "" : `<p class="form-note">If the customer hires you through this request, the finder&rsquo;s fee is ${esc(ruleText(termsOf(quote)))}. You never pay for a quote that isn&rsquo;t chosen.</p>`}
    </section>`;
  }

  return page({
    title: "Quote request",
    heading: quote.service + " quote request",
    intro: "Request " + requestRef(quote.r_id) + ", for " + quote.company + (ownCrew ? "." : ". You’re the " + quote.tier.toLowerCase() + " quote on this request."),
    wide: true,
    body: `${ownerPreview ? "    " + OWNER_NOTE + "\n" : ""}${status}
    <section class="app-section">
      <h2>The job</h2>
      ${briefHtml({ service: quote.service, location: quote.location, property: quote.property, timing: quote.timing, size: quote.size, brief: quote.brief, answers: quote.answers })}
    </section>${files.length ? `
    <section class="app-section" id="files">
      <h2>Pictures from the customer</h2>
      <p class="form-note">Tap a picture to see it full size.</p>
      ${galleryHtml(files, { base: "/q/" + quote.token + "/files", label: (file) => file.shown, theirs: true })}
    </section>` : ""}`
  });
}

module.exports = function partnerRoutes({ pool, config, notify = async () => false }) {
  const router = express.Router();

  // The name after the secret is only a label for people. The page opens with or without it.
  router.get(["/:token", "/:token/:name"], async (req, res, next) => {
    try {
      const quote = await loadQuote(pool, req.params.token);
      if (!quote) return next();
      await recordOpen(pool, req, { requestId: quote.r_id, quoteId: quote.id });
      // A job this company won carries an invoice for its fee.
      const invoice = quote.chosen_quote_id === quote.id && Number(quote.fee_percent) > 0 ? await invoiceForQuote(pool, config, quote.id) : null;
      res.send(render(quote, "", isOwnerPreview(req), await sharedFiles(pool, quote), invoice));
    } catch (error) {
      next(error);
    }
  });

  // One shared picture or file from the request this company is quoting.
  router.get("/:token/files/:file", async (req, res, next) => {
    try {
      const quote = await loadQuote(pool, req.params.token);
      if (!quote) return next();
      const allowed = (await sharedFiles(pool, quote)).find((file) => String(file.id) === String(req.params.file));
      const file = allowed && await loadFile(pool, quote.r_id, allowed.id);
      if (!file || file.sharing !== "shared") return next();
      sendFile(res, file, allowed.shown + (file.mime === "application/pdf" ? ".pdf" : ".jpg"));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:token", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res, next) => {
    try {
      const quote = await loadQuote(pool, req.params.token);
      if (!quote) return next();
      if (quote.request_status === "chosen" || quote.request_status === "closed") {
        return res.redirect(303, pathFor(quote));
      }

      const body = req.body || {};
      if (body.action === "visit" || body.action === "decline") {
        await pool.query("update quotes set status = $1 where id = $2", [body.action === "visit" ? "visit" : "declined", quote.id]);
        notify(quote.company + (body.action === "visit" ? " needs a site visit" : " passed on a job"), requestRef(quote.r_id) + ", " + quote.tier + ": " + quote.company + (body.action === "visit" ? " asked to see the site before pricing." : " passed on this job."));
        return res.redirect(303, pathFor(quote));
      }

      const field = (name, max) => String(body[name] || "").trim().slice(0, max);
      const form = {
        amount: field("amount", 14), timeline: field("timeline", 120), includes: field("includes", 600), warranty: field("warranty", 200),
        excludes: field("excludes", 300), start_by: field("start_by", 120), payment_terms: field("payment_terms", 200),
        permit: PERMITS.includes(body.permit) ? body.permit : ""
      };
      const cents = dollarsToCents(form.amount);
      let problem = "";
      if (!cents) problem = "Enter your price as a dollar amount, like 4950 or 4,950.00.";
      else if (!form.timeline) problem = "Say when you could start or finish.";
      else if (!form.includes) problem = "Describe what the price includes.";
      if (problem) {
        quote.form = form;
        return res.status(400).send(render(quote, problem, false, await sharedFiles(pool, quote)));
      }

      await pool.query(
        `update quotes set status = 'submitted', amount_cents = $1, timeline = $2, includes = $3, warranty = $4,
                excludes = $5, start_by = $6, payment_terms = $7, permit = $8, submitted_at = now()
          where id = $9`,
        [cents, form.timeline, form.includes, form.warranty, form.excludes, form.start_by, form.payment_terms, form.permit, quote.id]
      );
      notify("A quote is in from " + quote.company, requestRef(quote.r_id) + ", " + quote.tier + ": " + quote.company + " sent a price. It is on the customer's page now.");
      res.redirect(303, pathFor(quote));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
