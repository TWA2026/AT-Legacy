// Invoices: the ledger of finder's fees.
//
// One invoice is issued when a customer chooses a company that owes a fee. It keeps its own copy of
// what it bills (company, job, amounts), so it stays in the books when the request is deleted, and it
// never holds the customer's name. An invoice is never deleted and its number is never used twice.
//
//   open      issued and not paid yet. It is overdue from the day after its due day.
//   paid      paid in full, marked by the owner or reported by Stripe
//   refunded  paid, and then the money went back
//   void      no fee is owed: the owner waived it, or the customer's choice was undone
//
// The owner's two switches on the Fees page map straight onto this:
//   "Fee paid" sets or clears the payment, and "No fee on this job" voids an unpaid invoice
//   or records a refund on a paid one.

const { newToken } = require("./security");
const { feeCents, loadFee, workingText } = require("./fees");
const { SEND_EVENTS, requestRef, isPersonOpening } = require("./links");

const TIME_ZONE = "America/New_York";

// How the owner can say a fee was paid when it did not come through Stripe.
const PAID_HOW = ["Zelle", "Check", "Cash", "Payment link", "Another way"];
// These reach the bank whole. For the others, what the payment service kept isn't known here.
const NO_PROCESSING_FEE = ["Zelle", "Check", "Cash"];

const WAIVED = "No fee on this job";
const UNDONE = "The customer’s choice was undone";
const DELETED = "The request was deleted";

const invoiceRef = (invoice) => "INV-" + invoice.number;

