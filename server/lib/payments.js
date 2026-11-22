// Online payment through Stripe, used only by the public side of the site (the hub).
//
// With STRIPE_SECRET_KEY set on the hub, a company pays an invoice's exact amount on a page that
// Stripe hosts. The hub then asks Stripe how each of those pages ended and marks the invoice paid,
// so nothing has to be ticked by hand. It asks when the company comes back from Stripe, and once a
// minute for every invoice that has a payment page out. No address has to be registered with Stripe.
//
// A card or bank number never touches this app: the company types it on Stripe's page.
// The key is read from the environment and is never written to the database, a page, or a log.
//
// A restricted key (rk_...) is enough, with these permissions:
//   Checkout Sessions: Write     to make the payment page and read how it ended
//   Payment Intents: Read        to follow a payment: a bank payment that fails, and the two below
//   Charges and Refunds: Read    for card or bank, and to notice a refund made in Stripe
//   Balance: Read                for what Stripe kept, shown in the books
// Only the first is required. Without the others a payment is still marked paid.
//
// A key counts as working once it has made a payment page. So the first time the hub meets a key
// it makes one page for a made-up amount, closes it at once, and never hands its address to anyone.

const { invoiceRef, money, markPaid, syncQuote } = require("./invoices");

const API = "https://api.stripe.com";
const KEY_SHAPE = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/;

// Stripe names keys in its error messages. Nothing that looks like one is ever shown or stored.
function tidy(message) {
  return String(message || "").replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, "your key").replace(/\s+/g, " ").trim().slice(0, 300);
}

class StripeProblem extends Error {
  constructor(message, { status = 0, permission = "" } = {}) {
    super(tidy(message));
    this.status = status;
    // The permission a restricted key would need, as Stripe names it: checkout_session_write
    this.permission = permission;
  }
}

