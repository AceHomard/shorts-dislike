// bridge.js — runs in the MAIN (page) world.
// It has access to YouTube's `window.ytcfg` and to same-origin cookies, so it can
// replay the exact InnerTube request the real dislike button makes.
//
// It listens for "sd-dislike-request" from content.js, performs the call, and
// replies with "sd-dislike-response".
//
// The endpoint and payload mirror what YouTube's own web client sends:
//   POST https://www.youtube.com/youtubei/v1/like/dislike?prettyPrint=false
//   body: { context: <INNERTUBE_CONTEXT>, target: { videoId } }
// Authenticated mutations also need a SAPISIDHASH Authorization header, computed
// from the SAPISID cookie. We build it below.

(() => {
  const ORIGIN = "https://www.youtube.com";

  function getCookie(name) {
    const hit = document.cookie
      .split("; ")
      .find((c) => c.startsWith(name + "="));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }

  async function sha1hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Authorization: SAPISIDHASH <ts>_<sha1(ts SPACE sapisid SPACE origin)>
  async function authHeader() {
    const sapisid =
      getCookie("SAPISID") ||
      getCookie("__Secure-3PAPISID") ||
      getCookie("__Secure-1PAPISID");
    if (!sapisid) return null; // not logged in, or cookie not readable here
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1hex(`${ts} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  function innertube() {
    // ytcfg is YouTube's global config object in the page context.
    const cfg = window.ytcfg;
    if (!cfg || typeof cfg.get !== "function") return null;
    return {
      context: cfg.get("INNERTUBE_CONTEXT"),
      apiKey: cfg.get("INNERTUBE_API_KEY"),
      clientVersion: cfg.get("INNERTUBE_CLIENT_VERSION"),
    };
  }

  async function dislike(videoId, action) {
    const it = innertube();
    if (!it || !it.context) throw new Error("ytcfg / INNERTUBE_CONTEXT unavailable");

    // action: "DISLIKE" to dislike, "INDIFFERENT" to remove an existing dislike.
    const path = action === "INDIFFERENT" ? "like/removelike" : "like/dislike";

    const headers = {
      "Content-Type": "application/json",
      "X-Goog-AuthUser": "0",
      "X-Origin": ORIGIN,
    };
    if (it.clientVersion) headers["X-Youtube-Client-Version"] = it.clientVersion;
    const auth = await authHeader();
    if (auth) headers["Authorization"] = auth;

    const res = await fetch(`${ORIGIN}/youtubei/v1/${path}?prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: it.context, target: { videoId } }),
    });

    return { status: res.status, ok: res.ok };
  }

  document.addEventListener("sd-dislike-request", async (ev) => {
    const { nonce, videoId, action } = ev.detail || {};
    const reply = (detail) =>
      document.dispatchEvent(
        new CustomEvent("sd-dislike-response", { detail: { nonce, ...detail } })
      );
    try {
      const r = await dislike(videoId, action);
      reply({ ok: r.ok, status: r.status, error: r.ok ? null : "HTTP " + r.status });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
})();
