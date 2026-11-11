import { DEFAULTS, isFree, speakerLabel } from "./lib/settings.js";
import { plainText, renderMarkdown } from "./lib/markdown.js";
import { icon } from "./lib/icons.js";
import { getShortcuts, keyCaps, openShortcutSettings } from "./lib/shortcuts.js";

const $ = (id) => document.getElementById(id);
const MAX_CARDS = 20;
const FONT_MIN = 13, FONT_MAX = 22;
const PHOTO_MAX = 1024; // longest side of the photo sent to the model, in pixels
const STYLES = {
  shorter: "Make it shorter: 2-3 connected sentences, still one flowing spoken answer.",
  deeper: "Go deeper technically: include specifics, trade-offs, and an example.",
  // Free conversation: "Deeper" means a stronger case, not more tech.
  deeperFree: "Go deeper: add the strongest unused reason with a concrete example, tied to what they care about; stay honest.",
};

const cards = new Map(); // answer id -> { id, el, textEl, text, question, manual, lead, kind }, oldest first
const live = { interviewer: "", me: "" }; // in-progress speech per speaker
let transcript = [];
let capturing = false;
let startedAt = null;
let activeTab = "answers";
let mode = DEFAULTS.mode; // "company" | "free", from storage
let timerHandle = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "panel") return;
  switch (msg.type) {
    case "status": return setStatus(msg);
    case "session": return loadSession(msg);
    case "transcript-live":
      live[msg.speaker] = `${msg.final} ${msg.interim}`.trim();
      return renderLive();
    case "transcript-append": return appendLine(msg.entry);
    case "insights-start": return insightsStart();
    case "insights-delta": return insightsDelta(msg.text);
    case "insights-end": return insightsEnd();
    case "insights-error": return insightsError(msg.text);
    case "answer-start": return startCard(msg);
    case "answer-kind": return setCardKind(msg.id, msg.kind);
    case "rapport": return renderRapport(msg.history);
    case "direction": return renderDirection(msg.direction);
    case "answer-delta": return appendCard(msg.id, msg.text);
    case "answer-end": return endCard(msg.id, msg);
    case "answer-best": return markBest(msg.ids, msg.best);
    case "answers-removed": return removeCards(msg.ids);
  }
});

/* ---------- Status ---------- */

function setStatus(msg) {
  capturing = msg.capturing;
  startedAt = msg.startedAt ?? null;
  renderState();
  updateTimer();
  updateEmpty();

  // Warnings/errors always surface; info only when it tells you something the UI doesn't already show.
  const showInfo = msg.level === "info" && !capturing && transcript.length > 0;
  if (msg.level !== "info" || showInfo) showNotice(msg.text, msg.level);
  else hideNotice();
}

// Listening / Paused / Not listening, and the Start ⇄ Pause ⇄ Resume button that goes with it.
function renderState() {
  const paused = !capturing && transcript.length > 0;
  $("state").classList.toggle("live", capturing);
  $("state").classList.toggle("paused", paused);
  $("stateLabel").textContent = capturing ? "Listening" : paused ? "Paused" : "Not listening";
  const [name, label, title] = capturing ? ["pause", "Pause", "Pause listening; the transcript is kept"]
    : paused ? ["play", "Resume", "Resume listening on the interview's tab"]
    : ["play", "Start", "Start listening on the tab in view"];
  $("toggle").innerHTML = `${icon(name)}${label}`;
  $("toggle").title = title;
  $("end").disabled = !capturing && transcript.length === 0;
}

function showNotice(text, level) {
  const kind = level === "error" ? "notice-error" : level === "warn" ? "notice-warn" : "";
  $("notice").innerHTML = `<div class="notice ${kind}" role="${level === "info" ? "status" : "alert"}">${icon(level === "info" ? "info" : "alert")}<span class="grow"></span>
    <button class="btn btn-ghost btn-icon btn-sm" title="Dismiss" aria-label="Dismiss">${icon("x")}</button></div>`;
  $("notice").querySelector(".grow").textContent = text;
  $("notice").querySelector("button").onclick = hideNotice;
  $("notice").hidden = false;
}

function hideNotice() {
  $("notice").hidden = true;
}

