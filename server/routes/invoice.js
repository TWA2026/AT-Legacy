// A company's invoice for a finder's fee: /q/invoice/<secret>
//
// The page is the invoice while the fee is owed and the receipt once it is paid. From it the company
// pays the exact amount on Stripe's page when Stripe is connected, or through the owner's payment
// link when it isn't. The secret in the address is what opens it, as with the quote page.

const express = require("express");
const { esc, invoicePage, formatDate } = require("../lib/html");
const { isOwnerPreview } = require("../lib/links");
const { loadFee, payUrl } = require("../lib/fees");
const { rateLimiter } = require("../lib/security");
const { invoiceRef, money, statusOf, working, paidWords, loadByToken, recordOpen } = require("../lib/invoices");

const OWNER_NOTE = '<p class="owner-preview"><strong>Owner preview.</strong> This is the company&rsquo;s invoice, as they see it. Your visit isn&rsquo;t counted as them opening it.</p>';

// `online` says how this invoice can be paid from the page: "stripe", "link", or "".
function render(invoice, { online, payLink = "", ownerPreview = false, trouble = false }) {
  const ref = invoiceRef(invoice);
  const status = statusOf(invoice);
  const amount = money(invoice.amount_cents);
  const due = formatDate(invoice.due_at);
  const paid = status.key === "paid";
  let banner;
  let action = "";

  if (paid) {
    banner = `<p class="invoice-status is-paid">Paid ${esc(formatDate(invoice.paid_at))}. Thank you.</p>`;
    action = `<p class="invoice-small">This page is your receipt. Keep its link, or print it for your records.${status.partRefunded ? " " + esc(money(status.partRefunded)) + " of this payment was refunded." : ""}</p>`;
  } else if (status.key === "refunded") {
    banner = `<p class="invoice-status is-closed">Refunded ${esc(formatDate(invoice.refunded_at))}. Nothing is owed.</p>`;
    action = `<p class="invoice-small">This invoice was paid on ${esc(formatDate(invoice.paid_at))} and the payment was returned.</p>`;
  } else if (status.key === "void") {
    banner = '<p class="invoice-status is-closed">No fee is owed on this invoice.</p>';
    action = `<p class="invoice-small">It was cancelled on ${esc(formatDate(invoice.voided_at))}. You don&rsquo;t need to do anything.</p>`;
  } else {
    banner = status.overdue
      ? `<p class="invoice-status is-late">Overdue. It was due ${esc(due)}.</p>`
      : `<p class="invoice-status">Due by ${esc(due)}.</p>`;
    if (status.pending) {
      action = `<p class="invoice-note">A bank payment was started on ${esc(formatDate(invoice.pending_since))}. Bank payments take a few business days. This invoice marks itself paid when the money arrives, so there is nothing more to do.</p>`;
    } else {
      const note = invoice.payment_note ? `<p class="invoice-note">${esc(invoice.payment_note)} You can pay again below.</p>` : "";
      const broken = trouble ? '<p class="invoice-note">Online payment isn&rsquo;t working right now. <a class="plain-link" href="/contact">Send us a message</a> and we&rsquo;ll sort it out.</p>' : "";
      if (online === "stripe") {
        action = `${note}${broken}<p class="invoice-pay"><a class="primary" href="/q/invoice/${esc(invoice.token)}/pay" rel="nofollow">Pay ${esc(amount)}</a></p>
      <p class="invoice-small invoice-pay-note">You pay on Stripe&rsquo;s secure page. We never see your card or bank details.</p>`;
      } else if (online === "link") {
        action = `${note}<p class="invoice-pay"><a class="primary" href="${esc(payUrl(payLink, ref))}" rel="noopener">Pay online</a></p>
      <p class="invoice-small invoice-pay-note">Enter ${esc(amount)} as the amount, and ${esc(ref)} if the page asks what it is for.</p>`;
      } else {
        action = `${note}<p class="invoice-small">We&rsquo;ll send you the payment details with this invoice. If you don&rsquo;t have them, <a class="plain-link" href="/contact">send us a message</a>.</p>`;
      }
    }
  }

  const owed = status.key === "open";
  // Why the fee exists, and the one promise that goes with it. Worded for where the invoice stands.
  const tell = '<a class="plain-link" href="/contact">tell us</a>';
  const why = owed
    ? `This fee is owed because a customer chose ${esc(invoice.company)} for this job through AT Legacy Services. If the job falls through before any work starts, ${tell} and no fee is owed.`
    : paid
      ? `This fee was for a job a customer gave ${esc(invoice.company)} through AT Legacy Services. If that job falls through before any work starts, ${tell} and the fee is returned.`
      : `This invoice was for a job a customer gave ${esc(invoice.company)} through AT Legacy Services. A question about it? <a class="plain-link" href="/contact">Send us a message</a>.`;
  const body = `    ${banner}
    <dl class="invoice-facts">
      <div><dt>Billed to</dt><dd>${esc(invoice.company)}</dd></div>
      <div><dt>From</dt><dd>AT Legacy Services<span>AT Legacy Group LLC<br>Land O&rsquo; Lakes, Florida</span></dd></div>
      <div><dt>Invoice date</dt><dd>${esc(formatDate(invoice.issued_at))}</dd></div>
      <div><dt>${paid ? "Paid" : "Due"}</dt><dd>${esc(paid ? formatDate(invoice.paid_at) + (paidWords(invoice) ? ", " + paidWords(invoice) : "") : due)}</dd></div>
      <div><dt>Job</dt><dd>${esc(invoice.job_ref)}, ${esc(invoice.service)}</dd></div>
    </dl>
    <table class="invoice-lines">
      <thead><tr><th scope="col">Description</th><th scope="col" class="num">Amount</th></tr></thead>
      <tbody>
        <tr><td>Finder&rsquo;s fee for job ${esc(invoice.job_ref)}<span>${esc(working(invoice))}.</span></td><td class="num">${esc(amount)}</td></tr>
      </tbody>
      <tfoot><tr><th scope="row">${paid ? "Total paid" : owed ? "Total due" : "Total"}</th><td class="num">${esc(amount)}</td></tr></tfoot>
    </table>
    <div class="invoice-next">
      ${action}
    </div>
    <p class="invoice-small invoice-why">${why}</p>`;
  return invoicePage({
    title: (paid ? "Receipt " : "Invoice ") + ref,
    heading: paid ? "Receipt" : "Invoice",
    number: ref,
    notice: ownerPreview ? OWNER_NOTE : "",
    body
  });
}

