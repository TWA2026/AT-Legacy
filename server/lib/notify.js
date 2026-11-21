// Optional email, sent through Resend.
//
//   notify(subject, body)          to the owner: a new request, a quote, a message, a rating, and so on
//   notify.send(to, subject, body) to someone else: the customer's copy of their private link
//
// Does nothing unless RESEND_API_KEY and NOTIFY_FROM are set. Mail to the owner also needs NOTIFY_TO.
// A failure is logged and never stops what the visitor was doing.

function createNotifier({ apiKey, from, to, fetchImpl }) {
  async function send(address, subject, body) {
    if (!apiKey || !from || !address) return false;
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({ from, to: [address], subject, text: body })
      });
      if (!response.ok) console.error("Notification email was rejected with status", response.status);
      return response.ok;
    } catch (error) {
      console.error("Notification email failed:", error.message);
      return false;
    }
  }
  const notify = (subject, body) => send(to, subject, body);
  notify.send = send;
  return notify;
}

module.exports = { createNotifier };
