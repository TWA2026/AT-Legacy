const express = require("express");
const { esc, page, briefHtml, formatDate } = require("../lib/html");
const { formatDollars } = require("../lib/validate");
const { requestRef, customerPath, isOwnerPreview, recordOpen } = require("../lib/links");
const { LIMITS, listFiles, loadFile, sendFile, galleryHtml, pickerHtml } = require("../lib/files");
const record = require("../lib/record");

const OWNER_NOTE = '<p class="owner-preview"><strong>Owner preview.</strong> This is the customer&rsquo;s page, as they see it. Your visit isn&rsquo;t counted as them opening it.</p>';

async function loadRequest(pool, token) {
  const found = await pool.query("select * from requests where token = $1", [token]);
  if (!found.rows.length) return null;
  const request = found.rows[0];
  const quotes = await pool.query(
    `select q.*, p.company, p.phone as partner_phone, p.id as partner_id, p.trade as partner_trade, p.license_no,
            p.check_license, p.check_insurance, p.check_references, p.approved_on, p.visit
       from quotes q join partners p on p.id = q.partner_id
      where q.request_id = $1`,
    [request.id]
  );
  request.quotes = quotes.rows;
  request.rating = (await pool.query("select * from ratings where request_id = $1", [request.id])).rows[0] || null;
  return request;
}

// The lines of a quote, in the order every quote shows them, so three quotes read the same way.
// `always` lines show "Not stated" when a company left them empty. The rest only show when filled.
const QUOTE_LINES = [
  { label: "Included", get: (quote) => quote.includes, always: true },
  { label: "Not included", get: (quote) => quote.excludes },
  { label: "Timeline", get: (quote) => quote.timeline, always: true },
  { label: "Earliest start", get: (quote) => quote.start_by },
  { label: "Payment terms", get: (quote) => quote.payment_terms },
  { label: "Permit", get: (quote) => quote.permit },
  { label: "Warranty", get: (quote) => quote.warranty }
];

// What we have on file about the company behind a quote. Every line is something the owner checked
// or saw. Nothing here is the company's own claim.
// (The lines themselves are built in lib/record.js, which the public approved list shares.)
const companyOf = (quote) => ({
  id: quote.partner_id, trade: quote.partner_trade, approved_on: quote.approved_on, visit: quote.visit,
  check_license: quote.check_license, license_no: quote.license_no, check_insurance: quote.check_insurance, check_references: quote.check_references
});
const recordItems = (quote) => record.recordItems(companyOf(quote));
const shownAtVisit = (quote) => record.shownAtVisit(companyOf(quote));

function recordLists(quote) {
  const items = recordItems(quote);
  const shown = shownAtVisit(quote);
  return (items.length ? `<ul>
            ${items.map((item) => `<li>${esc(item)}</li>`).join("\n            ")}
          </ul>` : "") + (shown.length ? `
          <p class="record-shown">Shown at our visit</p>
          <ul>
            ${shown.map((item) => `<li>${esc(item)}</li>`).join("\n            ")}
          </ul>` : "");
}

function recordHtml(quote) {
  const lists = recordLists(quote);
  return lists ? `<div class="quote-record">
          <h4>Company record</h4>
          ${lists}
        </div>` : "";
}

// A license the customer can look up on the state's own site: the ones the DBPR issues.
function stateLicenseShown(quote) {
  return quote.status === "submitted" && record.stateLicense(companyOf(quote));
}

// Two or more quotes side by side, line by line. Shown on wide screens and on paper; a phone shows the cards.
function compareHtml(request) {
  const quotes = request.tiers.map((tier) => request.quotes.find((quote) => quote.tier === tier && quote.status === "submitted")).filter(Boolean);
  if (quotes.length < 2) return "";
  const lines = QUOTE_LINES.filter((line) => line.always || quotes.some((quote) => line.get(quote)));
  const row = (label, cell) => `<tr><th scope="row">${esc(label)}</th>${quotes.map((quote) => `<td>${cell(quote)}</td>`).join("")}</tr>`;
  return `    <section class="app-section compare-part">
      <h2>Side by side</h2>
      <div class="compare-scroll">
      <table class="compare">
        <thead>
          <tr><td></td>${quotes.map((quote) => `<th scope="col">${esc(quote.tier)}<span>${esc(quote.company)}</span></th>`).join("")}</tr>
        </thead>
        <tbody>
          ${row("Price", (quote) => `<strong>${esc(formatDollars(quote.amount_cents))}</strong>`)}
          ${lines.map((line) => row(line.label, (quote) => (line.get(quote) ? esc(line.get(quote)) : '<span class="compare-none">Not stated</span>'))).join("\n          ")}
          ${row("Company record", (quote) => `<div class="quote-record">${recordLists(quote)}</div>`)}
        </tbody>
      </table>
      </div>
    </section>`;
}

