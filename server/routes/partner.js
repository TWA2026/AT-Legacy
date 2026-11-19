const express = require("express");
const { esc, page, briefHtml } = require("../lib/html");
const { dollarsToCents, formatDollars } = require("../lib/validate");
const { OWN_CREW_TIER } = require("../lib/catalog");

async function loadQuote(pool, token) {
  const found = await pool.query(
    `select q.*, p.company,
            r.id as r_id, r.service, r.property, r.location, r.timing, r.size, r.brief, r.answers,
            r.status as request_status, r.chosen_quote_id, r.name as customer_name, r.phone as customer_phone,
            r.email as customer_email, r.contact_method
       from quotes q
       join partners p on p.id = q.partner_id
       join requests r on r.id = q.request_id
      where q.token = $1`,
    [token]
  );
  return found.rows[0] || null;
}

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
          <label for="warranty">Warranty <span class="optional">(optional)</span></label>
          <input id="warranty" name="warranty" type="text" maxlength="200" value="${value("warranty")}">
        </div>
      </div>
      <div class="done-actions">
        <button class="primary" type="submit" name="action" value="submit">${quote.status === "submitted" ? "Update my quote" : "Send my quote"}</button>
        <button class="secondary" type="submit" name="action" value="visit" formnovalidate>I need a site visit first</button>
        <button class="secondary" type="submit" name="action" value="decline" formnovalidate>Pass on this job</button>
      </div>
    </form>`;
}

function render(quote, error) {
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
      ${ownCrew ? "" : `<p class="form-note">If the customer hires you through this request, the finder&rsquo;s fee is ${esc(Number(quote.fee_percent))}% of the job total. You never pay for a quote that isn&rsquo;t chosen.</p>`}
    </section>`;
  }

  return page({
    title: "Quote request",
    heading: quote.service + " quote request",
    intro: "For " + quote.company + (ownCrew ? "." : ". You’re the " + quote.tier.toLowerCase() + " quote on this request."),
    wide: true,
    body: `${status}
    <section class="app-section">
      <h2>The job</h2>
      ${briefHtml({ service: quote.service, location: quote.location, property: quote.property, timing: quote.timing, size: quote.size, brief: quote.brief, answers: quote.answers })}
    </section>`
  });
}

module.exports = function partnerRoutes({ pool }) {
  const router = express.Router();

  router.get("/:token", async (req, res, next) => {
    try {
      const quote = await loadQuote(pool, req.params.token);
      if (!quote) return next();
      res.send(render(quote));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:token", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res, next) => {
    try {
      const quote = await loadQuote(pool, req.params.token);
      if (!quote) return next();
      if (quote.request_status === "chosen" || quote.request_status === "closed") {
        return res.redirect(303, "/q/" + quote.token);
      }

      const body = req.body || {};
      if (body.action === "visit" || body.action === "decline") {
        await pool.query("update quotes set status = $1 where id = $2", [body.action === "visit" ? "visit" : "declined", quote.id]);
        return res.redirect(303, "/q/" + quote.token);
      }

      const field = (name, max) => String(body[name] || "").trim().slice(0, max);
      const form = { amount: field("amount", 14), timeline: field("timeline", 120), includes: field("includes", 600), warranty: field("warranty", 200) };
      const cents = dollarsToCents(form.amount);
      let problem = "";
      if (!cents) problem = "Enter your price as a dollar amount, like 4950 or 4,950.00.";
      else if (!form.timeline) problem = "Say when you could start or finish.";
      else if (!form.includes) problem = "Describe what the price includes.";
      if (problem) {
        quote.form = form;
        return res.status(400).send(render(quote, problem));
      }

      await pool.query(
        `update quotes set status = 'submitted', amount_cents = $1, timeline = $2, includes = $3, warranty = $4, submitted_at = now()
          where id = $5`,
        [cents, form.timeline, form.includes, form.warranty, quote.id]
      );
      res.redirect(303, "/q/" + quote.token);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
