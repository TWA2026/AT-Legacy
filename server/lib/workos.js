// Dashboard sign-in through WorkOS AuthKit's hosted login page.
// WorkOS handles passwords, email verification, and two-factor codes.
// This app only checks that the signed-in email is on the owner's list.

const AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";
const AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";
const TIMEOUT_MS = 10000;

function authorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    provider: "authkit",
    state
  });
  return AUTHORIZE_URL + "?" + params.toString();
}

// Trades the one-time code from the login redirect for the signed-in user.
// Returns { email, emailVerified } or null if WorkOS rejects the code.
async function exchangeCode({ apiKey, clientId, code, ip, userAgent, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(AUTHENTICATE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: apiKey,
        grant_type: "authorization_code",
        code,
        ip_address: ip,
        user_agent: userAgent
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || !data.user || typeof data.user.email !== "string") return null;
    return { email: data.user.email.trim().toLowerCase(), emailVerified: data.user.email_verified === true };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { authorizationUrl, exchangeCode };
