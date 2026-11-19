// Optional email to the owner when a request or application arrives.
// Does nothing unless RESEND_API_KEY, NOTIFY_FROM, and NOTIFY_TO are all set.

function createNotifier({ apiKey, from, to, fetchImpl }) {
  const enabled = Boolean(apiKey && from && to);
  return async function notify(subject, body) {
    if (!enabled) return false;
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({ from, to: [to], subject, text: body })
      });
      if (!response.ok) console.error("Notification email was rejected with status", response.status);
      return response.ok;
    } catch (error) {
      console.error("Notification email failed:", error.message);
      return false;
    }
  };
}

module.exports = { createNotifier };