function updateTimer() {
  clearInterval(timerHandle);
  const show = capturing && startedAt;
  $("timer").hidden = !show;
  if (!show) return;
  const tick = () => ($("timer").textContent = clock(Date.now() - startedAt));
  tick();
  timerHandle = setInterval(tick, 1000);
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ---------- Tabs ---------- */

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on);
  });
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${name}`));
  if (name === "insights") $("insightsDot").hidden = true;
  if (name === "transcript") scrollTranscript(true);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

function updateEmpty() {
  const answered = visibleCards().length;
  const paused = !capturing && transcript.length > 0;
  $("answersEmpty").hidden = answered > 0;
  $("emptyTitle").textContent = capturing ? ($("auto").checked ? "Listening… waiting for a question or request" : "Listening… writing the transcript") : paused ? "Paused" : "Ready when you are";
  $("emptySteps").hidden = capturing || paused;
  $("emptyListening").hidden = !capturing && !paused;
  $("answerLast").hidden = !capturing && !paused;
  $("takeLead").hidden = !capturing && !paused;
  $("answerLast").disabled = !transcript.some((u) => u.speaker === "interviewer");
  $("clearAnswers").hidden = cards.size === 0; // hidden photo cards count: Clear removes them too
  $("transcriptEmpty").hidden = transcript.length > 0 || Object.values(live).some(Boolean);
  setCount("transcriptCount", transcript.length);
  setCount("answersCount", answered);
}

function setCount(id, n) {
  $(id).hidden = n === 0;
  $(id).textContent = n > 99 ? "99+" : n;
}

/* ---------- Transcript ---------- */

function loadSession(msg) {
  transcript = msg.transcript.slice();
  $("lines").replaceChildren(...transcript.map((e) => lineEl(e)));
  setInsights(msg.insights);
  renderRapport(msg.rapport ?? []);
  renderDirection(msg.direction);
  restoreCards(msg.answers ?? []);
  renderState();
  updateEmpty();
  scrollTranscript(true);
}

function lineEl({ speaker, text, t }, interim = false) {
  const div = document.createElement("div");
  div.className = `line ${speaker}${interim ? " interim" : ""}`;
  div.innerHTML = `<div class="meta"><span class="who"></span><span class="time"></span></div><div class="bubble"></div>`;
  div.querySelector(".who").textContent = speakerLabel(speaker, mode);
  div.querySelector(".time").textContent = interim ? "speaking…" : t ? clock(t - (startedAt ?? transcript[0]?.t ?? t)) : "";
  div.querySelector(".bubble").textContent = text;
  if (speaker === "interviewer" && !interim) {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm act";
    b.title = "Draft an answer to this line";
    b.innerHTML = `${icon("sparkle")}Answer`;
    b.addEventListener("click", () => toBackground({ type: "answer-line", text }));
    div.querySelector(".meta").append(b);
  }
  return div;
}

function appendLine(entry) {
  const stick = nearBottom();
  transcript.push(entry);
  live[entry.speaker] = "";
  $("lines").append(lineEl(entry));
  renderLive();
  if (stick) scrollTranscript(true);
  if (transcript.length === 1) renderState();
  updateEmpty();
}

function renderLive() {
  const active = Object.entries(live).filter(([, t]) => t);
  const stick = nearBottom();
  $("liveLines").replaceChildren(...active.map(([speaker, text]) => lineEl({ speaker, text }, true)));
  if (stick) scrollTranscript(true);

  // Compact caption on the Answers tab.
  $("live").hidden = active.length === 0;
  $("live").replaceChildren(...active.map(([speaker, text]) => {
    const row = document.createElement("div");
    row.className = "live-row";
    row.innerHTML = `<span class="badge ${speaker === "me" ? "badge-me" : "badge-accent"}"><span class="dot"></span></span><span class="txt"></span>`;
    row.querySelector(".badge").append(speakerLabel(speaker, mode));
    row.querySelector(".txt").textContent = text;
    return row;
  }));
  updateEmpty();
}

const transcriptPane = $("pane-transcript");
function nearBottom() {
  return transcriptPane.scrollHeight - transcriptPane.scrollTop - transcriptPane.clientHeight < 80;
}
function scrollTranscript(force) {
  if (force) transcriptPane.scrollTop = transcriptPane.scrollHeight;
  $("jump").hidden = nearBottom();
}
transcriptPane.addEventListener("scroll", () => ($("jump").hidden = nearBottom()));
$("jump").addEventListener("click", () => scrollTranscript(true));

/* ---------- Answers ---------- */

function startCard({ id, question, manual, lead = false, kind = "answer" }, { restoring = false } = {}) {
  // A lead offered in a pause leaves the previous card open: you may still be reading it out.
  const keepOpen = lead && !manual && !restoring;
  // Photo off: its card is made but hidden, and leaves the cards you can see as they are.
  const hidden = kind === "icebreaker" && !showPhoto();
  if (!hidden) for (const c of cards.values()) {
    c.el.classList.remove("latest");
    if (!keepOpen) setOpen(c, false);
  }
  const el = document.createElement("article");
  el.className = `card answer streaming${hidden ? "" : " latest"}`;
  el.innerHTML = `
    <button class="answer-head" type="button" aria-expanded="true">
      <span class="badge kind-badge"></span>
      <span class="answer-q"></span>
      ${icon("chevron", "chev")}
    </button>
    <div class="answer-body">
      <div class="answer-text md streaming-caret"></div>
      <div class="answer-actions">
        <button class="btn btn-ghost btn-sm stop-btn" data-act="stop" title="Stop generating (Esc)">${icon("stop")}Stop</button>
        <button class="btn btn-ghost btn-sm" data-style="" title="Regenerate (R)">${icon("refresh")}Regenerate</button>
        <button class="btn btn-ghost btn-sm" data-style="shorter" title="Shorter (S)">${icon("shorter")}Shorter</button>
        <button class="btn btn-ghost btn-sm deeper" data-style="deeper" title="More technical depth (D)">${icon("code")}Deeper</button>
        <button class="btn btn-ghost btn-sm btn-icon copy-btn" data-act="copy" title="Copy answer (C)" aria-label="Copy answer">${icon("copy")}</button>
        <button class="btn btn-ghost btn-sm btn-icon btn-danger" data-act="delete" title="Delete this card (X)" aria-label="Delete this card">${icon("trash")}</button>
      </div>
    </div>`;
  el.querySelector(".answer-q").textContent = question;
  if (kind === "icebreaker" && !restoring) el.querySelector(".answer-text").innerHTML = `<p class="answer-note">Studying their face and checking the movie…</p>`;
  const card = { id, el, textEl: el.querySelector(".answer-text"), text: "", question, manual, lead, kind };
  el.querySelector(".answer-head").addEventListener("click", () => setOpen(card, el.classList.contains("collapsed")));
  el.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => regenerate(card, b.dataset.style)));
  el.querySelector('[data-act="copy"]').addEventListener("click", (e) => copyText(plainText(card.text), e.currentTarget));
  el.querySelector('[data-act="stop"]').addEventListener("click", () => toBackground({ type: "stop-answer" }));
  el.querySelector('[data-act="delete"]').addEventListener("click", () => toBackground({ type: "delete-answer", id }));

  $("answers").prepend(el);
  cards.set(id, card);
  setCardKind(id, kind, manual);
  while (cards.size > MAX_CARDS) {
    const [oldest] = cards.values();
    oldest.el.remove();
    cards.delete(oldest.id);
  }
  if (!restoring && !hidden) {
    $("pane-answers").scrollTop = 0;
    if (activeTab !== "answers") selectTab("answers");
  }
  updateEmpty();
}

// Rebuilds the cards a reopened panel missed (the background keeps them for the session).
function restoreCards(list) {
  cards.clear();
  $("answers").replaceChildren();
  for (const a of list) {
    startCard(a, { restoring: true });
    appendCard(a.id, a.text);
    if (a.done) endCard(a.id, a);
    if (a.best) markBest([a.id], a.id);
  }
  updateEmpty();
}

// Deleted cards (trash, X, Clear). If the highlighted one went, the newest card on screen takes it.
function removeCards(ids) {
  for (const id of ids) {
    cards.get(id)?.el.remove();
    cards.delete(id);
  }
  if (!visibleCards().some((c) => c.el.classList.contains("latest"))) visibleCards().at(-1)?.el.classList.add("latest");
  updateEmpty();
}

// Among several answers to the same question, the model's pick reads slightly bold.
function markBest(ids, best) {
  for (const id of ids) {
    const c = cards.get(id);
    if (!c) continue;
    c.el.classList.toggle("best", id === best);
    c.el.querySelector(".answer-head").title = id === best ? "Most appropriate of the answers to this question" : "";
  }
}

function setOpen(card, open) {
  card.el.classList.toggle("collapsed", !open);
  card.el.querySelector(".answer-head").setAttribute("aria-expanded", open);
}

function regenerate(card, style) {
  if (style === "deeper" && (card.kind === "smalltalk" || card.kind === "icebreaker")) return;
  const key = style === "deeper" && isFree(mode) ? "deeperFree" : style;
  toBackground({ type: "regenerate", question: card.question, style: STYLES[key] ?? "", manual: card.manual, lead: card.lead, photo: card.kind === "icebreaker" });
}

function appendCard(id, text) {
  const c = cards.get(id);
  if (!c || !text) return;
  c.text += text;
  c.textEl.innerHTML = renderMarkdown(c.text, { pauses: true });
}

function endCard(id, { error, stopped } = {}) {
  const c = cards.get(id);
  if (!c) return;
  c.el.classList.remove("streaming");
  c.textEl.classList.remove("streaming-caret");
  if (stopped && !c.text) c.textEl.innerHTML = `<p class="answer-note">Stopped before any text arrived.</p>`;
  else if (!c.text) c.textEl.replaceChildren(); // drop the icebreaker's "Looking at the photo" note
  if (error) {
    const n = document.createElement("div");
    n.className = "notice notice-error answer-error";
    n.innerHTML = icon("alert");
    n.append(error);
    c.el.querySelector(".answer-actions").before(n);
  }
}

// Shows "Copied" in the button's label, or swaps an icon-only button to a check mark.
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return showNotice("Couldn't copy. Click inside the panel and try again.", "warn");
  }
  const label = btn.querySelector("span");
  const prev = label ? label.textContent : btn.innerHTML;
  if (label) label.textContent = "Copied";
  else btn.innerHTML = icon("check");
  setTimeout(() => (label ? (label.textContent = prev) : (btn.innerHTML = prev)), 1400);
}

function setCardKind(id, kind, manual = cards.get(id)?.manual) {
  const c = cards.get(id);
  if (!c) return;
  c.manual = manual;
  c.kind = kind;
  const small = kind === "smalltalk";
  const lead = kind === "lead";
  const ice = kind === "icebreaker";
  c.el.classList.toggle("smalltalk", small);
  c.el.classList.toggle("lead", lead);
  c.el.classList.toggle("icebreaker", ice);
  const badge = c.el.querySelector(".kind-badge");
  badge.className = `badge kind-badge ${small || ice ? "badge-me" : lead ? "badge-success" : manual ? "" : "badge-accent"}`;
  badge.textContent = small ? "Small talk" : lead ? "Your move" : ice ? "Icebreaker" : manual ? "You asked" : isFree(mode) ? "Them" : "Interviewer";
  c.el.querySelector(".deeper").hidden = small || ice;
}

/* ---------- Rapport ---------- */

const TONE_BADGE = { formal: "", neutral: "", friendly: "badge-accent", casual: "badge-me", playful: "badge-warn" };
const TREND = { rising: "↑", steady: "→", falling: "↓" };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const rapportTier = (n) => (n >= 7 ? "good" : n >= 5 ? "mid" : "low");

function renderRapport(history) {
  const r = history.at(-1);
  $("rapport").hidden = !r;
  $("timelineBox").hidden = history.length === 0;
  $("insightsEmpty").hidden = history.length > 0 || !$("insights").hidden;
  if (!r) return $("timeline").replaceChildren();

  $("rapportMeter").className = `meter ${rapportTier(r.rapport)}`;
  $("rapportMeter").innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${i < r.rapport ? "on" : ""}"></i>`).join("");
  $("rapportScore").textContent = r.rapport;
  $("rapportTrend").className = `trend ${r.trend}`;
  $("rapportTrend").textContent = TREND[r.trend];
  $("rapportTrend").title = `Trend: ${r.trend}`;
  $("rapportBadges").innerHTML = `<span class="badge ${TONE_BADGE[r.tone]}">${cap(r.tone)}</span>`
    + (r.humor ? `<span class="badge badge-warn" title="The interviewer has been joking">Humor</span>` : "");
  $("rapportTip").textContent = r.advice;
  $("rapportTip").title = r.signals.join("\n");

  const t0 = startedAt ?? transcript[0]?.t ?? history[0].t;
  const color = { good: "var(--success)", mid: "var(--warn)", low: "var(--danger)" };
  $("timeline").replaceChildren(...history.map((h) => {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.title = h.signals.join("\n");
    row.innerHTML = `<span class="time">${clock(h.t - t0)}</span>
      <span class="bar"><span style="width:${h.rapport * 10}%;background:${color[rapportTier(h.rapport)]}"></span></span>
      <span class="val">${h.rapport}</span><span class="tone">${cap(h.tone)}${h.humor ? " · humor" : ""}</span>`;
    return row;
  }));
}

