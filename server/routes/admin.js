const express = require("express");
const { esc, page, ownerPage, briefHtml, formatDate } = require("../lib/html");
const { dollarsToCents, formatDollars } = require("../lib/validate");
const { SERVICE_NAMES, TIERS, OWN_CREW_SERVICE, OWN_CREW_TIER, licenseCheck } = require("../lib/catalog");
const {
  newToken, safeEqual, createSession, readSession, csrfToken, sessionCookie, rateLimiter,
  createLoginState, checkLoginState, stateCookie
} = require("../lib/security");
const { authorizationUrl, exchangeCode } = require("../lib/workos");
const { createEdgeGuard, MARKER_HEADER, MARKER } = require("../lib/edge");

const STATUS_LABELS = {
  new: "New", collecting: "Collecting quotes", chosen: "Company chosen", closed: "Closed",
  applied: "Applied", verified: "Verified", paused: "Paused",
  invited: "Waiting for quote", visit: "Site visit needed", submitted: "Quote in", declined: "Passed"
};

function pill(status) {
  return `<span class="pill pill-${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

function plural(count, one, many) {
  return count + " " + (count === 1 ? one : many);
}

// Phone and email links. Each is built only from digits or an encoded address,
// so nothing a person typed into a form can change what the link does.
function dial(phone) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? cleaned : "";
}

function textLink(phone, message) {
  const to = dial(phone);
  return to ? "sms:" + to + "?&body=" + encodeURIComponent(message) : "";
}

function emailLink(email, subject, message) {
  const match = /^([^\s@<>"]+)@([^\s@<>"]+\.[^\s@<>"]+)$/.exec(String(email || "").trim());
  if (!match) return "";
  return "mailto:" + encodeURIComponent(match[1]) + "@" + encodeURIComponent(match[2]) +
    "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(message);
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

// What the owner should do next on a request. `quotes` are that request's quotes, each with its company name.
function nextStep(r, quotes) {
  if (r.status === "closed") return { needsYou: false, short: "Closed", long: "This request is closed." };
  if (r.status === "chosen") {
    const chosen = quotes.find((q) => q.id === r.chosen_quote_id);
    const company = chosen ? chosen.company : "A company";
    const hasFee = chosen && Number(chosen.fee_percent) > 0;
    let rest = "There is no fee on this one. Close the request when the job is done.";
    if (hasFee) rest = chosen.fee_paid ? "The fee is marked paid. Close the request when you’re done with it." : "When the job is done, enter the final total under Fees.";
    return { needsYou: false, short: company + " was chosen", long: "The customer chose " + company + ". " + rest };
  }
  const unfilled = r.tiers.length - quotes.length;
  if (unfilled > 0) {
    if (r.tiers.includes(OWN_CREW_TIER)) {
      return { needsYou: true, short: "Yours to quote", long: "This one is for your own crew. Assign AT Legacy Services below, then open the quote link and enter your price." };
    }
    return {
      needsYou: true,
      short: quotes.length ? plural(unfilled, "tier still needs", "tiers still need") + " a company" : "Choose companies",
      long: "Choose a company for each tier below. Then send each company its link."
    };
  }
  const waiting = quotes.filter((q) => q.status === "invited" || q.status === "visit").length;
  if (waiting) {
    return {
      needsYou: false,
      short: "Waiting on " + plural(waiting, "quote", "quotes"),
      long: plural(waiting, "company still owes", "companies still owe") + " a quote. Nothing to do unless one goes quiet. If so, send them their link again."
    };
  }
  if (!quotes.some((q) => q.status === "submitted")) {
    return { needsYou: true, short: "Every company passed", long: "Every company passed on this job. Remove them and choose others, or close the request." };
  }
  return { needsYou: false, short: "Customer is choosing", long: "The quotes are in. The customer picks one on their private page. If they haven’t looked, send them the link." };
}

function options(values, selected) {
  return values.map((value) => `<option${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("");
}

module.exports = function adminRoutes({ pool, secret, config, fetchImpl }) {
  const router = express.Router();
  const loginLimit = rateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

  router.use(express.urlencoded({ extended: false, limit: "20kb" }));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // With the host's sign-in wall in front, there is no login or logout here. See server/lib/edge.js.
  const hostSignin = Boolean(config.hostSignin);
  const wallIsUp = hostSignin ? createEdgeGuard({ url: config.dashboardUrl, fetchImpl }) : null;
  const dashboardHost = hostSignin ? new URL(config.dashboardUrl).hostname : "";
  const WALL_DOWN = "The dashboard is locked. It opens only at its own address, and only while the host\u2019s sign-in wall is on for this service (in Slipway: the service\u2019s Auth setting, Members).";

  const TABS = [["/admin", "Requests", "requests"], ["/admin/partners", "Partners", "partners"], ["/admin/fees", "Fees", "fees"], ["/admin/links", "Links", "links"]];

  function adminPage(req, view) {
    return ownerPage({ tabs: TABS, signOut: !hostSignin, ...view, body: view.body.replace(/__CSRF__/g, esc(csrfToken(secret, req.session))) });
  }

  // A link the owner sends to someone: the address with a Copy button, then ways to send or open it.
  // `readable` shows the whole address as text. Use it for the short, fixed pages; private links are too long to read.
  function linkRow({ id, label, link, note = "", textTo = "", emailTo = "", message = "", subject = "AT Legacy Services", who = "", open = "", share = true, readable = false }) {
    const actions = [];
    const sms = textLink(textTo, message + " " + link);
    const mail = emailLink(emailTo, subject, message + "\n\n" + link);
    if (sms) actions.push(`<li><a href="${esc(sms)}">Text it to ${esc(who || textTo)}</a></li>`);
    if (mail) actions.push(`<li><a href="${esc(mail)}">Email it to ${esc(who || emailTo)}</a></li>`);
    if (share) actions.push(`<li hidden><button class="text-button" type="button" data-share-url="${esc(link)}" data-share-text="${esc(message)}">Share it another way</button></li>`);
    if (open) actions.push(`<li><a href="${esc(link)}" target="_blank" rel="noopener">${esc(open)}</a></li>`);
    const field = readable
      ? `<p class="link-name" id="${id}-name">${label}</p>
        <div class="copy-row copy-readable"><span class="link-address" id="${id}">${esc(link.replace(/^https?:\/\//, "").replace(/\/$/, "")).replace(/\//g, "<wbr>/")}</span><button class="secondary" type="button" data-copy-text="${esc(link)}" aria-describedby="${id}-name">Copy</button></div>`
      : `<label for="${id}">${label}</label>
        <div class="copy-row"><input id="${id}" type="text" readonly value="${esc(link)}"><button class="secondary" type="button" data-copy="${id}">Copy</button></div>`;
    return `<div class="link-row">
        ${field}
        ${note ? `<p class="link-note">${note}</p>` : ""}
        ${actions.length ? `<ul class="link-actions">${actions.join("")}</ul>` : ""}
      </div>`;
  }

  const csrfField = '<input type="hidden" name="csrf" value="__CSRF__">';

  // Links the owner copies and sends. Uses PUBLIC_URL when set, otherwise the address this request used.
  function siteUrl(req) {
    return config.publicUrl || (req.protocol + "://" + req.get("host"));
  }

  // Cookies are HTTPS-only whenever the site is. PUBLIC_URL settles it when the host's proxy doesn't say.
  const httpsSite = config.publicUrl.startsWith("https://") || hostSignin;
  function secureCookies(req) {
    return httpsSite || req.secure;
  }

  // With WorkOS keys set, sign-in goes through WorkOS and the password is switched off.
  const useWorkos = Boolean(config.workosKey && config.workosClientId);
  const NOT_SET_UP = "Sign-in hasn\u2019t been set up yet. Add ADMIN_PASSWORD, or the WorkOS keys, in the hosting settings.";
  const LOGIN_ERRORS = {
    cancelled: "Sign-in was cancelled or didn\u2019t finish. Try again.",
    expired: "That sign-in attempt expired. Try again.",
    failed: "We couldn\u2019t confirm that sign-in. Try again.",
    unverified: "Verify your email address with the sign-in provider, then try again.",
    "not-allowed": "That account isn\u2019t allowed to open this dashboard."
  };

  function loginPage(message) {
    const error = message ? `<p class="form-error" role="alert">${esc(message)}</p>` : "";
    if (useWorkos) {
      return page({
        title: "Sign in",
        heading: "Dashboard",
        body: `    <div class="quote-form">
      ${error}
      <p>Sign in with the account you use to manage AT Legacy Services.</p>
      <a class="primary" href="/admin/login/start">Sign in</a>
    </div>`
      });
    }
    return page({
      title: "Log in",
      heading: "Dashboard",
      body: `    <form class="quote-form" method="post" action="/admin/login">
      ${error}
      <div class="fields">
        <div class="field wide">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
      </div>
      <button class="primary" type="submit">Log in</button>
    </form>`
    });
  }

  if (hostSignin) {
    // What the wall check looks for. A stranger must never be able to reach this.
    router.get("/edge-check", (req, res) => {
      res.set(MARKER_HEADER, MARKER).type("text").send(MARKER);
    });
    router.all(["/login", "/login/start", "/callback", "/logout"], (req, res) => res.redirect(303, "/admin"));
  }

  router.get("/login", (req, res) => {
    if (!useWorkos && !config.adminPassword) return res.status(503).send(loginPage(NOT_SET_UP));
    res.send(loginPage(LOGIN_ERRORS[req.query.error]));
  });

  router.post("/login", (req, res) => {
    if (useWorkos) return res.redirect(303, "/admin/login");
    if (!config.adminPassword) return res.status(503).send(loginPage(NOT_SET_UP));
    if (!loginLimit(req.ip)) return res.status(429).send(loginPage("Too many attempts. Wait 15 minutes and try again."));
    if (!safeEqual(req.body.password || "", config.adminPassword)) {
      return res.status(401).send(loginPage("That password isn\u2019t right."));
    }
    res.set("Set-Cookie", sessionCookie(createSession(secret), secureCookies(req)));
    res.redirect(303, "/admin");
  });

  // WorkOS sign-in, step 1: send the browser to the hosted login page.
  router.get("/login/start", (req, res, next) => {
    if (!useWorkos) return next();
    if (!loginLimit(req.ip)) return res.status(429).send(loginPage("Too many attempts. Wait 15 minutes and try again."));
    const login = createLoginState(secret);
    res.set("Set-Cookie", stateCookie(login.cookie, secureCookies(req)));
    res.redirect(302, authorizationUrl({
      clientId: config.workosClientId,
      redirectUri: siteUrl(req) + "/admin/callback",
      state: login.state
    }));
  });

  // Step 2: WorkOS sends the browser back here with a one-time code.
  router.get("/callback", async (req, res, next) => {
    try {
      if (!useWorkos) return next();
      const fail = (reason, status) => {
        res.set("Set-Cookie", stateCookie("", secureCookies(req)));
        return status ? res.status(status).send(loginPage(LOGIN_ERRORS[reason])) : res.redirect(303, "/admin/login?error=" + reason);
      };
      if (req.query.error || typeof req.query.code !== "string") return fail("cancelled");
      if (!checkLoginState(secret, req.headers.cookie, req.query.state)) return fail("expired");

      const user = await exchangeCode({
        apiKey: config.workosKey,
        clientId: config.workosClientId,
        code: req.query.code,
        ip: req.ip,
        userAgent: req.get("user-agent") || "",
        fetchImpl
      });
      if (!user) return fail("failed");
      if (!user.emailVerified) return fail("unverified", 403);
      if (!config.adminEmails.includes(user.email)) return fail("not-allowed", 403);

      res.append("Set-Cookie", stateCookie("", secureCookies(req)));
      res.append("Set-Cookie", sessionCookie(createSession(secret), secureCookies(req)));
      res.redirect(303, "/admin");
    } catch (error) {
      next(error);
    }
  });

  router.get("/logout", (req, res) => {
    res.set("Set-Cookie", sessionCookie("", secureCookies(req)));
    res.redirect(303, "/admin/login");
  });

  // Everything below needs a session, and every change needs the form token.
  router.use(async (req, res, next) => {
    try {
      req.session = readSession(secret, req.headers.cookie);
      if (hostSignin) {
        // The wall has already signed this visitor in. Confirm the wall is there, then start a session.
        const up = req.hostname === dashboardHost && await wallIsUp({ fresh: !req.session });
        if (!up) return res.status(503).send(page({ title: "Locked", heading: "Dashboard", body: `    <p class="form-error" role="alert">${esc(WALL_DOWN)}</p>` }));
        if (!req.session) {
          const value = createSession(secret);
          res.append("Set-Cookie", sessionCookie(value, secureCookies(req)));
          req.session = readSession(secret, "atl_admin=" + value);
        }
      } else if (!req.session) {
        return res.redirect(303, "/admin/login");
      }
      if (req.method === "POST" && !safeEqual(req.body.csrf || "", csrfToken(secret, req.session))) {
        return res.status(403).send(adminPage(req, { title: "Try again", heading: "That form expired", body: '    <p>Go back, reload the page, and try again.</p>' }));
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const requests = (await pool.query(
        `select * from requests order by (status = 'closed'), created_at desc limit 200`
      )).rows;
      const allQuotes = requests.length ? (await pool.query(
        `select q.id, q.request_id, q.status, q.fee_percent, q.fee_paid, p.company
           from quotes q join partners p on p.id = q.partner_id
          where q.request_id = any($1::int[])`, [requests.map((r) => r.id)]
      )).rows : [];
      const applied = Number((await pool.query("select count(*) from partners where status = 'applied'")).rows[0].count);
      const owed = Number((await pool.query(
        `select coalesce(sum(round(coalesce(q.final_amount_cents, q.amount_cents) * q.fee_percent / 100.0)), 0) as cents
           from requests r join quotes q on q.id = r.chosen_quote_id
          where q.fee_percent > 0 and not q.fee_paid`
      )).rows[0].cents);

      const items = requests.map((r) => {
        const quotes = allQuotes.filter((q) => q.request_id === r.id);
        return { r, quotes, step: nextStep(r, quotes) };
      });
      // Requests that need the owner come first. Closed ones are already last.
      items.sort((a, b) => Number(b.step.needsYou) - Number(a.step.needsYou));

      const todo = [];
      const needy = items.filter((item) => item.step.needsYou);
      if (needy.length) todo.push(`<li><a href="/admin/requests/${needy[0].r.id}">${plural(needy.length, "request needs", "requests need")} companies</a></li>`);
      if (applied) todo.push(`<li><a href="/admin/partners">${plural(applied, "partner application", "partner applications")} to review</a></li>`);
      if (owed > 0) todo.push(`<li><a href="/admin/fees">${esc(formatDollars(owed))} in finder’s fees to collect</a></li>`);

      const rows = items.map(({ r, quotes, step }) => `<li class="owner-row${step.needsYou ? " needs-you" : ""}">
          <a class="owner-row-main" href="/admin/requests/${r.id}">${esc(r.service)} <span>for ${esc(r.name)}</span></a>
          <p class="owner-row-facts">${esc(r.location)}<br>Received ${esc(formatDate(r.created_at))}</p>
          <p class="owner-row-state">${pill(r.status)} <span>${quotes.filter((q) => q.status === "submitted").length} of ${plural(r.tiers.length, "quote", "quotes")} in</span></p>
          ${r.status === "closed" ? "" : `<p class="owner-row-next">${esc(step.short)}</p>`}
        </li>`).join("\n");

      res.send(adminPage(req, {
        current: "requests",
        title: "Requests",
        heading: "Requests",
        body: `    <section class="owner-todo" aria-labelledby="todo-title">
      <h2 id="todo-title">Needs you</h2>
      ${todo.length ? `<ul>${todo.join("")}</ul>` : "<p>Nothing right now.</p>"}
    </section>
    ${rows ? `<ul class="owner-list">
${rows}
    </ul>` : `<p class="owner-empty">No requests yet. They appear here as soon as a customer sends one. Your request form is on the <a href="/admin/links">Links</a> tab.</p>`}`
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/requests/:id", async (req, res, next) => {
    try {
      const found = await pool.query("select * from requests where id = $1", [Number(req.params.id) || 0]);
      if (!found.rows.length) return next();
      const r = found.rows[0];
      const quotes = (await pool.query(
        `select q.*, p.company, p.contact_name, p.phone as partner_phone, p.email as partner_email
           from quotes q join partners p on p.id = q.partner_id where q.request_id = $1`, [r.id]
      )).rows;
      const partners = (await pool.query(
        "select id, company, trade, tier from partners where status = 'verified' order by (trade = $1) desc, company", [r.service]
      )).rows;
      const open = r.status !== "chosen" && r.status !== "closed";
      const step = nextStep(r, quotes);

      const tiers = r.tiers.map((tier) => {
        const quote = quotes.find((item) => item.tier === tier);
        if (!quote) {
          if (!open) return `<li class="quote-card"><h3>${esc(tier)}</h3><p class="quote-wait">No company was assigned.</p></li>`;
          const ranked = partners.slice().sort((a, b) => (b.trade === r.service) - (a.trade === r.service) || (b.tier === tier) - (a.tier === tier));
          const choices = ranked.map((p) => `<option value="${p.id}">${esc(p.company)} (${esc(p.trade)}, ${esc(p.tier)})</option>`).join("");
          const fieldId = "partner-" + tier.toLowerCase().replace(/[^a-z]+/g, "-");
          return `<li class="quote-card"><h3>${esc(tier)}</h3>
          ${choices ? `<form method="post" action="/admin/requests/${r.id}/invite" class="stack">
            ${csrfField}<input type="hidden" name="tier" value="${esc(tier)}">
            <label for="${fieldId}">Send the brief to</label>
            <select id="${fieldId}" name="partner" required><option value="">Choose a verified partner</option>${choices}</select>
            <button class="primary" type="submit">Create quote link</button>
          </form>` : '<p class="quote-wait">No verified partners yet. <a href="/admin/partners">Add or verify one</a>.</p>'}
        </li>`;
        }
        const link = siteUrl(req) + "/q/" + quote.token;
        const chosen = r.chosen_quote_id === quote.id;
        return `<li class="quote-card${chosen ? " is-chosen" : ""}"><h3>${esc(tier)}</h3>
          <p class="quote-company">${esc(quote.company)}</p>
          <p>${pill(quote.status)}${chosen ? " " + pill("chosen") : ""}</p>
          ${quote.status === "submitted" ? `<p class="quote-price">${esc(formatDollars(quote.amount_cents))}</p>
          <dl class="quote-facts"><dt>Included</dt><dd>${esc(quote.includes)}</dd><dt>Timeline</dt><dd>${esc(quote.timeline)}</dd>${quote.warranty ? `<dt>Warranty</dt><dd>${esc(quote.warranty)}</dd>` : ""}</dl>` : ""}
          ${linkRow({
            id: "link-" + quote.id,
            label: "Partner&rsquo;s quote link",
            link,
            textTo: quote.partner_phone,
            emailTo: quote.partner_email,
            who: firstName(quote.contact_name),
            subject: r.service + " job to quote",
            message: "AT Legacy Services has a " + r.service.toLowerCase() + " job for you to quote in " + r.location + ". The details and your quote form are here:",
            open: "Open the company’s page"
          })}
          ${open && quote.status !== "submitted" ? `<form method="post" action="/admin/requests/${r.id}/uninvite">${csrfField}<input type="hidden" name="quote" value="${quote.id}"><button class="text-button" type="submit">Remove this company</button></form>` : ""}
        </li>`;
      }).join("\n");

      const customerLink = siteUrl(req) + "/r/" + r.token;
      const callTo = dial(r.phone);
      const mailTo = emailLink(r.email, "Your " + r.service.toLowerCase() + " request", "");
      res.send(adminPage(req, {
        current: "requests",
        back: { href: "/admin", label: "Back to all requests" },
        title: r.service + " request",
        heading: r.service + " for " + r.name,
        intro: "Received " + formatDate(r.created_at) + ". " + (STATUS_LABELS[r.status] || r.status) + ".",
        body: `    <p class="owner-next${step.needsYou ? " needs-you" : ""}"><strong>Next:</strong> ${esc(step.long)}</p>
    <section class="app-section">
      <h2>Quotes</h2>
      <p class="form-note">Each company gets its own link. Its page shows the job brief and a form for their price. It never shows the customer&rsquo;s name or number.</p>
      <ul class="quote-cards">
${tiers}
      </ul>
    </section>
    <section class="app-section">
      <h2>Customer</h2>
      <dl class="brief">
        <dt>Name</dt><dd>${esc(r.name)}</dd>
        <dt>Phone</dt><dd>${esc(r.phone)}${callTo ? ` <span class="contact-links"><a href="tel:${esc(callTo)}">Call</a> <a href="${esc(textLink(r.phone, ""))}">Text</a></span>` : ""}</dd>
        ${r.email ? `<dt>Email</dt><dd>${esc(r.email)}${mailTo ? ` <span class="contact-links"><a href="${esc(mailTo)}">Email</a></span>` : ""}</dd>` : ""}
        <dt>Prefers</dt><dd>${esc(r.contact_method)}</dd>
      </dl>
      ${linkRow({
        id: "customer-link",
        label: "Customer&rsquo;s private page",
        link: customerLink,
        note: "This is the page the customer sees. Their quotes appear on it side by side, and they choose one there.",
        textTo: r.phone,
        emailTo: r.email,
        who: firstName(r.name),
        subject: "Your " + r.service.toLowerCase() + " quotes",
        message: "Hi " + firstName(r.name) + ", this is AT Legacy Services. Your " + r.service.toLowerCase() + " quotes show up on your private page:",
        open: "Open the customer’s page"
      })}
    </section>
    <section class="app-section">
      <h2>Job brief</h2>
      <p class="form-note">${r.brief.ai ? "Written by the AI review from the customer’s answers." : "Built from the customer’s answers."}${licenseCheck(r.service) ? " License to check for this service: " + esc(licenseCheck(r.service)) + "." : ""}</p>
      ${briefHtml(r)}
      <dl class="brief"><dt>Customer&rsquo;s own words</dt><dd>${esc(r.details)}</dd></dl>
    </section>
    <section class="app-section">
      <form method="post" action="/admin/requests/${r.id}/status" class="done-actions">
        ${csrfField}
        ${r.status === "chosen" ? '<button class="secondary" type="submit" name="status" value="reopen">Undo the customer’s choice</button>' : ""}
        ${r.status === "closed" ? '<button class="secondary" type="submit" name="status" value="reopen">Reopen this request</button>' : '<button class="secondary" type="submit" name="status" value="closed">Close this request</button>'}
      </form>
    </section>`
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/requests/:id/invite", async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      const request = (await pool.query("select * from requests where id = $1", [id])).rows[0];
      const partner = (await pool.query("select id from partners where id = $1 and status = 'verified'", [Number(req.body.partner) || 0])).rows[0];
      if (!request) return next();
      if (partner && request.tiers.includes(req.body.tier) && request.status !== "chosen" && request.status !== "closed") {
        await pool.query(
          `insert into quotes (request_id, partner_id, tier, token, fee_percent) values ($1, $2, $3, $4, $5)
           on conflict (request_id, tier) do nothing`,
          [id, partner.id, req.body.tier, newToken(), req.body.tier === OWN_CREW_TIER ? 0 : config.feePercent]
        );
        await pool.query("update requests set status = 'collecting' where id = $1 and status = 'new'", [id]);
      }
      res.redirect(303, "/admin/requests/" + id);
    } catch (error) {
      next(error);
    }
  });

  router.post("/requests/:id/uninvite", async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      await pool.query("delete from quotes where id = $1 and request_id = $2 and status <> 'submitted'", [Number(req.body.quote) || 0, id]);
      res.redirect(303, "/admin/requests/" + id);
    } catch (error) {
      next(error);
    }
  });

  router.post("/requests/:id/status", async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      if (req.body.status === "closed") {
        await pool.query("update requests set status = 'closed' where id = $1 and status <> 'chosen'", [id]);
      } else if (req.body.status === "reopen") {
        await pool.query(
          `update requests set chosen_quote_id = null,
                  status = case when exists (select 1 from quotes where request_id = $1) then 'collecting' else 'new' end
            where id = $1`, [id]);
      }
      res.redirect(303, "/admin/requests/" + id);
    } catch (error) {
      next(error);
    }
  });

  // Partners
  router.get("/partners", async (req, res, next) => {
    try {
      const partners = (await pool.query("select * from partners order by (status = 'applied') desc, (status = 'paused'), company")).rows;
      const rows = partners.map((p) => {
        const callTo = dial(p.phone);
        return `<li class="owner-row${p.status === "applied" ? " needs-you" : ""}">
          <a class="owner-row-main" href="/admin/partners/${p.id}">${esc(p.company)}</a>
          <p class="owner-row-facts">${esc(p.trade)}<br>${esc(p.tier)}</p>
          <p class="owner-row-facts">${esc(p.contact_name)}${callTo ? `<br><a href="tel:${esc(callTo)}">${esc(p.phone)}</a>` : (p.phone ? "<br>" + esc(p.phone) : "")}</p>
          <p class="owner-row-state">${pill(p.status)}</p>
          ${p.status === "applied" ? '<p class="owner-row-next">Review their application</p>' : ""}
        </li>`;
      }).join("\n");
      res.send(adminPage(req, {
        current: "partners",
        title: "Partners",
        heading: "Partners",
        intro: "The companies you send jobs to. Only a verified partner can be sent a job brief.",
        body: `    <p class="owner-actions"><a class="primary" href="/admin/partners/new">Add a partner</a></p>
    <ul class="owner-list">
${rows}
    </ul>
    <section class="app-section owner-after">
      <h2>Bring on a company</h2>
      ${linkRow({
        id: "signup-link", readable: true,
        label: "Company sign-up page",
        link: siteUrl(req) + "/partners",
        note: "Send this to a company you want as a partner. Their application shows up in the list above as Applied.",
        message: "AT Legacy Services sends local homeowners’ jobs to companies like yours. No lead fees. Apply here:",
        open: "Open the sign-up page"
      })}
    </section>`
      }));
    } catch (error) {
      next(error);
    }
  });

  const PARTNER_PAGE = { current: "partners", back: { href: "/admin/partners", label: "Back to all partners" } };

  function partnerForm(p, action, error) {
    const ownCrew = p.trade === OWN_CREW_SERVICE;
    const check = (name, label) => `<label class="choice"><input type="checkbox" name="${name}"${p[name] ? " checked" : ""}> <span>${label}</span></label>`;
    const input = (name, label, { required = false, max = 120, type = "text" } = {}) => `<div class="field">
          <label for="${name}">${label}${required ? "" : ' <span class="optional">(optional)</span>'}</label>
          <input id="${name}" name="${name}" type="${type}" maxlength="${max}" value="${esc(p[name] || "")}"${required ? " required" : ""}>
        </div>`;
    const license = licenseCheck(p.trade);
    return `    <form class="quote-form" method="post" action="${action}">
      ${csrfField}
      ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
      <section class="form-part">
        <h2>Company</h2>
        <div class="fields">
          ${input("company", "Company name", { required: true, max: 100 })}
          ${input("contact_name", "Contact name", { required: true, max: 80 })}
          ${input("phone", "Phone", { max: 30 })}
          ${input("email", "Email", { max: 100 })}
          <div class="field"><label for="trade">Service</label><select id="trade" name="trade" required>${options(SERVICE_NAMES, p.trade)}</select></div>
          <div class="field"><label for="tier">Tier</label><select id="tier" name="tier" required>${options(TIERS.concat(OWN_CREW_TIER), p.tier)}</select></div>
          ${input("years", "Years in business", { max: 3 })}
          ${input("license_no", "State license number", { max: 40 })}
          ${input("areas", "Areas served")}
          ${input("website", "Website")}
        </div>
      </section>
      <fieldset class="form-part tier-part">
        <legend>Verification</legend>
        ${p.insured ? `<p class="form-note">On their application: liability insurance &ldquo;${esc(p.insured)}&rdquo;.</p>` : ""}
        <div class="choices">
          ${check("check_registration", "Active Florida business registration confirmed")}
          ${check("check_license", license ? "License confirmed: " + esc(license) : "State license confirmed (only if this trade needs one)")}
          ${check("check_insurance", "Proof of liability insurance on file")}
          ${check("check_references", "Recommended by local customers")}
        </div>
        <div class="field"><label for="status">Status</label><select id="status" name="status">
          ${["applied", "verified", "paused"].map((s) => `<option value="${s}"${p.status === s ? " selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
        </select></div>
        ${ownCrew ? "" : '<p class="form-note">A partner can be marked verified only after every check that applies is ticked.</p>'}
        <div class="field wide"><label for="notes">Notes <span class="optional">(only you see these)</span></label><textarea id="notes" name="notes" rows="3" maxlength="1000">${esc(p.notes || "")}</textarea></div>
      </fieldset>
      <button class="primary" type="submit">Save partner</button>
    </form>`;
  }

  function readPartner(body) {
    const field = (name, max) => String(body[name] || "").trim().slice(0, max);
    return {
      company: field("company", 100), contact_name: field("contact_name", 80), phone: field("phone", 30), email: field("email", 100),
      trade: SERVICE_NAMES.includes(body.trade) ? body.trade : "Something else",
      tier: TIERS.concat(OWN_CREW_TIER).includes(body.tier) ? body.tier : TIERS[0],
      years: field("years", 3), license_no: field("license_no", 40), areas: field("areas", 120), website: field("website", 120),
      status: ["applied", "verified", "paused"].includes(body.status) ? body.status : "applied",
      check_registration: Boolean(body.check_registration), check_license: Boolean(body.check_license),
      check_insurance: Boolean(body.check_insurance), check_references: Boolean(body.check_references),
      notes: field("notes", 1000)
    };
  }

  function partnerProblem(p) {
    if (!p.company || !p.contact_name) return "Company name and contact name are required.";
    if (p.status === "verified" && p.trade !== OWN_CREW_SERVICE) {
      const missing = [];
      if (!p.check_registration) missing.push("business registration");
      if (licenseCheck(p.trade) && !p.check_license) missing.push("license");
      if (!p.check_insurance) missing.push("insurance");
      if (!p.check_references) missing.push("references");
      if (missing.length) return "Tick these checks before marking this partner verified: " + missing.join(", ") + ".";
    }
    return "";
  }

  router.get("/partners/new", (req, res) => {
    res.send(adminPage(req, { ...PARTNER_PAGE, title: "Add a partner", heading: "Add a partner", body: partnerForm({ trade: SERVICE_NAMES[0], tier: TIERS[0], status: "applied" }, "/admin/partners") }));
  });

  router.post("/partners", async (req, res, next) => {
    try {
      const p = readPartner(req.body);
      const problem = partnerProblem(p);
      if (problem) return res.status(400).send(adminPage(req, { ...PARTNER_PAGE, title: "Add a partner", heading: "Add a partner", body: partnerForm(p, "/admin/partners", problem) }));
      await pool.query(
        `insert into partners (company, contact_name, phone, email, trade, tier, years, license_no, areas, website, status,
                               check_registration, check_license, check_insurance, check_references, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [p.company, p.contact_name, p.phone, p.email, p.trade, p.tier, p.years, p.license_no, p.areas, p.website, p.status,
          p.check_registration, p.check_license, p.check_insurance, p.check_references, p.notes]
      );
      res.redirect(303, "/admin/partners");
    } catch (error) {
      next(error);
    }
  });

  router.get("/partners/:id", async (req, res, next) => {
    try {
      const p = (await pool.query("select * from partners where id = $1", [Number(req.params.id) || 0])).rows[0];
      if (!p) return next();
      res.send(adminPage(req, { ...PARTNER_PAGE, title: p.company, heading: p.company, intro: "Added " + formatDate(p.created_at) + ". " + STATUS_LABELS[p.status] + ".", body: partnerForm(p, "/admin/partners/" + p.id) }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/partners/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      const existing = (await pool.query("select * from partners where id = $1", [id])).rows[0];
      if (!existing) return next();
      const p = readPartner(req.body);
      const problem = partnerProblem(p);
      if (problem) {
        return res.status(400).send(adminPage(req, { ...PARTNER_PAGE, title: existing.company, heading: existing.company, body: partnerForm({ ...existing, ...p }, "/admin/partners/" + id, problem) }));
      }
      await pool.query(
        `update partners set company = $1, contact_name = $2, phone = $3, email = $4, trade = $5, tier = $6, years = $7,
                license_no = $8, areas = $9, website = $10, status = $11, check_registration = $12, check_license = $13,
                check_insurance = $14, check_references = $15, notes = $16
          where id = $17`,
        [p.company, p.contact_name, p.phone, p.email, p.trade, p.tier, p.years, p.license_no, p.areas, p.website, p.status,
          p.check_registration, p.check_license, p.check_insurance, p.check_references, p.notes, id]
      );
      res.redirect(303, "/admin/partners");
    } catch (error) {
      next(error);
    }
  });

  // Fees: one row per job a customer awarded to a partner.
  router.get("/fees", async (req, res, next) => {
    try {
      const jobs = (await pool.query(
        `select q.*, p.company, r.service, r.name as customer_name, r.id as r_id
           from requests r
           join quotes q on q.id = r.chosen_quote_id
           join partners p on p.id = q.partner_id
          where q.fee_percent > 0
          order by q.fee_paid, r.created_at desc`
      )).rows;
      let owed = 0;
      let paid = 0;
      const rows = jobs.map((job) => {
        const total = Number(job.final_amount_cents || job.amount_cents);
        const fee = Math.round(total * Number(job.fee_percent) / 100);
        if (job.fee_paid) paid += fee; else owed += fee;
        return `<li class="owner-row fee-row${job.fee_paid ? "" : " needs-you"}">
            <a class="owner-row-main" href="/admin/requests/${job.r_id}">${esc(job.service)} <span>for ${esc(job.customer_name)}</span></a>
            <p class="owner-row-facts">${esc(job.company)}<br>Quoted ${esc(formatDollars(job.amount_cents))} at ${esc(Number(job.fee_percent))}%</p>
            <p class="owner-row-state"><strong class="fee-amount">${esc(formatDollars(fee))}</strong> <span>${job.fee_paid ? "Paid" : "Owed to you"}</span></p>
            <form method="post" action="/admin/fees/${job.id}" class="fee-form">
              ${csrfField}
              <label for="final-${job.id}">Final job total</label>
              <input id="final-${job.id}" name="final" type="text" inputmode="decimal" maxlength="14" value="${esc(formatDollars(job.final_amount_cents))}" placeholder="${esc(formatDollars(job.amount_cents))}">
              <label class="choice"><input type="checkbox" name="paid"${job.fee_paid ? " checked" : ""}> <span>Fee paid</span></label>
              <button class="secondary" type="submit">Save</button>
            </form>
          </li>`;
      }).join("\n");
      res.send(adminPage(req, {
        current: "fees",
        title: "Fees",
        heading: "Finder’s fees",
        intro: "Owed to you now: " + formatDollars(owed) + ". Collected so far: " + formatDollars(paid) + ".",
        body: `    <p class="form-note owner-lead">One row for each job a customer awarded. The fee uses the final job total when you enter one, and the quoted price until then.</p>
    ${rows ? `<ul class="owner-list">
${rows}
    </ul>` : '<p class="owner-empty">No jobs have been awarded yet. A job shows up here when a customer chooses a company.</p>'}`
      }));
    } catch (error) {
      next(error);
    }
  });

  // Links: every page of the site and who it is for.
  router.get("/links", (req, res) => {
    const site = siteUrl(req);
    res.send(adminPage(req, {
      current: "links",
      title: "Links",
      heading: "Links",
      intro: "Every page of the site, and who each one is for.",
      body: `    <section class="app-section">
      <h2>Yours</h2>
      ${linkRow({ id: "link-dashboard", readable: true, label: "This dashboard", link: site + "/admin", note: "Private. It opens only after you sign in. Every dashboard page has the gold bar at the top.", share: false })}
    </section>
    <section class="app-section">
      <h2>For customers</h2>
      ${linkRow({ id: "link-quote", readable: true, label: "Request form", link: site + "/quote", note: "Send or post this one. A customer describes the job once and picks the tiers they want. Their request then shows up under Requests.", message: "Get up to three quotes from verified local companies with one request:", open: "Open the request form" })}
      ${linkRow({ id: "link-home", readable: true, label: "Home page", link: site + "/", note: "Explains how it works, the three tiers, and the services.", message: "AT Legacy Services: one request, three quotes from verified local companies.", open: "Open the home page" })}
    </section>
    <section class="app-section">
      <h2>For companies</h2>
      ${linkRow({ id: "link-partners", readable: true, label: "Company sign-up page", link: site + "/partners", note: "Send this to a company you want as a partner. Their application then shows up under Partners.", message: "AT Legacy Services sends local homeowners’ jobs to companies like yours. No lead fees. Apply here:", open: "Open the sign-up page" })}
    </section>
    <section class="app-section">
      <h2>Made for each job</h2>
      <dl class="brief">
        <dt>Customer&rsquo;s private page</dt><dd>One per request. The customer sees their quotes there and chooses. Find the link on the request, under Customer.</dd>
        <dt>Company&rsquo;s quote page</dt><dd>One per company on each request. The company reads the brief and enters a price. Find the link on the request, under Quotes.</dd>
      </dl>
    </section>`
    }));
  });

  router.post("/fees/:id", async (req, res, next) => {
    try {
      const final = String(req.body.final || "").trim();
      const cents = final ? dollarsToCents(final) : null;
      if (final && !cents) {
        return res.status(400).send(adminPage(req, { current: "fees", back: { href: "/admin/fees", label: "Back to fees" }, title: "Fees", heading: "That amount didn’t work", body: '    <p>Enter the final job total as a dollar amount, like 5200 or 5,200.00.</p>' }));
      }
      await pool.query("update quotes set final_amount_cents = $1, fee_paid = $2 where id = $3", [cents, Boolean(req.body.paid), Number(req.params.id) || 0]);
      res.redirect(303, "/admin/fees");
    } catch (error) {
      next(error);
    }
  });

  return router;
};
