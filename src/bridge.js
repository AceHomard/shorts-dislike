// bridge.js — runs in the MAIN (page) world.
// It has access to YouTube's `window.ytcfg` and to same-origin cookies, so it can
// replay the exact InnerTube request the real dislike button makes.
//
// It listens for a postMessage from content.js, performs the call, and posts the
// result back. (postMessage, not CustomEvent: Firefox blocks cross-world access
// to CustomEvent detail objects.)
//
// The endpoint and payload mirror YouTube's own web client:
//   POST https://www.youtube.com/youtubei/v1/like/dislike?prettyPrint=false
//   body: { context: <INNERTUBE_CONTEXT>, target: { videoId } }
// Authenticated mutations also need a SAPISIDHASH Authorization header, computed
// from the SAPISID cookie.

(() => {
  // Idempotency guard. MAIN-world scripts live in the page and are NOT torn down
  // when the extension reloads, so multiple copies can pile up (each would fire
  // its own dislike request — the "one click, N calls" bug). Only the first wins.
  if (window.__sdBridgeReady) return;
  window.__sdBridgeReady = true;

  const ORIGIN = "https://www.youtube.com";
  const MSG = "sd:v1";

  function getCookie(name) {
    const hit = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }

  async function sha1hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    const cfg = window.ytcfg;
    if (!cfg || typeof cfg.get !== "function") return null;
    return {
      context: cfg.get("INNERTUBE_CONTEXT"),
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

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.tag !== MSG || d.dir !== "request") return;

    const reply = (extra) =>
      window.postMessage({ tag: MSG, dir: "response", nonce: d.nonce, ...extra }, ORIGIN);
    try {
      const r = await dislike(d.videoId, d.action);
      reply({ ok: r.ok, status: r.status, error: r.ok ? null : "HTTP " + r.status });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
})();