/* ---------- Direction ---------- */

const STAGE = {
  opening: "Opening", background: "Background", technical: "Technical", system_design: "System design", coding: "Coding",
  behavioral: "Behavioral", role_and_company: "Role & company", candidate_questions: "Your questions", closing: "Closing",
};
const REGISTER_BADGE = { technical: "badge-accent", everyday: "badge-me", mixed: "badge-warn" };

// Free conversation: where the other person stands on your view.
const FREE_STAGE = {
  opening: "Opening", exploring: "Exploring", presenting: "Making my case", objections: "Objections",
  converging: "Converging", agreement: "Agreement", closing: "Closing",
};
const STANCE_BADGE = { opposed: "badge-danger", skeptical: "badge-warn", neutral: "", open: "badge-accent", agrees: "badge-success" };

let lastDirection = null;
function renderDirection(d) {
  lastDirection = d ?? null;
  // A reading from the other mode (before a switch) has the wrong shape; the background re-reads it.
  if (d && !!d.stance !== isFree(mode)) d = null;
  $("direction").hidden = !d;
  if (!d) return;
  if (d.stance) return renderFreeDirection(d);
  $("dirTopic").textContent = d.topic;
  $("dirTopic").title = d.focus.length ? `Interviewer keeps probing:\n${d.focus.join("\n")}` : "";
  $("dirBadges").innerHTML = `<span class="badge" title="Interview stage">${STAGE[d.stage] ?? cap(d.stage)}</span>`
    + `<span class="badge ${REGISTER_BADGE[d.register]}" title="Technical depth: ${d.depth}">${cap(d.register)}</span>`;
  const tip = document.createElement("div");
  tip.innerHTML = `<div><b>Heading · </b><span></span></div>${d.steer.length ? `<div><b>Steer toward · </b><span></span></div>` : ""}`;
  const [heading, steer] = tip.querySelectorAll("span");
  heading.textContent = d.heading;
  if (steer) steer.textContent = d.steer.join(" · ");
  $("dirTip").replaceChildren(...tip.children);
}