// After the customer has chosen a company: a place to say how the job went.
function ratingSection(request) {
  const quote = request.quotes.find((item) => item.id === request.chosen_quote_id);
  if (request.status !== "chosen" || !quote) return "";
  const rating = request.rating;
  if (rating) {
    return `    <section class="app-section" id="rating">
      <h2>Your rating</h2>
      <p class="form-note">You gave ${esc(quote.company)} ${rating.stars} out of 5 on ${esc(formatDate(rating.created_at))}. Thank you. It helps the next customer, and it counts when we visit this company again.</p>
      ${rating.comment ? `<p class="rating-said">${esc(rating.comment)}</p>` : ""}
    </section>`;
  }
  const star = (n) => `<label class="choice"><input type="radio" name="stars" value="${n}" required> <span>${n} ${n === 1 ? "star" : "stars"}${n === 5 ? ", excellent" : ""}${n === 1 ? ", poor" : ""}</span></label>`;
  return `    <section class="app-section" id="rating">
      <h2>When the job is done</h2>
      <p class="form-note">Come back to this page and tell us how ${esc(quote.company)} did. Your stars count toward the company&rsquo;s average, and when we visit them again. Your words are shown only if you tick the box at the end.</p>
      <form class="quote-form rating-form" method="post" action="/r/${esc(request.token)}/rating">
        <fieldset class="form-part tier-part">
          <legend>How was the work?</legend>
          <div class="choices">
            ${[5, 4, 3, 2, 1].map(star).join("\n            ")}
          </div>
        </fieldset>
        <fieldset class="form-part tier-part">
          <legend>Would you hire them again?</legend>
          <div class="choices">
            <label class="choice"><input type="radio" name="again" value="yes" required> <span>Yes</span></label>
            <label class="choice"><input type="radio" name="again" value="no"> <span>No</span></label>
          </div>
        </fieldset>
        <div class="fields">
          <div class="field wide">
            <label for="comment">Anything to add? <span class="optional">(optional)</span></label>
            <textarea id="comment" name="comment" rows="4" maxlength="800"></textarea>
          </div>
        </div>
        <label class="choice"><input type="checkbox" name="may_publish"> <span>You may show this on your website with my first name</span></label>
        <button class="primary" type="submit">Send my rating</button>
      </form>
    </section>`;
}

