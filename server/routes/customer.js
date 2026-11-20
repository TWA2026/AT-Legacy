const express = require("express");
const { esc, page, briefHtml } = require("../lib/html");
const { formatDollars } = require("../lib/validate");
const { requestRef, customerPath, isOwnerPreview, recordOpen } = require("../lib/links");

const OWNER_NOTE = '<p class="owner-preview"><strong>Owner preview.</strong> This is the customer&rsquo;s page, as they see it. Your visit isn&rsquo;t counted as them opening it.</p>';

async function loadRequest(pool, token) {
  const found = await pool.query("select * from requests where token = $1", [token]);
  if (!found.rows.length) return null;
  const request = found.rows[0];
  const quotes = await pool.query(
    `select q.*, p.company, p.phone as partner_phone
       from quotes q join partners p on p.id = q.partner_id
      where q.request_id = $1`,
    [request.id]
  );
  request.quotes = quotes.rows;
  return request;
}

function tierCard(request, tier) {
  const quote = request.quotes.find((item) => item.tier === tier);
  const chosen = quote && request.chosen_quote_id === quote.id;
  const decided = request.status === "chosen" || request.status === "closed";
  let inner;

  if (!quote || quote.status === "declined") {
    inner = `<p class="quote-wait">${decided ? "No quote was collected for this tier." : "We’re lining up a verified company for this tier."}</p>`;
  } else if (quote.status === "invited") {
    inner = `<p class="quote-wait">A verified company has your brief and is working on a price.</p>`;
  } else if (quote.status === "visit") {
    inner = `<p class="quote-wait">This company needs to see the site before pricing. We’ll contact you to set up a visit.</p>`;
  } else {
    inner = `<p class="quote-company">${esc(quote.company)}</p>
        <p class="quote-price">${esc(formatDollars(quote.amount_cents))}</p>
        <dl class="quote-facts">
          <dt>Included</dt><dd>${esc(quote.includes)}</dd>
          <dt>Timeline</dt><dd>${esc(quote.timeline)}</dd>
          ${quote.warranty ? `<dt>Warranty</dt><dd>${esc(quote.warranty)}</dd>` : ""}
        </dl>`;
    if (chosen) {
      inner += `<p class="quote-chosen">You chose this company. They&rsquo;ll contact you to schedule the work.${quote.partner_phone ? ` You can also call them at ${esc(quote.partner_phone)}.` : ""}</p>`;
    } else if (!decided) {
      inner += `<form method="post" action="/r/${esc(request.token)}/choose">
          <input type="hidden" name="quote" value="${quote.id}">
          <button class="primary" type="submit">Choose ${esc(quote.company)}</button>
        </form>`;
    }
  }

  return `<li class="quote-card${chosen ? " is-chosen" : ""}">
        <h3>${esc(tier)}</h3>
        ${inner}
      </li>`;
}

module.exports = function customerRoutes({ pool }) {
  const router = express.Router();

  // The name after the secret is only a label for people. The page opens with or without it.
  router.get(["/:token", "/:token/:name"], async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.params.token);
      if (!request) return next();
      await recordOpen(pool, req, { requestId: request.id });
      const ready = request.quotes.filter((quote) => quote.status === "submitted").length;
      let intro = "We’re collecting your quotes. Save this page: it’s your private link, and quotes appear here as they arrive.";
      if (request.status === "chosen") intro = "You’ve chosen a company. You hire and pay them directly.";
      else if (request.status === "closed") intro = "This request is closed.";
      else if (ready) intro = ready === 1 ? "Your first quote is in. Others appear here as they arrive." : "Your quotes are in. Compare them and choose a company, or hire no one.";

      res.send(page({
        title: "Your request",
        heading: "Your " + request.service.toLowerCase() + " request",
        intro: "Reference " + requestRef(request.id) + ", for " + (String(request.name).trim().split(/\s+/)[0] || "you") + ". " + intro,
        wide: true,
        body: `${isOwnerPreview(req) ? "    " + OWNER_NOTE + "\n" : ""}    <section class="app-section">
      <h2>Your quotes</h2>
      <ul class="quote-cards">
      ${request.tiers.map((tier) => tierCard(request, tier)).join("\n      ")}
      </ul>
      <p class="form-note">Each quote comes from the company named on it. AT Legacy Services doesn&rsquo;t set the price and isn&rsquo;t the contractor.</p>
    </section>
    <section class="app-section">
      <h2>Your job brief</h2>
      <p class="form-note">This is what each company is pricing.</p>
      ${briefHtml(request)}
    </section>`
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:token/choose", express.urlencoded({ extended: false, limit: "5kb" }), async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.params.token);
      if (!request) return next();
      const quote = request.quotes.find((item) => String(item.id) === String(req.body.quote));
      if (quote && quote.status === "submitted" && request.status !== "chosen" && request.status !== "closed") {
        await pool.query("update requests set status = 'chosen', chosen_quote_id = $1 where id = $2", [quote.id, request.id]);
      }
      res.redirect(303, customerPath(request));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
