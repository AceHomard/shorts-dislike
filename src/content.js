// content.js runs in the ISOLATED world.
// Job: detect the active Short, inject a dislike button next to the like button,
// ask the page-context bridge (bridge.js) to perform the actual dislike call, and
// remember which Shorts were disliked so the button state persists across visits.
//
// Why two scripts? The dislike request needs YouTube's internal `ytcfg` data and
// same-origin auth, which only exist in the PAGE context (MAIN world). Content
// scripts run isolated and can't read `window.ytcfg`. So content.js owns the UI +
// persistence and bridge.js (MAIN world) owns the network call.
//
// They communicate via window.postMessage. (Not CustomEvent: Firefox blocks
// cross-world access to a CustomEvent's `detail` object.)

const BTN_CLASS = "sd-dislike-btn";
const MSG = "sd:v1"; // tag so we ignore unrelated postMessages on the page
const STATE = { pending: false }; // true while a dislike call is in flight

// storage.local, promise-based, works the same in Chrome and Firefox (MV3).
const store = (globalThis.browser || globalThis.chrome).storage.local;

// Source of truth for the active state: the set of videoIds the user disliked
// through this extension. Kept in memory for synchronous reads (inject() runs a
// lot), mirrored to storage so it survives navigations and browser restarts.
const disliked = new Set();

// videoIds whose real server likeStatus we've already fetched this session, and
// those with a status fetch in flight. Keeps reconciliation to one request per
// Short even though inject() runs on every DOM mutation frame.
const reconciled = new Set();
const statusPending = new Set();

function persist() {
  const obj = {};
  disliked.forEach((id) => (obj[id] = 1));
  store.set({ disliked: obj });
}

// --- helpers ---------------------------------------------------------------

// Read the videoId of the Short currently in view. YouTube updates the URL as you
// scroll, so reading it at click-time always matches the visible Short.
function currentShortId() {
  const m = location.pathname.match(/^\/shorts\/([\w-]{5,})/);
  return m ? m[1] : null;
}

function isActiveNow() {
  const id = currentShortId();
  return !!id && disliked.has(id);
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
}

// Find the like button of the Short currently on screen.
// NOTE: these selectors are the most fragile part of the extension YouTube
// changes its DOM often and rolls updates out unevenly. If injection stops
// working, this is the function to fix: inspect the thumbs-up in DevTools and
// update the selectors below.
function findLikeButton() {
  const candidates = [
    "ytd-reel-video-renderer #like-button",
    "ytd-reel-video-renderer like-button-view-model",
    "#like-button button",
    'button[aria-label*="like" i]',
  ];
  for (const sel of candidates) {
    const els = [...document.querySelectorAll(sel)].filter(isVisible);
    if (els.length) return els[0];
  }
  return null;
}

// --- UI --------------------------------------------------------------------

// YouTube's own current dislike icon.
//  - inactive: the "ytSpec" outlined thumb-down (from the real /watch button, so
//    ours looks identical).
//  - active: a solid thumb-down, filled with the button's text color (white in
//    dark mode, dark in light mode) no coloured background.
const ICON_OUTLINE =
  "m11.31 2 .392.007c1.824.06 3.61.534 5.223 1.388l.343.189.27.154c.264.152.56.24.863.26l.13.004H20.5a1.5 1.5 0 011.5 1.5V11.5a1.5 1.5 0 01-1.5 1.5h-1.79l-.158.013a1 1 0 00-.723.512l-.064.145-2.987 8.535a1 1 0 01-1.109.656l-1.04-.174a4 4 0 01-3.251-4.783L10 15H5.938a3.664 3.664 0 01-3.576-2.868A3.682 3.682 0 013 9.15l-.02-.088A3.816 3.816 0 014 5.5v-.043l.008-.227a2.86 2.86 0 01.136-.664l.107-.28A3.754 3.754 0 017.705 2h3.605ZM7.705 4c-.755 0-1.425.483-1.663 1.2l-.032.126a.818.818 0 00-.01.131v.872l-.587.586a1.816 1.816 0 00-.524 1.465l.038.23.02.087.21.9-.55.744a1.686 1.686 0 00-.321 1.18l.029.177c.17.76.844 1.302 1.623 1.302H10a2.002 2.002 0 011.956 2.419l-.623 2.904-.034.208a2.002 2.002 0 001.454 2.139l.206.045.21.035 2.708-7.741A3.001 3.001 0 0118.71 11H20V6.002h-1.47c-.696 0-1.38-.183-1.985-.528l-.27-.155-.285-.157A10.002 10.002 0 0011.31 4H7.705Z";