function renderFreeDirection(d) {
  $("dirTopic").textContent = d.topic;
  $("dirTopic").title = d.focus.length ? `Their open concerns:\n${d.focus.join("\n")}` : "";
  $("dirBadges").innerHTML = `<span class="badge" title="Conversation stage">${FREE_STAGE[d.stage] ?? cap(d.stage)}</span>`
    + `<span class="badge ${STANCE_BADGE[d.stance] ?? ""}" title="Where they stand on your point of view">${cap(d.stance)}</span>`;
  const rows = [
    ["Concerns", d.focus.join(" · ")],
    ["Next move", d.steer.join(" · ")],
    ["Still to ask", d.pending.join(" · ")],
  ].filter(([, text]) => text);
  $("dirTip").replaceChildren(...rows.map(([label, text]) => {
    const div = document.createElement("div");
    div.innerHTML = `<b>${label} · </b><span></span>`;
    div.querySelector("span").textContent = text;
    return div;
  }));
}

/* ---------- Mode: company interview or free conversation ---------- */

function applyMode(next) {
  mode = isFree(next) ? "free" : "company";
  const free = isFree(mode);
  $("mode").textContent = free ? "Free talk" : "Interview";
  $("mode").classList.toggle("free", free);
  $("mode").title = free
    ? "Free conversation: replies answer their questions and bring them round to your topic's point of view. Click to switch to a company interview"
    : "Company interview: answers come from your CV and the job. Click to switch to a free conversation";
  $("otherLegend").textContent = speakerLabel("interviewer", mode);
  // Relabel what's on screen: transcript lines, live captions, card badges, the direction strip.
  $("lines").replaceChildren(...transcript.map((e) => lineEl(e)));
  renderLive();
  for (const c of cards.values()) setCardKind(c.id, c.kind);
  renderDirection(lastDirection);
}
$("mode").addEventListener("click", () => chrome.storage.local.set({ mode: isFree(mode) ? "company" : "free" }));
chrome.storage.local.get("mode").then((r) => applyMode(r.mode ?? DEFAULTS.mode));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.mode) applyMode(changes.mode.newValue);
});

