// Private links: their readable names, and the record of when each was sent and opened.
//
// A customer's link is /r/<secret>/<name>. A company's is /q/<secret>/<name>.
// The secret is what opens the page. The name on the end is for people: it carries the
// request's reference and who the link is for, so a wrong link is easy to spot before
// it is sent. The pages also work without the name, so older links keep working.

const SEND_EVENTS = ["copied", "texted", "emailed", "shared"];

function slug(text, max) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

// The number people quote on the phone: R1003.
function requestRef(id) {
  return "R" + (1000 + Number(id));
}

function customerPath(request) {
  const first = slug(String(request.name || "").trim().split(/\s+/)[0], 20) || "customer";
  return "/r/" + request.token + "/" + requestRef(request.id).toLowerCase() + "-" + first;
}

// Never carries the customer's name: a company must not learn who the customer is from its link.
function companyPath({ token, requestId, tier, company }) {
  const who = [slug(tier, 12), slug(company, 30)].filter(Boolean).join("-") || "company";
  return "/q/" + token + "/" + requestRef(requestId).toLowerCase() + "-" + who;
}

// Message apps and search engines fetch a link to draw a preview of it. That is not a person opening the page.
const PREVIEWERS = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|discord|skype|embedly|pagerenderer|curl|wget|python|okhttp|headless/i;

// ?owner=1 is added to the links the dashboard opens, so the owner's own look isn't counted.
function isOwnerPreview(req) {
  return req.query.owner === "1";
}

function isPersonOpening(req) {
  const agent = req.get("user-agent") || "";
  return req.method === "GET" && !isOwnerPreview(req) && agent !== "" && !PREVIEWERS.test(agent);
}

// Reloads within two minutes count once. A failure here must never break the page.
async function recordOpen(pool, req, { requestId, quoteId = null }) {
  if (!isPersonOpening(req)) return;
  try {
    await pool.query(
      `insert into link_events (request_id, quote_id, event)
       select $1::int, $2::int, 'opened'
        where not exists (
          select 1 from link_events
           where request_id = $1::int and quote_id is not distinct from $2::int
             and event = 'opened' and created_at > now() - interval '2 minutes')`,
      [requestId, quoteId]
    );
  } catch (error) {
    console.error("Could not record a link being opened:", error.message);
  }
}

// For each link of these requests: how it was last sent, how many times it was opened, and when.
// Returns a lookup: activity.customer(requestId) and activity.company(quoteId).
async function loadActivity(pool, requestIds) {
  const rows = requestIds.length ? (await pool.query(
    `select request_id, quote_id,
            count(*) filter (where event = 'opened')::int as opens,
            max(created_at) filter (where event = 'opened') as last_opened,
            (array_agg(event order by created_at desc) filter (where event <> 'opened'))[1] as last_send,
            max(created_at) filter (where event <> 'opened') as last_sent_at
       from link_events
      where request_id = any($1::int[])
      group by request_id, quote_id`,
    [requestIds]
  )).rows : [];
  const none = { opens: 0, last_opened: null, last_send: null, last_sent_at: null };
  return {
    customer: (requestId) => rows.find((row) => row.request_id === requestId && row.quote_id === null) || none,
    company: (quoteId) => rows.find((row) => row.quote_id === quoteId) || none
  };
}

module.exports = { SEND_EVENTS, slug, requestRef, customerPath, companyPath, isOwnerPreview, recordOpen, loadActivity };