// YouTube's real filled dislike icon (captured from the active /watch button).
const ICON_SOLID =
  "M11.313 2.002c2.088 0 4.14.546 5.953 1.583l.273.156a2 2 0 00.993.264H21a1 1 0 011 1V11a1 1 0 01-1.002 1l-2.787-.005a1 1 0 00-.946.67l-3.02 8.628a.815.815 0 01-.966.522 3.262 3.262 0 01-2.35-4.062l.707-2.477a1 1 0 00-.961-1.274h-5.29a2.24 2.24 0 01-2.004-1.238l-.18-.359a1.784 1.784 0 01.601-2.278.446.446 0 00.198-.37v-.07a.578.578 0 00-.116-.347 2.374 2.374 0 01.412-3.278l.498-.399a.379.379 0 00.123-.415l-.07-.207a2.1 2.1 0 01.313-1.923A2.798 2.798 0 017.4 2l3.913.002Z";

const SVG_NS = "http://www.w3.org/2000/svg";

// Build the icon as real DOM nodes rather than an innerHTML string. The markup is
// entirely static (the two paths are our own constants, never user input), so a
// string would be safe, but AMO flags any innerHTML assignment. createElementNS
// sidesteps the warning and is just as cheap here.
function iconEl(filled) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", filled ? ICON_SOLID : ICON_OUTLINE);
  svg.appendChild(path);
  return svg;
}

function buildButton() {
  const btn = document.createElement("button");
  btn.className = BTN_CLASS;
  btn.type = "button";
  btn.title = "Dislike this Short";
  btn.setAttribute("aria-label", "Dislike");
  btn.setAttribute("aria-pressed", "false");
  btn.appendChild(iconEl(false));
  btn.addEventListener("click", onDislikeClick);
  return btn;
}

// Sync the button's look to the current Short's disliked state.
// IMPORTANT: this runs on every MutationObserver frame (inject() is called a lot).
// It must be a no-op when nothing changed. Rebuilding the icon unconditionally
// swaps the <svg> out from under the pointer mid-click, so a mousedown landing on
// the icon never becomes a click (the symptom: "clicking sometimes does nothing").
// The `sd-active` class is our record of the painted state; bail if it matches.
function reflectState() {
  const btn = document.querySelector("." + BTN_CLASS);
  if (!btn) return;
  const active = isActiveNow();
  if (btn.classList.contains("sd-active") === active) return;
  btn.classList.toggle("sd-active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.replaceChildren(iconEl(active));
}

// Brief, self-clearing shake + red tint on the button when a dislike click was
// rejected (401/403/network). The only user-facing failure signal in the
// extension: the other failure modes (no like button found, likeStatus unknown)
// need none. Reuses the existing button, adds no DOM, and reverts on its own.
function signalError() {
  const btn = document.querySelector("." + BTN_CLASS);
  if (!btn) return;
  btn.classList.remove("sd-error"); // restart the animation if one is mid-flight
  void btn.offsetWidth; // force reflow so re-adding the class replays it
  btn.classList.add("sd-error");
  btn.addEventListener("animationend", () => btn.classList.remove("sd-error"), {
    once: true,
  });
}

// Keep exactly one button present next to the visible like button.
function inject() {
  // Only Shorts get the button. On /watch (and everywhere else) YouTube already
  // has its own dislike button, and our fallback selectors could otherwise latch
  // onto a comment's like button. Bail early and clean up any stray button.
  if (!currentShortId()) {
    document.querySelectorAll("." + BTN_CLASS).forEach((b) => b.remove());
    return;
  }

  // M2: once per visible Short, ask YouTube for the real like state and reconcile
  // our local memory with it. storage.local paints instantly (below); this quietly
  // corrects it if the truth differs (e.g. a dislike made on /watch).
  maybeReconcile();

  const like = findLikeButton();
  if (!like) return; // Short DOM not ready yet, or selectors outdated

  const host = like.closest("ytd-reel-video-renderer") || like.parentElement;
  if (!host || host.querySelector("." + BTN_CLASS)) {
    reflectState(); // button already there just make sure its state is current
    return;
  }

  like.insertAdjacentElement("afterend", buildButton());
  reflectState();
}

// --- actions ---------------------------------------------------------------

function onDislikeClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const videoId = currentShortId();
  if (!videoId) {
    console.warn("[shorts-dislike] no videoId found in URL");
    return;
  }
  // Toggle based on what we already know about this Short.
  const action = disliked.has(videoId) ? "INDIFFERENT" : "DISLIKE";
  requestDislike(videoId, action);
}