/* ---------- Insights ---------- */

function setInsights(md) {
  $("insights").hidden = !md;
  $("insightsEmpty").hidden = !!md || !$("timelineBox").hidden;
  $("insights").innerHTML = md ? renderMarkdown(md) : "";
}

let insightsText = "";
function insightsStart() {
  insightsText = "";
  $("insights").hidden = false;
  $("insightsEmpty").hidden = true;
  $("insights").innerHTML = `<p class="muted">Analyzing the conversation…</p>`;
  $("insights").classList.add("streaming-caret");
  $("analyze").disabled = true;
}
function insightsDelta(text) {
  insightsText += text;
  $("insights").innerHTML = renderMarkdown(insightsText);
}
function insightsEnd() {
  $("insights").classList.remove("streaming-caret");
  $("analyze").disabled = false;
  $("insightsMeta").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (activeTab !== "insights") $("insightsDot").hidden = false;
}
function insightsError(text) {
  $("insights").classList.remove("streaming-caret");
  $("analyze").disabled = false;
  if (!insightsText) setInsights("");
  showNotice(text, "warn");
}

/* ---------- Font size ---------- */

function setFont(px) {
  px = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.body.style.setProperty("--answer-size", `${px}px`);
  try { localStorage.setItem("answerFont", px); } catch {}
  $("fontDown").disabled = px === FONT_MIN;
  $("fontUp").disabled = px === FONT_MAX;
  return px;
}
let fontPx = 16;
try { fontPx = Number(localStorage.getItem("answerFont")) || 16; } catch {}
fontPx = setFont(fontPx);
const nudgeFont = (d) => (fontPx = setFont(fontPx + d));
$("fontDown").addEventListener("click", () => nudgeFont(-1));
$("fontUp").addEventListener("click", () => nudgeFont(1));

