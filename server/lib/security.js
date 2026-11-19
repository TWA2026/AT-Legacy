const crypto = require("node:crypto");

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function sign(secret, text) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Admin sessions are a signed expiry time in a cookie. Nothing is stored server-side.
const SESSION_COOKIE = "atl_admin";
const SESSION_HOURS = 12;

function createSession(secret) {
  const expires = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return expires + "." + sign(secret, "session:" + expires);
}

function readSession(secret, cookieHeader) {
  const match = /(?:^|;\s*)atl_admin=([^;]+)/.exec(cookieHeader || "");
  if (!match) return null;
  const [expires, signature] = match[1].split(".");
  if (!expires || !signature) return null;
  if (!safeEqual(signature, sign(secret, "session:" + expires))) return null;
  if (Number(expires) < Date.now()) return null;
  return { id: expires };
}

function csrfToken(secret, session) {
  return sign(secret, "csrf:" + session.id);
}

function sessionCookie(value, secure) {
  const parts = [
    SESSION_COOKIE + "=" + value,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + (value ? SESSION_HOURS * 3600 : 0)
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// A small in-memory limiter. One server process handles all traffic, so this is enough.
function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [other, times] of hits) {
        if (!times.some((time) => now - time < windowMs)) hits.delete(other);
      }
    }
    return true;
  };
}

module.exports = {
  newToken, sign, safeEqual, createSession, readSession, csrfToken, sessionCookie, rateLimiter
};
