// content.js — runs in the ISOLATED world.
// Job: detect the active Short, inject a dislike button next to the like button,
// and ask the page-context bridge (bridge.js) to perform the actual dislike call.
//
// Why two scripts? The dislike request needs YouTube's internal `ytcfg` data and
// same-origin auth, which only exist in the PAGE context (MAIN world). Content
// scripts run isolated and can't read `window.ytcfg`. So content.js owns the UI
// and bridge.js (MAIN world) owns the network call. They talk via DOM CustomEvents.

const BTN_CLASS = "sd-dislike-btn";
const STATE = { active: false }; // toggled ON when the user has disliked the current short

// --- helpers ---------------------------------------------------------------

// Read the videoId of the Short currently in view. YouTube updates the URL as you
// scroll, so reading it at click-time always matches the visible Short.
function currentShortId() {
  const m = location.pathname.match(/^\/shorts\/([\w-]{5,})/);
  return m ? m[1] : null;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
}

// Find the like button of the Short currently on screen.
// NOTE: these selectors are the most fragile part of the extension — YouTube
// changes its DOM often. If injection stops working, this is the function to fix.
// Open DevTools on a Short, inspect the thumbs-up, and update the selectors below.
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

function buildButton() {
  const btn = document.createElement("button");
  btn.className = BTN_CLASS;
  btn.type = "button";
  btn.title = "Dislike this Short";
  btn.setAttribute("aria-label", "Dislike");
  btn.innerHTML = thumbSvg();
  btn.addEventListener("click", onDislikeClick);
  return btn;
}

function thumbSvg() {
  // Simple thumbs-down glyph (inline SVG so we ship no image assets).
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path fill="currentColor" d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v1.91c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 24l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/>
  </svg>`;
}

function reflectState() {
  const btn = document.querySelector("." + BTN_CLASS);
  if (btn) btn.classList.toggle("sd-active", STATE.active);
}

// Keep exactly one button present next to the visible like button.
function inject() {
  const like = findLikeButton();
  if (!like) return; // not on a Short, or DOM not ready / selectors outdated

  // Already injected for this like button? bail.
  const host = like.closest("ytd-reel-video-renderer") || like.parentElement;
  if (!host || host.querySelector("." + BTN_CLASS)) return;

  const btn = buildButton();
  like.insertAdjacentElement("afterend", btn);
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
  // Toggle: if already disliked, send the "remove dislike" intent.
  const action = STATE.active ? "INDIFFERENT" : "DISLIKE";
  requestDislike(videoId, action);
}

// Ask bridge.js (MAIN world) to run the InnerTube call, and await its reply.
function requestDislike(videoId, action) {
  const nonce = String(performance.now()) + Math.random();

  function onReply(ev) {
    if (!ev.detail || ev.detail.nonce !== nonce) return;
    document.removeEventListener("sd-dislike-response", onReply);
    if (ev.detail.ok) {
      STATE.active = action === "DISLIKE";
      reflectState();
      console.debug("[shorts-dislike] dislike ok", ev.detail.status);
    } else {
      console.error("[shorts-dislike] dislike failed", ev.detail.error);
    }
  }

  document.addEventListener("sd-dislike-response", onReply);
  document.dispatchEvent(
    new CustomEvent("sd-dislike-request", { detail: { nonce, videoId, action } })
  );
}

// --- lifecycle -------------------------------------------------------------

// YouTube is a single-page app: it never fully reloads. Re-inject on every
// in-app navigation and whenever the reel DOM mutates.
function onNavigate() {
  STATE.active = false; // new short → reset our local toggle
  inject();
}

document.addEventListener("yt-navigate-finish", onNavigate);
window.addEventListener("popstate", onNavigate);

const mo = new MutationObserver(() => inject());
mo.observe(document.documentElement, { childList: true, subtree: true });

inject();
console.debug("[shorts-dislike] content script loaded");