/* ---------- Keyboard shortcuts sheet ---------- */

async function openKeys() {
  const list = await getShortcuts();
  $("globalKeys").replaceChildren(...list.flatMap(({ shortcut, description }) => {
    const dt = document.createElement("dt");
    dt.innerHTML = shortcut ? keyCaps(shortcut) : `<span class="muted small">Not set</span>`;
    const dd = document.createElement("dd");
    dd.textContent = description;
    return [dt, dd];
  }));
  $("keys").showModal();
}
$("shortcuts").addEventListener("click", openKeys);
$("keysClose").addEventListener("click", () => $("keys").close());
$("customizeKeys").addEventListener("click", openShortcutSettings);
$("keys").addEventListener("click", (e) => {
  // Clicks on the backdrop land on the dialog element outside its box.
  const r = $("keys").getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $("keys").close();
});

// Mention the start shortcut in the empty state when one is set.
getShortcuts().then((list) => {
  const start = list.find((c) => c.name === "_execute_action")?.shortcut;
  if (start) $("startKeyHint").innerHTML = ` (or press ${keyCaps(start)})`;
});

/* ---------- Floating window ---------- */

// In the side panel, "Pop out" moves this page into a box on the page in view (overlay.js). There
// (sidepanel.html?float) the title bar drags the box, the slider sets its opacity, and Dock comes back.
// In the box, "Out of the browser" moves it into an always-on-top window (sidepanel.html?float&pip, see overlay.js).
const params = new URLSearchParams(location.search);
const floating = params.has("float");
const pip = params.has("pip");
const toOverlay = (msg) => window.parent.postMessage({ supportInterview: msg }, location.ancestorOrigins[0] ?? "*");
$("titlebar").hidden = !floating;
$("float").hidden = floating;
document.body.classList.toggle("pip", pip);
if (pip) $("titlebar").title = "";

$("float").addEventListener("click", async () => {
  // The box goes on sites other than Meet only with access to them. Asked first thing: Chrome requires the
  // click for it, and doesn't ask again once allowed. Refused, it still pops out onto Meet or the tab you
  // clicked the icon on.
  await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
  if (await toBackground({ type: "float" })) window.close();
});

