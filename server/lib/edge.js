// Sign-in by the host's wall.
//
// The dashboard can run as its own service with the host's sign-in wall in front of it
// (on Slipway: the service's Auth setting, "members"). The wall stops every outside
// request until the visitor has signed in, so the app has no login page of its own.
//
// That is only safe while the wall is really there. Before letting anyone in, the app
// asks for its own public address the way a stranger would. If that request reaches
// this app, the wall is off and the dashboard stays locked.

const MARKER_HEADER = "x-atl-dashboard";
const MARKER = "reachable";

// What a sign-in wall answers to a stranger: "not signed in" or a redirect to its login page.
const WALL_STATUSES = new Set([401, 302, 303, 307]);
const TRUST_MS = 60 * 1000;

function createEdgeGuard({ url, fetchImpl, now = Date.now }) {
  let confirmedAt = 0;
  let pending = null;

  async function probe() {
    try {
      const response = await fetchImpl(url + "/admin/edge-check", {
        redirect: "manual",
        headers: { accept: "text/plain" },
        signal: AbortSignal.timeout(5000)
      });
      return WALL_STATUSES.has(response.status) && response.headers.get(MARKER_HEADER) !== MARKER;
    } catch (error) {
      return false;
    }
  }

  // fresh: check now, don't rely on a recent answer. Used for visitors without a session.
  return async function wallIsUp({ fresh = false } = {}) {
    if (!fresh && now() - confirmedAt < TRUST_MS) return true;
    if (!pending) {
      pending = probe().then((up) => {
        confirmedAt = up ? now() : 0;
        pending = null;
        return up;
      });
    }
    return pending;
  };
}

module.exports = { createEdgeGuard, MARKER_HEADER, MARKER };