// Money on an invoice always shows its cents: $455.00
function money(cents) {
  const amount = Number(cents) / 100;
  return (amount < 0 ? "-$" : "$") + Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A calendar day in the business's own time zone, as 2026-11-22. Months and years are its prefixes.
function dayOf(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function daysApart(fromDay, toDay) {
  return Math.round((Date.parse(toDay + "T00:00:00Z") - Date.parse(fromDay + "T00:00:00Z")) / 86400000);
}

// Where an invoice stands today.
function statusOf(invoice, now = new Date()) {
  const amount = Number(invoice.amount_cents);
  const refunded = Number(invoice.refunded_cents) || 0;
  if (invoice.paid_at) {
    return refunded >= amount ? { key: "refunded" } : { key: "paid", partRefunded: refunded };
  }
  if (invoice.voided_at) return { key: "void" };
  const late = daysApart(dayOf(invoice.due_at), dayOf(now));
  return { key: "open", overdue: late > 0, daysLate: Math.max(late, 0), pending: Boolean(invoice.pending_since) };
}

// The terms an invoice was issued under, in the shape server/lib/fees.js reads.
const termsRow = (invoice) => ({
  amount_cents: invoice.quoted_cents, fee_percent: invoice.fee_percent, fee_min_cents: invoice.fee_min_cents, fee_max_cents: invoice.fee_max_cents
});

// "5% of $9,100 is $455"
const working = (invoice) => workingText(termsRow(invoice));

// Issues an invoice for every chosen quote that owes a fee and has none yet. Safe to call at any
// time: it is how the first invoices appear for jobs won before invoices existed.
// Returns how many were issued.
async function issueMissing(pool, config, { quoteId = null } = {}) {
  const owed = (await pool.query(
    `select q.id as quote_id, q.tier, q.amount_cents, q.fee_percent, q.fee_min_cents, q.fee_max_cents, q.fee_paid, q.fee_waived,
            r.id as request_id, r.service, r.chosen_at, p.id as partner_id, p.company
       from requests r
       join quotes q on q.id = r.chosen_quote_id
       join partners p on p.id = q.partner_id
      where q.fee_percent > 0 and q.amount_cents is not null
        and ($1::int is null or q.id = $1::int)
        and not exists (select 1 from invoices i where i.quote_id = q.id and i.current)
      order by r.chosen_at nulls first, q.id`,
    [quoteId]
  )).rows;
  if (!owed.length) return 0;
  const fee = await loadFee(pool, config);
  let issued = 0;
  for (const row of owed) {
    const amount = feeCents(row);
    if (!amount) continue;
    try {
      const done = await pool.query(
        `insert into invoices (number, token, quote_id, request_id, partner_id, company, service, tier, job_ref, quoted_cents,
                               fee_percent, fee_min_cents, fee_max_cents, amount_cents, issued_at, due_at,
                               paid_at, paid_how, voided_at, void_reason)
         select nextval('invoice_number_seq'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14::timestamptz, $14::timestamptz + make_interval(days => $15::int),
                case when $16::boolean and not $17::boolean then now() end, case when $16::boolean and not $17::boolean then 'Another way' else '' end,
                case when $17::boolean then now() end, case when $17::boolean then $18 else '' end
          where not exists (select 1 from invoices i where i.quote_id = $2 and i.current)`,
        [newToken(), row.quote_id, row.request_id, row.partner_id, row.company, row.service, row.tier, requestRef(row.request_id), row.amount_cents,
          row.fee_percent, row.fee_min_cents, row.fee_max_cents, amount, row.chosen_at || new Date(), fee.dueDays,
          Boolean(row.fee_paid), Boolean(row.fee_waived), WAIVED]
      );
      issued += done.rowCount;
    } catch (error) {
      // Two pages asked at the same moment and the other one issued it.
      if (error.code !== "23505") throw error;
    }
  }
  return issued;
}

const LOAD = `select i.*, (r.id is not null) as has_request, r.name as customer_name,
                     p.contact_name, p.phone as partner_phone, p.email as partner_email
                from invoices i
                left join requests r on r.id = i.request_id
                left join partners p on p.id = i.partner_id`;

async function loadInvoices(pool) {
  return (await pool.query(LOAD + " order by i.number desc limit 5000")).rows;
}

async function loadInvoice(pool, id) {
  return (await pool.query(LOAD + " where i.id = $1", [Number(id) || 0])).rows[0] || null;
}

async function loadByToken(pool, token) {
  return (await pool.query(LOAD + " where i.token = $1", [String(token || "")])).rows[0] || null;
}

// The current invoice of one quote, issued first if the quote owes a fee and has none.
async function invoiceForQuote(pool, config, quoteId) {
  await issueMissing(pool, config, { quoteId });
  return (await pool.query(LOAD + " where i.quote_id = $1 and i.current", [quoteId])).rows[0] || null;
}

// The quote keeps two simple flags the rest of the dashboard reads. They follow the invoice.
async function syncQuote(pool, invoiceId) {
  await pool.query(
    `update quotes q
        set fee_paid = (i.paid_at is not null and i.refunded_cents < i.amount_cents),
            fee_waived = (i.voided_at is not null or (i.paid_at is not null and i.refunded_cents >= i.amount_cents))
       from invoices i
      where i.id = $1 and i.current and q.id = i.quote_id`,
    [invoiceId]
  );
}

// The owner's switches on the Fees page. `paid` and `noFee` are the two boxes as ticked.
// A payment Stripe reported can't be unticked by hand: the money is there. It can be refunded.
async function settle(pool, invoice, { paid, noFee, how = "" }) {
  const was = statusOf(invoice).key;
  const viaStripe = Boolean(invoice.paid_at && invoice.stripe_payment_intent);
  const paidHow = PAID_HOW.includes(how) ? how : PAID_HOW[PAID_HOW.length - 1];
  if (was === "void" && !invoice.current) return invoice;
  if (was === "open" || was === "void") {
    if (noFee) {
      await pool.query("update invoices set voided_at = coalesce(voided_at, now()), void_reason = $2 where id = $1", [invoice.id, WAIVED]);
    } else if (paid) {
      await pool.query(
        "update invoices set voided_at = null, void_reason = '', paid_at = now(), paid_how = $2, processor_fee_cents = $3, pending_since = null, payment_note = '' where id = $1",
        [invoice.id, paidHow, NO_PROCESSING_FEE.includes(paidHow) ? 0 : null]
      );
    } else {
      await pool.query("update invoices set voided_at = null, void_reason = '' where id = $1", [invoice.id]);
    }
  } else if (!paid && !viaStripe) {
    // Marked paid by mistake.
    await pool.query(
      `update invoices set paid_at = null, paid_how = '', processor_fee_cents = null, refunded_cents = 0, refunded_at = null,
              voided_at = case when $2::boolean then now() end, void_reason = case when $2::boolean then $3 else '' end
        where id = $1`,
      [invoice.id, Boolean(noFee), WAIVED]
    );
  } else if (noFee) {
    await pool.query("update invoices set refunded_cents = amount_cents, refunded_at = coalesce(refunded_at, now()) where id = $1", [invoice.id]);
  } else {
    await pool.query("update invoices set refunded_cents = 0, refunded_at = null where id = $1", [invoice.id]);
  }
  await syncQuote(pool, invoice.id);
  return loadInvoice(pool, invoice.id);
}

// A payment Stripe reported. `fee` is what Stripe kept, in cents, or null when it isn't known yet.
// A payment on an invoice the owner had waived still counts: the money arrived, so the owner decides.
async function markPaid(pool, invoiceId, { how, fee = null, intent = "", charge = "" }) {
  const done = await pool.query(
    `update invoices
        set paid_at = now(), paid_how = $2, processor_fee_cents = $3, stripe_payment_intent = $4, stripe_charge = $5,
            voided_at = null, void_reason = '', pending_since = null, payment_note = '', stripe_checked_at = now()
      where id = $1 and paid_at is null`,
    [invoiceId, how, fee, intent, charge]
  );
  if (done.rowCount) await syncQuote(pool, invoiceId);
  return done.rowCount > 0;
}

// The customer's choice was undone, or the request is being deleted. An unpaid invoice is cancelled
// and can't be reopened. A paid one stays as it is: the money was received, so the owner decides.
async function release(pool, requestId, reason) {
  // The quote's own flags start clean again, in case the customer chooses the same company later.
  await pool.query(
    `update quotes set fee_paid = false, fee_waived = false
      where id in (select quote_id from invoices where request_id = $1 and current and paid_at is null and quote_id is not null)`,
    [requestId]
  );
  await pool.query(
    `update invoices
        set current = false,
            void_reason = case when voided_at is null then $2 else void_reason end,
            voided_at = coalesce(voided_at, now()),
            pending_since = null
      where request_id = $1 and current and paid_at is null`,
    [requestId, reason]
  );
}

// The owner copied, texted, or emailed the invoice from the Fees page.
async function recordSend(pool, invoiceId, how) {
  if (!SEND_EVENTS.includes(how)) return;
  await pool.query("update invoices set sends = sends + 1, last_send = $2, last_sent_at = now() where id = $1", [Number(invoiceId) || 0, how]);
}

// The company opened its invoice. Reloads within two minutes count once, and link previews never count.
async function recordOpen(pool, req, invoice) {
  if (!isPersonOpening(req)) return;
  try {
    await pool.query(
      `update invoices set opens = opens + 1, last_opened_at = now()
        where id = $1 and (last_opened_at is null or last_opened_at < now() - interval '2 minutes')`,
      [invoice.id]
    );
  } catch (error) {
    console.error("Could not record an invoice being opened:", error.message);
  }
}

// How a payment is described to the company that made it: "by card". Empty when there is nothing useful to say.
const PAID_WORDS = {
  Zelle: "by Zelle", Check: "by check", Cash: "in cash", "Card through Stripe": "by card", "Bank through Stripe": "by bank payment"
};
const paidWords = (invoice) => PAID_WORDS[invoice.paid_how] || "";

// The same, for the owner's own pages.
const OWNER_PAID_WORDS = {
  ...PAID_WORDS, "Payment link": "through your payment link", "Card through Stripe": "by card through Stripe",
  "Bank through Stripe": "by bank through Stripe", Stripe: "through Stripe"
};
const ownerPaidWords = (invoice) => OWNER_PAID_WORDS[invoice.paid_how] || "";

// The words the owner sends with an invoice's link.
function billWords(invoice, dueText) {
  return "AT Legacy Services: invoice " + invoiceRef(invoice) + " for job " + invoice.job_ref + " (" + invoice.service + ") is " +
    money(invoice.amount_cents) + (dueText ? ", due by " + dueText : "") + ". See it and pay here:";
}

function reminderWords(invoice, dueText) {
  return "AT Legacy Services: a reminder that invoice " + invoiceRef(invoice) + " for job " + invoice.job_ref + " (" + invoice.service + "), " +
    money(invoice.amount_cents) + ", was due " + dueText + ". See it and pay here:";
}

function receiptWords(invoice) {
  return "AT Legacy Services: we received " + money(invoice.amount_cents) + " for invoice " + invoiceRef(invoice) + ". Thank you. Your receipt:";
}

// The books. `period` is "" for everything, a year such as 2026, or a month such as 2026-11.
// Money counts in the period it moved: a payment on the day it was paid, a refund on the day it went back.
function booksFor(invoices, period = "", now = new Date()) {
  const within = (value) => Boolean(value) && dayOf(value).startsWith(period);
  const issued = invoices.filter((invoice) => within(invoice.issued_at));
  const moves = [];
  for (const invoice of invoices) {
    if (invoice.paid_at && within(invoice.paid_at)) {
      const fee = invoice.processor_fee_cents === null || invoice.processor_fee_cents === undefined ? null : Number(invoice.processor_fee_cents);
      moves.push({ invoice, on: invoice.paid_at, kind: "Payment", amount: Number(invoice.amount_cents), fee, net: fee === null ? null : Number(invoice.amount_cents) - fee });
    }
    if (invoice.paid_at && invoice.refunded_at && Number(invoice.refunded_cents) > 0 && within(invoice.refunded_at)) {
      moves.push({ invoice, on: invoice.refunded_at, kind: "Refund", amount: -Number(invoice.refunded_cents), fee: 0, net: -Number(invoice.refunded_cents) });
    }
  }
  moves.sort((a, b) => new Date(a.on) - new Date(b.on) || a.invoice.number - b.invoice.number);
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  const payments = moves.filter((move) => move.kind === "Payment");
  const refunds = moves.filter((move) => move.kind === "Refund");
  const open = invoices.filter((invoice) => statusOf(invoice, now).key === "open");
  const totals = {
    billed: sum(issued, (invoice) => Number(invoice.amount_cents)),
    cancelled: sum(issued.filter((invoice) => statusOf(invoice, now).key === "void"), (invoice) => Number(invoice.amount_cents)),
    collected: sum(payments, (move) => move.amount),
    refunded: -sum(refunds, (move) => move.amount),
    fees: sum(payments, (move) => move.fee || 0),
    // A payment whose processing fee isn't known yet makes the net figure a ceiling, not an exact number.
    feesUnknown: payments.filter((move) => move.fee === null).length,
    owedNow: sum(open, (invoice) => Number(invoice.amount_cents)),
    overdueNow: sum(open.filter((invoice) => statusOf(invoice, now).overdue), (invoice) => Number(invoice.amount_cents))
  };
  totals.net = totals.collected - totals.refunded - totals.fees;
  return { period, issued, moves, totals };
}

// Every month in which an invoice was issued, paid, or refunded, newest first: ["2026-11", "2026-10"]
function monthsOf(invoices) {
  const months = new Set();
  for (const invoice of invoices) {
    for (const value of [invoice.issued_at, invoice.paid_at, invoice.refunded_at]) if (value) months.add(dayOf(value).slice(0, 7));
  }
  return [...months].sort().reverse();
}

// "2026-11" -> "November 2026", "2026" -> "2026", "" -> "All time"
function periodName(period) {
  if (!period) return "All time";
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const validPeriod = (text) => (/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(String(text || "")) ? String(text) : "");

module.exports = {
  PAID_HOW, WAIVED, UNDONE, DELETED, invoiceRef, money, dayOf, statusOf, working, issueMissing, loadInvoices, loadInvoice, loadByToken,
  invoiceForQuote, settle, markPaid, syncQuote, release, recordSend, recordOpen, paidWords, ownerPaidWords, billWords, reminderWords, receiptWords,
  booksFor, monthsOf, periodName, validPeriod
};