if (floating) {
  // Fetched up front: sidePanel.open must run synchronously inside the Dock click. The desktop window
  // isn't a tab, so there the box passes the interview tab's id in the URL.
  let tabId = Number(params.get("tab")) || null;
  if (tabId === null) chrome.tabs.getCurrent().then((t) => (tabId = t?.id ?? null));
  $("dock").addEventListener("click", () => {
    if (tabId !== null) chrome.sidePanel.open({ tabId }).catch(() => {});
    chrome.storage.local.set({ floating: false });
  });
  $("closeFloat").addEventListener("click", () => toOverlay({ type: "close" }));
  $("desktop").addEventListener("click", () => toOverlay({ type: "desktop" }));
  window.addEventListener("message", (e) => {
    const m = e.data?.supportInterview;
    if (e.source === window.parent && m?.type === "pip-failed") showNotice(m.text, "warn");
  });

  const setOpacity = (pct) => {
    $("opacity").value = pct;
    $("opacityVal").textContent = `${pct}%`;
  };
  chrome.storage.local.get("overlayBox").then(({ overlayBox }) => setOpacity(Math.round((overlayBox?.opacity ?? 1) * 100)));
  $("opacity").addEventListener("input", (e) => {
    setOpacity(e.target.value);
    toOverlay({ type: "opacity", value: e.target.value / 100 });
  });

  // Screen coordinates: the box moves under the pointer while dragging, so client coordinates would drift.
  const bar = $("titlebar");
  let start = null;
  bar.addEventListener("pointerdown", (e) => {
    if (pip || e.button !== 0 || e.target.closest("button, input, label")) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    start = { x: e.screenX, y: e.screenY };
    toOverlay({ type: "drag-start" });
  });
  const endDrag = () => {
    if (!start) return;
    start = null;
    bar.classList.remove("dragging");
    toOverlay({ type: "drag-end" });
  };
  bar.addEventListener("pointermove", (e) => {
    if (!start) return;
    // Button released outside this frame (the pointerup went to the page): stop, or the box sticks to the cursor.
    if (!(e.buttons & 1)) return endDrag();
    toOverlay({ type: "drag", dx: e.screenX - start.x, dy: e.screenY - start.y });
  });
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);
  bar.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("blur", endDrag);
}

/* ---------- Photo icebreaker ---------- */

const showPhoto = () => $("showPhoto").checked;
// Cards on screen, oldest first: photo cards drop out while Photo is off.
const visibleCards = () => [...cards.values()].filter((c) => showPhoto() || c.kind !== "icebreaker");

// Photo on: show the prepared lines, opening the newest (when switched on, not at load); off: hide them all.
function applyPhoto(switched = false) {
  document.body.classList.toggle("hide-photo", !showPhoto());
  if (switched) {
    // The highlight goes to the newest photo card when shown, else back to the newest card on screen.
    const top = showPhoto() ? [...cards.values()].findLast((c) => c.kind === "icebreaker") : visibleCards().at(-1);
    for (const c of cards.values()) c.el.classList.toggle("latest", c === top);
    if (top && showPhoto()) {
      setOpen(top, true);
      if (activeTab !== "answers") selectTab("answers");
      top.el.scrollIntoView({ block: "nearest" });
    }
  }
  updateEmpty();
}

// A screenshot of the interviewer's face -> a friendly "you look like <character> from <movie>" line.
// Downscaled to a JPEG first: a smaller upload, in a format every model accepts.
async function sendPhoto(file) {
  if (!file?.type.startsWith("image/")) return showNotice("That isn't an image. Use a PNG or JPG screenshot.", "warn");
  try {
    toBackground({ type: "photo", image: await shrinkImage(file) });
    if (!showPhoto()) showNotice("Studying their photo. Turn on Photo to see the lines about them.", "info");
  } catch {
    showNotice("Couldn't read that image. Try another screenshot.", "warn");
  }
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs would turn black in a JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return { mediaType: "image/jpeg", data: url.split(",")[1] };
}

const imageFile = (list) => [...(list ?? [])].find((f) => f.type.startsWith("image/"));
$("photo").addEventListener("click", () => $("photoFile").click());
$("photoFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // so picking the same file again still fires change
  if (file) sendPhoto(file);
});
// Ctrl+V a screenshot anywhere in the panel; pasting text into the box works as before.
document.addEventListener("paste", (e) => {
  const file = imageFile(e.clipboardData?.files);
  if (!file) return;
  e.preventDefault();
  sendPhoto(file);
});
// Drop an image file on the panel. dragleave also fires when crossing child elements, so count enters and leaves.
let dragDepth = 0;
const dragsFiles = (e) => e.dataTransfer?.types.includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!dragsFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => {
  if (dragsFiles(e) && --dragDepth <= 0) document.body.classList.remove("dropping");
});
document.addEventListener("dragover", (e) => {
  if (dragsFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dropping");
  sendPhoto(imageFile(e.dataTransfer.files));
});

/* ---------- Controls ---------- */

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("askText").value.trim();
  if (!text) return;
  toBackground({ type: "ask", text });
  $("askText").value = "";
});
$("answerLast").addEventListener("click", () => toBackground({ type: "answer-last" }));
$("takeLead").addEventListener("click", () => toBackground({ type: "take-lead" }));
$("analyze").addEventListener("click", () => toBackground({ type: "analyze" }));
$("copy").addEventListener("click", (e) =>
  copyText(transcript.map((u) => `${speakerLabel(u.speaker, mode)}: ${u.text}`).join("\n"), e.currentTarget));
