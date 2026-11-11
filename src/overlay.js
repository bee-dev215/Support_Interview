// Content script (on Google Meet, injected elsewhere): the floating panel. Chrome's side panel can't be moved or made see-through,
// so when you pop it out, the same page (sidepanel.html?float) runs in an iframe inside a box on the page.
// Drag it by its title bar (handled in the iframe, which posts the moves here), resize it from any edge or
// corner, and set its opacity with the slider; position, size and opacity are remembered.
// Injected on demand by the background: on other sites (any interview page), and on Meet tabs opened before the extension was (re)loaded.
(() => {
  // The newest copy always takes over. A copy from before an extension reload can no longer reach the
  // extension (its listeners are dead), so bailing out when one exists would leave Pop out doing nothing.
  window.__supportInterviewOverlay?.();
  window.__supportInterviewOverlay = dispose;

  const HOST_TAG = "support-interview-overlay";
  // Not new URL(...).origin: per the URL spec that is "null" for chrome-extension: URLs, which would drop every message.
  const ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");
  const MIN_W = 300, MIN_H = 240, MARGIN = 16;
  const MIN_OPACITY = 0.2;
  const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  const CSS = `
    iframe { display: block; width: 100%; height: 100%; border: 0; border-radius: 12px; background: transparent; }
    .edge { position: absolute; z-index: 1; }
    .n, .s { left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
    .e, .w { top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
    .n { top: -4px; } .s { bottom: -4px; } .e { right: -4px; } .w { left: -4px; }
    .ne, .nw, .se, .sw { width: 14px; height: 14px; }
    .ne { top: -4px; right: -4px; cursor: nesw-resize; } .sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
    .nw { top: -4px; left: -4px; cursor: nwse-resize; } .se { bottom: -4px; right: -4px; cursor: nwse-resize; }
    .busy iframe { pointer-events: none; }
  `;

  // A previous version of the extension (before a reload) leaves a dead box behind.
  document.querySelector(HOST_TAG)?.remove();

  let saved = null; // last stored { x, y, w, h, opacity }
  let loaded = null; // resolves once `saved` is read, so a show() right after injection uses the stored box
  let box = null;   // live geometry while shown
  let host = null, wrap = null, frame = null;
  let dragStart = null;
  let saveTimer;
  // Out of the browser: a Document Picture-in-Picture window. The OS keeps it above every other app and it
  // can go anywhere on screen, but only this page can open it, and only right after a click (the click in the
  // panel's iframe counts for this page too). It closes with the page.
  let pip = null, pipFrame = null;
  let pipReshow = true; // closed with the window's own X or "back to tab": bring the box back on the page
  let pipSaveTimer;
  let pipSize = null; // last { w, h } of the desktop window, read up front: opening it must follow the click closely

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function fit() {
    box.w = clamp(box.w, MIN_W, innerWidth);
    box.h = clamp(box.h, MIN_H, innerHeight);
    box.x = clamp(box.x, 0, innerWidth - box.w);
    box.y = clamp(box.y, 0, innerHeight - box.h);
    box.opacity = clamp(box.opacity, MIN_OPACITY, 1);
  }

  function apply() {
    Object.assign(host.style, {
      left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, opacity: box.opacity,
    });
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saved = { ...box };
      chrome.storage.local.set({ overlayBox: saved }).catch(() => {});
    }, 300);
  }

  async function show() {
    await loaded;
    if (host || pip) return;
    const w = 380, h = Math.min(680, innerHeight - 2 * MARGIN);
    box = { x: innerWidth - w - MARGIN, y: MARGIN, w, h, opacity: 1, ...saved };
    fit();

    // Inline styles on the host (page CSS can't override them); the rest lives in a closed shadow root.
    host = document.createElement(HOST_TAG);
    Object.assign(host.style, {
      all: "initial", position: "fixed", zIndex: 2147483647, display: "block",
      borderRadius: "12px", boxShadow: "0 12px 32px rgb(0 0 0 / 35%), 0 0 0 1px rgb(0 0 0 / 12%)",
    });
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    wrap = document.createElement("div");
    Object.assign(wrap.style, { position: "relative", width: "100%", height: "100%" });
    frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("sidepanel.html?float");
    frame.allow = "clipboard-write";
    frame.title = "Support_Interview";
    wrap.append(frame, ...EDGES.map(edge));
    root.append(wrap);
    document.documentElement.append(host);
    apply();
  }

  function hide() {
    host?.remove();
    host = wrap = frame = null;
  }

  // Tells the panel in the box why the desktop window didn't open.
  const tellBox = (msg) => frame?.contentWindow?.postMessage({ supportInterview: msg }, ORIGIN);

  async function openPip() {
    if (pip) return;
    if (!window.documentPictureInPicture) {
      return tellBox({ type: "pip-failed", text: "This version of Chrome can't open an always-on-top window. Update Chrome (116 or newer) and try again." });
    }
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({
        width: Math.round(pipSize?.w ?? box?.w ?? 380),
        height: Math.round(pipSize?.h ?? box?.h ?? 640),
      });
    } catch {
      return tellBox({ type: "pip-failed", text: "Chrome didn't open the window. Click the button again." });
    }
    pip = win;
    pipReshow = true;
    // The panel's Dock button needs this tab, which a page inside the desktop window can't look up itself.
    const tabId = await chrome.runtime.sendMessage({ target: "background", type: "tab-id" }).catch(() => null);

    // Styles set through the DOM, not a <style> tag, so the page's content security policy can't block them.
    const doc = win.document;
    doc.title = "Support_Interview";
    Object.assign(doc.documentElement.style, { height: "100%", colorScheme: "light dark" });
    Object.assign(doc.body.style, { margin: "0", height: "100%", overflow: "hidden", background: "Canvas" });
    pipFrame = doc.createElement("iframe");
    pipFrame.src = chrome.runtime.getURL(`sidepanel.html?float&pip${Number.isInteger(tabId) ? `&tab=${tabId}` : ""}`);
    pipFrame.allow = "clipboard-write";
    pipFrame.title = "Support_Interview";
    Object.assign(pipFrame.style, { display: "block", width: "100%", height: "100%", border: "0" });
    doc.body.append(pipFrame);
    hide();

    win.addEventListener("message", onPipMessage);
    win.addEventListener("resize", () => {
      clearTimeout(pipSaveTimer);
      pipSaveTimer = setTimeout(() => {
        pipSize = { w: win.innerWidth, h: win.innerHeight };
        chrome.storage.local.set({ pipSize }).catch(() => {});
      }, 300);
    });
    win.addEventListener("pagehide", () => {
      pip = pipFrame = null;
      if (pipReshow) chrome.storage.local.get("floating").then(({ floating }) => floating && show(), () => {});
    });
  }

  function closePip(reshow) {
    if (!pip) return;
    pipReshow = reshow;
    pip.close();
  }

  // Requests from the panel inside the desktop window.
  function onPipMessage(e) {
    if (!pipFrame || e.source !== pipFrame.contentWindow || e.origin !== ORIGIN) return;
    if (e.data?.supportInterview?.type === "close") closePip(false);
  }

  // Resize from an edge or corner; the opposite edge stays put.
  function edge(dir) {
    const el = document.createElement("div");
    el.className = `edge ${dir}`;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      wrap.classList.add("busy"); // keep the iframe from swallowing the moves
      const s = { ...box }, x0 = e.clientX, y0 = e.clientY;
      const move = (ev) => {
        if (!(ev.buttons & 1)) return up(); // released where we didn't hear it: stop resizing
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (dir.includes("e")) box.w = clamp(s.w + dx, MIN_W, innerWidth - s.x);
        if (dir.includes("s")) box.h = clamp(s.h + dy, MIN_H, innerHeight - s.y);
        if (dir.includes("w")) {
          box.w = clamp(s.w - dx, MIN_W, s.x + s.w);
          box.x = s.x + s.w - box.w;
        }
        if (dir.includes("n")) {
          box.h = clamp(s.h - dy, MIN_H, s.y + s.h);
          box.y = s.y + s.h - box.h;
        }
        apply();
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.removeEventListener("lostpointercapture", up);
        wrap?.classList.remove("busy");
        save();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
    });
    return el;
  }

  // Requests from the panel inside the iframe. Only that frame (extension origin) is listened to.
  function onFrameMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
    const m = e.data?.supportInterview;
    if (!m) return;
    switch (m.type) {
      case "drag-start":
        dragStart = { x: box.x, y: box.y };
        return;
      case "drag":
        if (!dragStart) return;
        box.x = clamp(dragStart.x + m.dx, 0, innerWidth - box.w);
        box.y = clamp(dragStart.y + m.dy, 0, innerHeight - box.h);
        return apply();
      case "drag-end":
        dragStart = null;
        return save();
      case "opacity":
        box.opacity = clamp(Number(m.value) || 1, MIN_OPACITY, 1);
        apply();
        return save();
      case "close":
        return hide();
      case "desktop":
        return openPip();
    }
  }

  function onResize() {
    if (!host) return;
    fit();
    apply();
  }

  // "floating" is the popped-out mode, shared by every tab that has the box; the toolbar icon re-shows a closed box.
  function onStorage(changes, area) {
    if (area !== "local" || !changes.floating) return;
    if (changes.floating.newValue) show();
    else {
      hide();
      closePip(false);
    }
  }

  // Answers true once the box (or the desktop window) is up, so the background knows this copy is alive and needn't inject another.
  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (msg.target !== "overlay" || msg.type !== "show") return;
    show().then(() => sendResponse(!!(host || pip)), () => sendResponse(false));
    return true;
  }

  // Called by the next copy injected into this page.
  function dispose() {
    hide();
    closePip(false);
    removeEventListener("message", onFrameMessage);
    removeEventListener("resize", onResize);
    try {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // Context already invalidated by an extension reload: those listeners are dead anyway.
    }
  }

  addEventListener("message", onFrameMessage);
  addEventListener("resize", onResize);
  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  loaded = chrome.storage.local.get(["floating", "overlayBox", "pipSize"]).then(({ floating, overlayBox, pipSize: size }) => {
    saved = overlayBox ?? null;
    pipSize = size ?? null;
    return floating;
  }).catch(() => false);
  loaded.then((floating) => { if (floating) show(); });
})();