module.exports = function invoiceRoutes({ pool, config, payments }) {
  const router = express.Router();
  const payLimit = rateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });

  // How this site lets a company pay: Stripe's page for the exact amount, the owner's payment link, or neither.
  async function payingBy() {
    if (payments.ready()) return { online: "stripe", payLink: "" };
    const fee = await loadFee(pool, config);
    return fee.payLink ? { online: "link", payLink: fee.payLink } : { online: "", payLink: "" };
  }

  router.get("/:token", async (req, res, next) => {
    try {
      let invoice = await loadByToken(pool, req.params.token);
      if (!invoice) return next();
      // Back from Stripe, or looking again: ask Stripe how the payment page ended before drawing the page.
      if (invoice.stripe_session_id && !invoice.paid_at && payments.ready()) {
        await payments.syncInvoice(invoice);
        invoice = await loadByToken(pool, req.params.token);
      }
      if (!isOwnerPreview(req)) await recordOpen(pool, req, invoice);
      res.send(render(invoice, { ...(await payingBy()), ownerPreview: isOwnerPreview(req), trouble: req.query.pay === "off" }));
    } catch (error) {
      next(error);
    }
  });

  // Sends the company to Stripe's page for this invoice. A link, not a form, so the page's own rules
  // about where forms may go stay as strict as they are.
  router.get("/:token/pay", async (req, res, next) => {
    try {
      let invoice = await loadByToken(pool, req.params.token);
      if (!invoice) return next();
      const page = "/q/invoice/" + invoice.token;
      if (!payments.ready()) {
        const { payLink } = await payingBy();
        return res.redirect(303, payLink && statusOf(invoice).key === "open" ? payUrl(payLink, invoiceRef(invoice)) : page);
      }
      if (invoice.stripe_session_id && !invoice.paid_at) {
        await payments.syncInvoice(invoice);
        invoice = await loadByToken(pool, req.params.token);
      }
      const status = statusOf(invoice);
      if (status.key !== "open" || status.pending) return res.redirect(303, page);
      if (!payLimit(req.ip)) return res.redirect(303, page + "?pay=off");
      try {
        // The way back from Stripe uses the site's own address when it is set, never one a visitor could make up.
        res.redirect(303, await payments.startCheckout(invoice, config.publicUrl || (req.protocol + "://" + req.get("host"))));
      } catch (problem) {
        console.error("Stripe: could not open a payment page for " + invoiceRef(invoice) + ":", problem.message);
        res.redirect(303, page + "?pay=off");
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
};

module.exports.render = render;
