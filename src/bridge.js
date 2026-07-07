// bridge.js runs in the MAIN (page) world.
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
  // its own dislike request, the "one click, N calls" bug). Only the first wins.
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

  // Shared headers for any authenticated InnerTube mutation/query.
  async function buildHeaders(it) {
    const headers = {
      "Content-Type": "application/json",
      "X-Goog-AuthUser": "0",
      "X-Origin": ORIGIN,
    };
    if (it.clientVersion) headers["X-Youtube-Client-Version"] = it.clientVersion;
    const auth = await authHeader();
    if (auth) headers["Authorization"] = auth;
    return headers;
  }

  async function dislike(videoId, action) {
    const it = innertube();
    if (!it || !it.context) throw new Error("ytcfg / INNERTUBE_CONTEXT unavailable");

    // action: "DISLIKE" to dislike, "INDIFFERENT" to remove an existing dislike.
    const path = action === "INDIFFERENT" ? "like/removelike" : "like/dislike";
    const headers = await buildHeaders(it);

    const res = await fetch(`${ORIGIN}/youtubei/v1/${path}?prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: it.context, target: { videoId } }),
    });
    return { status: res.status, ok: res.ok };
  }

  const LIKE_STATES = new Set(["LIKE", "DISLIKE", "INDIFFERENT"]);

  // Walk the `next` payload for the video's real like state. YouTube nests this
  // under ever-changing view-model wrappers (likeStatusEntity,
  // segmentedLikeDislikeButtonViewModel, ...), so we search for the first
  // `likeStatus` string with an expected enum value rather than hard-code a path.
  // FRAGILE: comments also carry likeStatus; the reel's own toggle appears first
  // in the payload, but a YouTube reshuffle could break this. Fails soft (null).
  function findLikeStatus(root) {
    let found = null;
    (function walk(o) {
      if (found || !o || typeof o !== "object") return;
      for (const k in o) {
        const v = o[k];
        if (k === "likeStatus" && typeof v === "string" && LIKE_STATES.has(v)) {
          found = v;
          return;
        }
        if (v && typeof v === "object") {
          walk(v);
          if (found) return;
        }
      }
    })(root);
    return found;
  }

  // Read YouTube's server-side like state for a video (M2 reconciliation). The
  // dislike endpoint only tells us the request was accepted; `next` tells us what
  // YouTube actually persisted (and reflects dislikes made elsewhere, e.g. /watch).
  async function getStatus(videoId) {
    const it = innertube();
    if (!it || !it.context) throw new Error("ytcfg / INNERTUBE_CONTEXT unavailable");
    const headers = await buildHeaders(it);

    const res = await fetch(`${ORIGIN}/youtubei/v1/next?prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: it.context, videoId }),
    });
    if (!res.ok) return { status: res.status, ok: false, likeStatus: null };
    const json = await res.json();
    return { status: res.status, ok: true, likeStatus: findLikeStatus(json) };
  }

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.tag !== MSG || d.dir !== "request") return;

    const reply = (extra) =>
      window.postMessage({ tag: MSG, dir: "response", nonce: d.nonce, ...extra }, ORIGIN);
    try {
      if (d.kind === "status") {
        const r = await getStatus(d.videoId);
        reply({ ok: r.ok, status: r.status, likeStatus: r.likeStatus, error: r.ok ? null : "HTTP " + r.status });
      } else {
        const r = await dislike(d.videoId, d.action);
        reply({ ok: r.ok, status: r.status, error: r.ok ? null : "HTTP " + r.status });
      }
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
})();