// Stripe takes form fields, with nested ones written as line_items[0][quantity]=1.
function formFields(value, prefix = "", out = new URLSearchParams()) {
  if (Array.isArray(value)) value.forEach((item, index) => formFields(item, prefix + "[" + index + "]", out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) formFields(item, prefix ? prefix + "[" + key + "]" : key, out);
  else if (value !== undefined && value !== null) out.append(prefix, String(value));
  return out;
}

// What the permission is called on Stripe's "Create restricted key" page.
const PERMISSION_NAMES = {
  checkout_session: "Checkout Sessions", charge: "Charges and Refunds", balance: "Balance", payment_intent: "Payment Intents",
  product: "Products", plan: "Prices"
};

// What the page made to try a key is called in Stripe, so the owner knows what it was if they come across it.
const CHECK_NAME = "Connection check from AT Legacy Services (not a payment)";

function createPayments({ pool, config, fetchImpl, notify = async () => false }) {
  const key = config.stripeKey || "";
  const wellFormed = KEY_SHAPE.test(key);
  // Only the public side talks to Stripe. The dashboard reads what it reported.
  const enabled = wellFormed && !config.dashboardOnly;
  const mode = wellFormed ? key.split("_")[1] : "";
  const kind = key.startsWith("rk_") ? "restricted" : "standard";
  // What the key has turned out to be allowed to read. Reset by check().
  const can = { intents: true, charges: true, balance: true };
  let running = false;
  // True once Stripe has accepted the key and made a payment page with it. Until then no page offers to pay through Stripe.
  let accepted = false;
  // True once this key has made a payment page, so the try isn't repeated at every later check.
  let proven = false;
  // Set when Stripe turns down a payment page for an invoice: the key is tried again within the minute.
  let recheck = false;
  let checkedAt = 0;

  async function api(method, path, params) {
    const options = { method, headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(12000) };
    if (params) {
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      options.body = formFields(params).toString();
    }
    let response;
    try {
      response = await fetchImpl(API + path, options);
    } catch (error) {
      throw new StripeProblem("Couldn’t reach Stripe (" + (error.name === "TimeoutError" ? "no answer in time" : error.message) + ").");
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data) return data;
    const said = data && data.error && data.error.message ? data.error.message : "Stripe answered with status " + response.status + ".";
    const needs = /Having the '?rak_([a-z_]+?)_(read|write)'? permission/.exec(said);
    throw new StripeProblem(said, { status: response.status, permission: needs ? needs[1] + "_" + needs[2] : "" });
  }

  // A sentence the owner can act on.
  function explain(problem) {
    if (problem.permission) {
      const [, resource, level] = /^(.*)_(read|write)$/.exec(problem.permission);
      return "The key isn’t allowed to do this yet. In Stripe, edit the key and set " + (PERMISSION_NAMES[resource] || resource.replace(/_/g, " ")) +
        " to " + (level === "write" ? "Write" : "Read") + ".";
    }
    if (problem.status === 401) return "Stripe didn’t accept the key. Check that the whole key was pasted, with nothing before or after it.";
    if (/cannot currently make live charges/i.test(problem.message)) {
      return "Stripe says your account can’t take live payments yet. Finish setting up your account in Stripe (your business details and the bank account you are paid into). This page catches up within ten minutes of that.";
    }
    return problem.message;
  }

  // The address of the payment page in Stripe's answer. It is at checkout.stripe.com, or at the owner's own address if they set one up in Stripe.
  function pageAddress(session) {
    let address;
    try {
      address = new URL(session.url);
    } catch (error) {
      address = null;
    }
    if (!session.id || !address || address.protocol !== "https:") throw new StripeProblem("Stripe’s answer had no payment page in it.");
    return address.toString();
  }

  // Makes one payment page the way an invoice's is made, then closes it. Nobody is given its address.
  // This is what shows that the key may make pages and that the Stripe account can take payments.
  async function tryPage() {
    const home = /^https:\/\//.test(config.publicUrl || "") ? config.publicUrl : "https://example.com";
    let session;
    try {
      session = await api("POST", "/v1/checkout/sessions", {
        mode: "payment",
        success_url: home,
        cancel_url: home,
        // The shortest life Stripe allows is thirty minutes, in case closing it below doesn't go through.
        expires_at: Math.floor(Date.now() / 1000) + 45 * 60,
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 2500, product_data: { name: CHECK_NAME } } }],
        metadata: { check: "connection" }
      });
    } catch (problem) {
      return explain(problem);
    }
    if (session.id) {
      try {
        await api("POST", "/v1/checkout/sessions/" + encodeURIComponent(session.id) + "/expire");
      } catch (problem) {
        console.error("Stripe: the connection check’s page could not be closed. It closes by itself within the hour:", problem.message);
      }
    }
    try {
      pageAddress(session);
    } catch (problem) {
      return explain(problem);
    }
    proven = true;
    return "ok";
  }

  async function readStatus() {
    const row = (await pool.query("select value from settings where key = 'stripe_status'")).rows[0];
    try {
      return row ? JSON.parse(row.value) : null;
    } catch (error) {
      return null;
    }
  }

  async function saveStatus(patch) {
    if (config.dashboardOnly) return;
    const status = { ...((await readStatus()) || {}), ...patch };
    await pool.query(
      "insert into settings (key, value) values ('stripe_status', $1) on conflict (key) do update set value = excluded.value",
      [JSON.stringify(status)]
    );
  }

  // Tries the key and writes down what it can do, for the dashboard's Fee settings page.
  async function check() {
    if (config.dashboardOnly) return null;
    const status = { on: enabled, mode, kind, checkedAt: new Date().toISOString(), ok: false, problem: "", sessions: "", pages: "", intents: "", charges: "", balance: "" };
    if (!key) {
      await saveStatus(status);
      return status;
    }
    if (!wellFormed) {
      status.problem = /^pk_/.test(key) ? "That is a publishable key (it starts with pk_). The site needs the restricted or secret key instead."
        : /^whsec_/.test(key) ? "That is a webhook signing secret (it starts with whsec_). The site needs the restricted or secret key instead."
          : "That doesn’t look like a Stripe key. It should start with rk_live_ or sk_live_.";
      await saveStatus(status);
      return status;
    }
    const tryRead = async (path) => {
      try {
        await api("GET", path);
        return "ok";
      } catch (problem) {
        return explain(problem);
      }
    };
    status.sessions = await tryRead("/v1/checkout/sessions?limit=1");
    if (status.sessions === "ok") {
      status.pages = proven ? "ok" : await tryPage();
      status.intents = await tryRead("/v1/payment_intents?limit=1");
      status.charges = await tryRead("/v1/charges?limit=1");
      status.balance = await tryRead("/v1/balance_transactions?limit=1");
    }
    status.ok = status.sessions === "ok" && status.pages === "ok";
    accepted = status.ok;
    checkedAt = Date.now();
    recheck = false;
    if (!status.ok) status.problem = status.sessions === "ok" ? status.pages : status.sessions;
    // A key that has just made a page has nothing left to report from an earlier failure.
    else status.lastCheckoutProblem = "";
    can.intents = status.intents === "ok";
    can.charges = status.charges === "ok";
    can.balance = status.balance === "ok";
    await saveStatus(status);
    return status;
  }

  // Reads one thing if the key may. A refusal is remembered, so it isn't asked again every minute.
  async function read(path, what) {
    if (what && !can[what]) return null;
    try {
      return await api("GET", path);
    } catch (problem) {
      if (problem.permission && what) can[what] = false;
      else console.error("Stripe: could not read", path.split("/").slice(0, 3).join("/") + ":", problem.message);
      return null;
    }
  }

  // After a payment: card or bank, and what Stripe kept. Each part is left out if the key can't read it.
  async function detailsOf(intentId) {
    const out = { intent: intentId || "", charge: "", how: "Stripe", fee: null };
    if (!intentId) return out;
    const intent = await read("/v1/payment_intents/" + encodeURIComponent(intentId), "intents");
    const latest = intent && (intent.latest_charge || (intent.charges && intent.charges.data && intent.charges.data[0]));
    const chargeId = typeof latest === "string" ? latest : latest && latest.id;
    if (!chargeId) return out;
    out.charge = chargeId;
    const charge = await read("/v1/charges/" + encodeURIComponent(chargeId), "charges");
    if (!charge) return out;
    const type = charge.payment_method_details && charge.payment_method_details.type;
    if (type === "card") out.how = "Card through Stripe";
    if (type === "us_bank_account") out.how = "Bank through Stripe";
    const entry = typeof charge.balance_transaction === "string" ? charge.balance_transaction : charge.balance_transaction && charge.balance_transaction.id;
    const balance = entry ? await read("/v1/balance_transactions/" + encodeURIComponent(entry), "balance") : null;
    if (balance && Number.isInteger(balance.fee)) out.fee = balance.fee;
    return out;
  }

  const idOf = (value) => (typeof value === "string" ? value : value && value.id ? value.id : "");

  const forgetPage = (invoiceId) => pool.query(
    "update invoices set stripe_session_id = '', stripe_session_url = '', stripe_session_expires = null, stripe_checked_at = now() where id = $1", [invoiceId]);

  // Closes a payment page nobody should pay any more, then forgets it. Returns false if Stripe couldn't be told.
  async function closePage(invoice) {
    try {
      await api("POST", "/v1/checkout/sessions/" + encodeURIComponent(invoice.stripe_session_id) + "/expire");
    } catch (problem) {
      console.error("Stripe: could not close the payment page for " + invoiceRef(invoice) + ":", problem.message);
      return false;
    }
    await forgetPage(invoice.id);
    return true;
  }

  // Asks Stripe how this invoice's payment page ended, and records the answer. Returns true when the invoice was just paid.
  async function syncInvoice(invoice) {
    if (!enabled || !accepted || !invoice.stripe_session_id || invoice.paid_at) return false;
    let session;
    try {
      session = await api("GET", "/v1/checkout/sessions/" + encodeURIComponent(invoice.stripe_session_id));
    } catch (problem) {
      // Stripe doesn't know this page, for instance after a test key was swapped for the live one. Start clean.
      if (problem.status === 404) {
        await pool.query("update invoices set pending_since = null, stripe_session_id = '', stripe_session_url = '', stripe_session_expires = null where id = $1", [invoice.id]);
      } else {
        console.error("Stripe: could not check " + invoiceRef(invoice) + ":", problem.message);
      }
      return false;
    }
    const ref = invoiceRef(invoice);
    if (session.payment_status === "paid") {
      if (Number(session.amount_total) !== Number(invoice.amount_cents) || session.currency !== "usd") {
        // Should never happen: the page is made for the invoice's own amount. Leave it for the owner to look at.
        console.error("Stripe: the payment for " + ref + " is not for the invoice’s amount. It was left unpaid.");
        await pool.query("update invoices set payment_note = $2, stripe_checked_at = now() where id = $1",
          [invoice.id, "A payment arrived that doesn’t match this invoice’s amount. Look at it in Stripe before marking this paid."]);
        return false;
      }
      const details = await detailsOf(idOf(session.payment_intent));
      const fresh = await markPaid(pool, invoice.id, details);
      if (fresh) {
        await saveStatus({ lastPaidAt: new Date().toISOString() });
        notify(invoice.company + " paid " + ref,
          invoice.company + " paid invoice " + ref + " (" + money(invoice.amount_cents) + ") for job " + invoice.job_ref + ". It is marked paid in your dashboard under Fees.");
      }
      return fresh;
    }
    if (session.status === "complete") {
      // A bank payment: the company has finished Stripe's page, and the money takes a few days.
      const intent = await read("/v1/payment_intents/" + encodeURIComponent(idOf(session.payment_intent)), "intents");
      if (intent && (intent.status === "requires_payment_method" || intent.status === "canceled")) {
        await pool.query(
          `update invoices set pending_since = null, stripe_session_id = '', stripe_session_url = '', stripe_session_expires = null,
                  payment_note = $2, stripe_checked_at = now() where id = $1`,
          [invoice.id, "A bank payment was started and did not go through."]
        );
        notify("A bank payment for " + ref + " did not go through",
          invoice.company + " started a bank payment for invoice " + ref + " and it did not go through. The invoice is unpaid again, and they can pay from the same link.");
        return false;
      }
      const started = await pool.query("update invoices set pending_since = now(), payment_note = '', stripe_checked_at = now() where id = $1 and pending_since is null", [invoice.id]);
      if (started.rowCount) {
        notify(invoice.company + " started a bank payment for " + ref,
          invoice.company + " started a bank payment for invoice " + ref + " (" + money(invoice.amount_cents) + "). Bank payments take a few business days. The invoice will mark itself paid when the money arrives.");
      } else {
        await pool.query("update invoices set stripe_checked_at = now() where id = $1", [invoice.id]);
      }
      return false;
    }
    if (session.status === "expired") {
      await forgetPage(invoice.id);
      return false;
    }
    // Still open. If the owner has since marked the invoice no fee, nobody should pay it: close the page.
    if (invoice.voided_at) {
      await closePage(invoice);
      return false;
    }
    await pool.query("update invoices set stripe_checked_at = now() where id = $1", [invoice.id]);
    return false;
  }

  // The address of Stripe's payment page for this invoice. One page is kept per invoice until it expires.
  // `base` is this site's own address, for the way back.
  async function startCheckout(invoice, base) {
    if (!enabled || !accepted) throw new StripeProblem("Online payment isn’t set up.");
    const expires = invoice.stripe_session_expires ? new Date(invoice.stripe_session_expires).getTime() : 0;
    if (invoice.stripe_session_id && invoice.stripe_session_url && expires - Date.now() > 10 * 60 * 1000) return invoice.stripe_session_url;
    const ref = invoiceRef(invoice);
    const page = base + "/q/invoice/" + invoice.token;
    let session;
    try {
      session = await api("POST", "/v1/checkout/sessions", {
        mode: "payment",
        client_reference_id: ref,
        success_url: page,
        cancel_url: page,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Number(invoice.amount_cents),
            product_data: { name: "Finder’s fee, invoice " + ref, description: "Job " + invoice.job_ref + ", " + invoice.service }
          }
        }],
        metadata: { invoice: ref },
        payment_intent_data: { description: "AT Legacy Services invoice " + ref, metadata: { invoice: ref } }
      });
    } catch (problem) {
      // Stripe said no (a permission taken away, an account on hold). Try the key again before another company runs into it.
      if (problem.status >= 400 && problem.status < 500) {
        proven = false;
        recheck = true;
      }
      await saveStatus({ lastCheckoutAt: new Date().toISOString(), lastCheckoutProblem: explain(problem) });
      throw problem;
    }
    proven = true;
    recheck = false;
    const address = pageAddress(session);
    await pool.query(
      "update invoices set stripe_session_id = $2, stripe_session_url = $3, stripe_session_expires = to_timestamp($4), stripe_checked_at = now() where id = $1",
      [invoice.id, session.id, address, Number(session.expires_at) || Math.floor(Date.now() / 1000) + 23 * 3600]
    );
    await saveStatus({ lastCheckoutAt: new Date().toISOString(), lastCheckoutProblem: "" });
    return address;
  }

  // Once a minute on the hub: every invoice with a payment page out, then the slower follow-ups.
  // The key is tried again every ten minutes while anything is still off, so a permission the owner
  // switches on in Stripe is picked up without a restart. Once everything works, four times a day.
  async function syncAll() {
    if (!enabled || running) return;
    running = true;
    try {
      const settled = accepted && can.intents && can.charges && can.balance;
      if (recheck || Date.now() - checkedAt > (settled ? 6 * 60 : 10) * 60 * 1000) await check();
      if (!accepted) return;
      const waiting = (await pool.query("select * from invoices where stripe_session_id <> '' and paid_at is null order by id limit 50")).rows;
      for (const invoice of waiting) await syncInvoice(invoice);
      // Marked paid by hand while a payment page was still out: close the page so it can't be paid a second time.
      // If the company had already paid there too, say so, because one of the two payments has to go back.
      const byHand = (await pool.query("select * from invoices where stripe_session_id <> '' and paid_at is not null and stripe_payment_intent = '' order by id limit 20")).rows;
      for (const invoice of byHand) {
        let session = null;
        try {
          session = await api("GET", "/v1/checkout/sessions/" + encodeURIComponent(invoice.stripe_session_id));
        } catch (problem) {
          if (problem.status !== 404) continue;
        }
        if (session && session.payment_status === "paid") {
          await forgetPage(invoice.id);
          await pool.query("update invoices set payment_note = $2 where id = $1",
            [invoice.id, "This invoice was also paid through Stripe. One of the two payments should go back to the company."]);
          notify(invoiceRef(invoice) + " was paid twice",
            "You marked invoice " + invoiceRef(invoice) + " (" + invoice.company + ") paid, and the company also paid it through Stripe. One of the two payments should go back to them.");
        } else if (session && session.status === "open") {
          await closePage(invoice);
        } else {
          await forgetPage(invoice.id);
        }
      }
      if (!can.charges) return;
      // What Stripe kept isn't always known the moment a payment lands. Look again for up to two weeks.
      const unpriced = !can.intents || !can.balance ? [] : (await pool.query(
        `select * from invoices
          where paid_at is not null and stripe_payment_intent <> '' and processor_fee_cents is null and paid_at > now() - interval '14 days'
            and (stripe_checked_at is null or stripe_checked_at < now() - interval '10 minutes')
          order by id limit 20`
      )).rows;
      for (const invoice of unpriced) {
        const details = await detailsOf(invoice.stripe_payment_intent);
        // A look that learned nothing new never replaces "Card through Stripe" with the plain "Stripe".
        await pool.query("update invoices set processor_fee_cents = $2, paid_how = case when $3 = 'Stripe' then paid_how else $3 end, stripe_charge = $4, stripe_checked_at = now() where id = $1",
          [invoice.id, details.fee, details.how, details.charge || invoice.stripe_charge]);
      }
      // A refund made in Stripe shows up here within half a day.
      const recent = (await pool.query(
        `select * from invoices
          where paid_at is not null and stripe_charge <> '' and refunded_cents < amount_cents and paid_at > now() - interval '120 days'
            and stripe_checked_at < now() - interval '12 hours'
          order by id limit 20`
      )).rows;
      for (const invoice of recent) {
        const charge = await read("/v1/charges/" + encodeURIComponent(invoice.stripe_charge), "charges");
        const refunded = charge ? Math.min(Number(charge.amount_refunded) || 0, Number(invoice.amount_cents)) : 0;
        if (refunded > Number(invoice.refunded_cents)) {
          await pool.query("update invoices set refunded_cents = $2, refunded_at = now(), stripe_checked_at = now() where id = $1", [invoice.id, refunded]);
          await syncQuote(pool, invoice.id);
          notify("A refund on " + invoiceRef(invoice), money(refunded) + " of invoice " + invoiceRef(invoice) + " (" + invoice.company + ") was refunded in Stripe. Your books now show it.");
        } else {
          await pool.query("update invoices set stripe_checked_at = now() where id = $1", [invoice.id]);
        }
      }
    } finally {
      running = false;
    }
  }

  return { enabled, ready: () => enabled && accepted, mode, kind, check, readStatus, syncInvoice, syncAll, startCheckout, explain };
}

module.exports = { createPayments, formFields, tidy, StripeProblem };