$("toggle").addEventListener("click", () => toBackground({ type: capturing ? "stop" : "start" }));
$("end").addEventListener("click", () => toBackground({ type: "end-meeting" }));
$("history").addEventListener("click", () => toBackground({ type: "open-history" }));
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Auto-answer, Proactive and Nice live in storage, shared with the Options page and read by the background each time.
// Photo only changes what this panel shows (shared with the floating window).
const SWITCHES = { auto: "autoAnswer", proactive: "proactive", nice: "nice", showPhoto: "showPhoto" }; // element id -> setting
chrome.storage.local.get(Object.values(SWITCHES)).then((stored) => {
  for (const [id, key] of Object.entries(SWITCHES)) $(id).checked = stored[key] ?? DEFAULTS[key];
  applyPhoto();
  updateEmpty();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [id, key] of Object.entries(SWITCHES)) if (changes[key]) $(id).checked = changes[key].newValue;
  if (changes.autoAnswer) updateEmpty();
  if (changes.showPhoto) applyPhoto(true);
});
for (const [id, key] of Object.entries(SWITCHES)) {
  $(id).addEventListener("change", (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}

// Two-step confirm instead of a dialog: the first click arms the button for 3 s.
function twoStep(btn, prompt, action) {
  const idle = btn.innerHTML;
  let timer;
  const reset = () => { btn.dataset.armed = ""; btn.innerHTML = idle; };
  btn.addEventListener("click", () => {
    clearTimeout(timer);
    if (btn.dataset.armed === "1") {
      reset();
      return action();
    }
    btn.dataset.armed = "1";
    btn.textContent = prompt;
    timer = setTimeout(reset, 3000);
  });
}
twoStep($("discard"), "Click again to discard", () => toBackground({ type: "new-session" }));
// Every answer card, photo ones included, and the uploaded photo; the transcript and insights stay.
twoStep($("clearAnswers"), "Click again to clear", () => toBackground({ type: "clear-answers" }));

// Single-key shortcuts while the panel has focus (not while typing or with the shortcuts sheet open).
document.addEventListener("keydown", (e) => {
  // Switches and sliders aren't typing: Space still answers after you've clicked one.
  const typing = !!e.target.closest?.("textarea, input:not([type=checkbox], [type=radio], [type=range])");
  if (e.key === "Escape" && typing) return e.target.blur();
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $("keys").open) return;
  const latest = visibleCards().at(-1);
  const actions = {
    "/": () => $("askText").focus(),
    "?": openKeys,
    " ": () => {
      document.activeElement?.blur(); // otherwise Space would also press or toggle whatever has focus
      if (!e.repeat) toBackground({ type: "answer-last" }); // held down: answer once
    },
    a: () => toBackground({ type: "answer-last" }),
    l: () => toBackground({ type: "take-lead" }),
    p: () => $("photoFile").click(),
    r: () => latest && regenerate(latest, ""),
    s: () => latest && regenerate(latest, "shorter"),
    d: () => latest && regenerate(latest, "deeper"),
    c: () => latest && copyText(plainText(latest.text), latest.el.querySelector(".copy-btn")),
    x: () => latest && toBackground({ type: "delete-answer", id: latest.id }),
    Escape: () => toBackground({ type: "stop-answer" }),
    1: () => selectTab("answers"),
    2: () => selectTab("transcript"),
    3: () => selectTab("insights"),
    "+": () => nudgeFont(1),
    "=": () => nudgeFont(1),
    "-": () => nudgeFont(-1),
  };
  const act = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!act) return;
  e.preventDefault();
  act();
});

renderState();
updateEmpty();
toBackground({ type: "panel-ready" });