// The customer's pictures and files, with a way to add more while the request is open.
function filesSection(request, files) {
  const open = request.status !== "closed";
  const base = "/r/" + request.token + "/files";
  const note = (file) => {
    if (file.kind !== "document") return "";
    if (file.sharing === "shared") return '<p class="file-state">Shared with the companies quoting.</p>';
    return '<p class="file-state">Only we can see this for now.</p>';
  };
  const gallery = galleryHtml(files, {
    base,
    extra: (file) => note(file) + (open ? `
          <form method="post" action="${esc(base)}/${file.id}/remove"><button class="text-button" type="submit">Remove</button></form>` : "")
  });
  const room = LIMITS.filesPerRequest - files.length;
  return `    <section class="app-section" id="files">
      <h2>Pictures and files</h2>
      ${files.length
        ? '<p class="form-note">Companies quoting your job see your pictures. They don&rsquo;t see your name or contact details.</p>'
        : `<p class="form-note">${open ? "You haven&rsquo;t added any. Pictures help companies quote without a visit." : "None were added."}</p>`}
      ${gallery}
      ${open && room > 0 ? `<div class="file-add" data-upload-to="${esc(request.token)}" data-upload-room="${room}">
      <h3 class="file-add-title">${files.length ? "Add more" : "Add pictures or files"}</h3>
      <p class="form-note">We remove location data from every picture. You can add ${room === 1 ? "1 more file" : room + " more files"}.</p>
      ${pickerHtml()}
      </div>` : ""}
      ${open && room <= 0 ? `<p class="form-note">This request holds ${LIMITS.filesPerRequest} files, which is the most it can. Remove one to add another.</p>` : ""}
    </section>`;
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
          ${QUOTE_LINES.filter((line) => line.get(quote)).map((line) => `<dt>${esc(line.label)}</dt><dd>${esc(line.get(quote))}</dd>`).join("\n          ")}
        </dl>
        ${recordHtml(quote)}`;
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

module.exports = function customerRoutes({ pool, notify = async () => false }) {
  const router = express.Router();

  // The name after the secret is only a label for people. The page opens with or without it.
  router.get(["/:token", "/:token/:name"], async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.params.token);
      if (!request) return next();
      await recordOpen(pool, req, { requestId: request.id });
      const files = await listFiles(pool, request.id);
      const ready = request.quotes.filter((quote) => quote.status === "submitted").length;
      let intro = "We’re collecting your quotes. Save this page: it’s your private link, and quotes appear here as they arrive.";
      if (request.status === "chosen") intro = "You’ve chosen a company. You hire and pay them directly.";
      else if (request.status === "closed") intro = "This request is closed.";
      else if (ready) intro = ready === 1 ? "Your first quote is in. Others appear here as they arrive." : "Your quotes are in. Compare them and choose a company, or hire no one.";

      const ownerPreview = isOwnerPreview(req);
      const address = req.protocol + "://" + req.get("host") + customerPath(request);
      const open = request.status !== "chosen" && request.status !== "closed";
      // A way to hold on to the link, for a customer who has no account and no email from us.
      const keep = open && !ownerPreview ? `    <section class="app-section keep-link">
      <h2>Keep this page</h2>
      <p class="form-note">This link is the only way back to your quotes. Save it now.</p>
      <div class="done-actions">
        <button class="secondary" type="button" data-copy-text="${esc(address)}">Copy my link</button>
        <a class="secondary" href="sms:?&amp;body=${encodeURIComponent("My AT Legacy Services quotes: " + address)}">Text it to myself</a>
        <a class="secondary" href="mailto:?subject=${encodeURIComponent("My AT Legacy Services quotes")}&amp;body=${encodeURIComponent("My quotes appear on this private page:\n" + address)}">Email it to myself</a>
      </div>
    </section>
` : "";
      const showsLicense = request.quotes.some(stateLicenseShown);
      const compare = compareHtml(request);

      res.send(page({
        title: "Your request",
        heading: "Your " + request.service.toLowerCase() + " request",
        intro: "Reference " + requestRef(request.id) + ", for " + (String(request.name).trim().split(/\s+/)[0] || "you") + ". " + intro,
        wide: true,
        scripts: ["uploads.js"],
        body: `${ownerPreview ? "    " + OWNER_NOTE + "\n" : ""}${keep}    <section class="app-section quote-list${compare ? " has-compare" : ""}">
      <h2>Your quotes</h2>
      <ul class="quote-cards">
      ${request.tiers.map((tier) => tierCard(request, tier)).join("\n      ")}
      </ul>
    </section>
${compare}
    <section class="app-section quote-after">
      <p class="form-note">Each quote comes from the company named on it. AT Legacy Services doesn&rsquo;t set the price and isn&rsquo;t the contractor.${showsLicense ? ' You can look up a Florida contractor&rsquo;s license yourself at <a href="https://www.myfloridalicense.com" rel="noopener">myfloridalicense.com</a>.' : ""}</p>
      ${ready ? '<p class="print-action"><button class="secondary" type="button" data-print>Print or save as a PDF</button></p>' : ""}
    </section>
${ratingSection(request)}
    <section class="app-section">
      <h2>Your job brief</h2>
      <p class="form-note">This is what each company is pricing.</p>
      ${briefHtml(request)}
    </section>
${filesSection(request, files)}`
      }));
    } catch (error) {
      next(error);
    }
  });

  // One of the customer's own pictures or files.
  router.get("/:token/files/:file", async (req, res, next) => {
    try {
      const request = (await pool.query("select id from requests where token = $1", [req.params.token])).rows[0];
      const file = request && await loadFile(pool, request.id, req.params.file);
      if (!file) return next();
      sendFile(res, file);
    } catch (error) {
      next(error);
    }
  });

  // The customer takes a file back. Allowed until the request is closed.
  router.post("/:token/files/:file/remove", async (req, res, next) => {
    try {
      const request = (await pool.query("select id, token, name, status from requests where token = $1", [req.params.token])).rows[0];
      if (!request) return next();
      const id = Number(req.params.file);
      if (request.status !== "closed" && Number.isInteger(id)) {
        await pool.query("delete from request_files where id = $1 and request_id = $2", [id, request.id]);
      }
      res.redirect(303, customerPath(request) + "#files");
    } catch (error) {
      next(error);
    }
  });

  // The customer rates the company they chose. Once per request.
  router.post("/:token/rating", express.urlencoded({ extended: false, limit: "5kb" }), async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.params.token);
      if (!request) return next();
      const stars = Number(req.body.stars);
      const again = req.body.again;
      if (request.status === "chosen" && request.chosen_quote_id && !request.rating && Number.isInteger(stars) && stars >= 1 && stars <= 5 && (again === "yes" || again === "no")) {
        await pool.query(
          `insert into ratings (request_id, quote_id, stars, again, comment, may_publish) values ($1, $2, $3, $4, $5, $6)
           on conflict (request_id) do nothing`,
          [request.id, request.chosen_quote_id, stars, again === "yes", String(req.body.comment || "").trim().slice(0, 800), req.body.may_publish === "on"]
        );
        notify("A new customer rating: " + stars + " out of 5", requestRef(request.id) + ": the customer rated the company they hired. It is in your dashboard under Customer ratings.");
      }
      res.redirect(303, customerPath(request) + "#rating");
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
        notify("A customer chose " + quote.company, requestRef(request.id) + ": the customer chose " + quote.company + " (" + quote.tier + "). Their contact details are now on that company's page.");
      }
      res.redirect(303, customerPath(request));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