// Ask bridge.js (MAIN world) to run the InnerTube call, and await its reply.
function requestDislike(videoId, action) {
  if (STATE.pending) return; // ignore rapid double-clicks while a call is in flight
  STATE.pending = true;
  const nonce = String(performance.now()) + ":" + Math.random();

  function onReply(ev) {
    const d = ev.data;
    if (ev.source !== window || !d || d.tag !== MSG || d.dir !== "response") return;
    if (d.nonce !== nonce) return;
    window.removeEventListener("message", onReply);
    STATE.pending = false;
    if (d.ok) {
      // Update our source of truth, then persist + repaint.
      if (action === "DISLIKE") disliked.add(videoId);
      else disliked.delete(videoId);
      persist();
      reflectState();
      console.debug("[shorts-dislike] dislike ok", d.status);
    } else {
      console.error("[shorts-dislike] dislike failed:", d.error);
      signalError();
    }
  }

  window.addEventListener("message", onReply);
  window.postMessage(
    { tag: MSG, dir: "request", nonce, videoId, action },
    location.origin
  );
}

// --- reconciliation (M2) ---------------------------------------------------

// Fetch the visible Short's real server likeStatus once per session and align
// our local state with it. Skips if already fetched, in flight, or if a dislike
// call is in flight (that click is the newer truth, don't clobber it).
function maybeReconcile() {
  const id = currentShortId();
  if (!id || reconciled.has(id) || statusPending.has(id) || STATE.pending) return;
  requestStatus(id);
}

function requestStatus(videoId) {
  statusPending.add(videoId);
  const nonce = "st:" + String(performance.now()) + ":" + Math.random();

  function onReply(ev) {
    const d = ev.data;
    if (ev.source !== window || !d || d.tag !== MSG || d.dir !== "response") return;
    if (d.nonce !== nonce) return;
    window.removeEventListener("message", onReply);
    statusPending.delete(videoId);
    reconciled.add(videoId); // don't retry this Short even on failure (avoid storms)

    if (!d.ok) {
      console.debug("[shorts-dislike] status fetch failed:", d.error);
      return;
    }
    if (d.likeStatus == null) {
      console.debug("[shorts-dislike] likeStatus not found in next payload");
      return;
    }
    // A dislike may have landed while this was in flight; that click wins.
    if (STATE.pending) return;

    const serverDisliked = d.likeStatus === "DISLIKE";
    if (serverDisliked === disliked.has(videoId)) return; // already in sync

    if (serverDisliked) disliked.add(videoId);
    else disliked.delete(videoId);
    persist();
    reflectState();
    console.debug("[shorts-dislike] reconciled", videoId, "->", d.likeStatus);
  }

  window.addEventListener("message", onReply);
  window.postMessage(
    { tag: MSG, dir: "request", kind: "status", nonce, videoId },
    location.origin
  );
}

// --- lifecycle -------------------------------------------------------------

// YouTube is a single-page app: it never fully reloads. Re-inject and repaint on
// every in-app navigation and whenever the reel DOM mutates.
function onNavigate() {
  inject();
}

document.addEventListener("yt-navigate-finish", onNavigate);
window.addEventListener("popstate", onNavigate);

// Debounce: the reel DOM mutates constantly; coalesce bursts into one inject().
let scheduled = false;
const mo = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    inject();
  });
});
mo.observe(document.documentElement, { childList: true, subtree: true });

// Load remembered dislikes, then do the first paint.
store.get("disliked").then((res) => {
  const saved = res && res.disliked;
  if (saved) Object.keys(saved).forEach((id) => disliked.add(id));
  inject();
  console.debug("[shorts-dislike] loaded", disliked.size, "remembered dislikes");
});

console.debug("[shorts-dislike] content script loaded");
