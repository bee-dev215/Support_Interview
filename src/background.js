import { aiKey, getSettings, isFree, providerName } from "./lib/settings.js";
import { analyzeDirection, analyzeRapport, pickBestAnswer, streamAnalysis, streamAnswer, streamLead, streamLookalike, warmCache } from "./lib/claude.js";
import { classify } from "./lib/detect.js";
import { addRecord } from "./lib/history.js";

const NO_Q = "NO_QUESTION";
const NO_LEAD = "NO_LEAD";
const SMALL = "SMALLTALK:";
const LEAD = "LEAD:";
const TAGS = [NO_Q, NO_LEAD, SMALL, LEAD];
const ANALYZE_EVERY = 8;      // auto-analyze after this many new utterances
const ECHO_WINDOW_MS = 15000;
const RAPPORT_EVERY = 3;     // re-read rapport after this many new utterances (or right after humor)
const DIRECTION_EVERY = 4;   // re-read the interview's direction after this many new utterances
const LEAD_PAUSE_MS = 7000;  // silence after you finish speaking before offering a way to take the lead
const MAX_ANSWERS = 20;      // answer cards kept per session (the panel shows the same number)
const PHOTO_LABEL = "From their photo: movie lookalike and kind things to say";

let currentAnswer = null;
let answerSeq = Date.now(); // seeded from the clock so ids stay unique across service-worker restarts
let currentAnalysis = null;
let sinceAnalysis = 0;
let sinceRapport = 0;
let rapportRunning = false;
let sinceDirection = 0;
let directionRunning = false;
let leadTimer = null;

// Persisted in chrome.storage.session so they survive service-worker restarts: the worker can be
// stopped during a long silence while the offscreen document keeps capturing.
let session = emptySession(null);
let capturingTabId = null;
const ready = chrome.storage.session.get(["session", "capturingTabId"]).then((r) => {
  if (r.session) session = r.session;
  capturingTabId = r.capturingTabId ?? null;
  // A stream in flight when the worker stopped is gone; don't leave its card spinning.
  for (const a of session.answers ?? []) if (!a.done) Object.assign(a, { done: true, stopped: true });
  updateBadge();
});
const save = () => chrome.storage.session.set({ session });

function setCapturing(tabId) {
  capturingTabId = tabId;
  chrome.storage.session.set({ capturingTabId });
  updateBadge();
}

// Toolbar badge: ON while listening, II while a session is paused.
function updateBadge() {
  const live = capturingTabId !== null;
  const paused = !live && session.transcript.length > 0;
  chrome.action.setBadgeText({ text: live ? "ON" : paused ? "II" : "" });
  chrome.action.setBadgeBackgroundColor({ color: live ? "#e03131" : "#646b7a" });
  chrome.action.setTitle({
    title: live ? "Support_Interview: listening. Click to open the panel."
      : paused ? "Support_Interview: paused. Click to resume on this tab."
      : "Start Support_Interview on this tab",
  });
}

const toPanel = (msg) => chrome.runtime.sendMessage({ target: "panel", ...msg }).catch(() => {});
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: "offscreen", ...msg }).catch(() => {});
// Last warning/error, replayed when the panel opens: start failures often fire before it has loaded.
let lastProblem = null;
const status = (text, level = "info") => {
  if (level !== "info") lastProblem = { text, level };
  toPanel({ type: "status", text, level, capturing: capturingTabId !== null, startedAt: session.startedAt });
};

// tabCapture only works on a tab where the icon (or its shortcut) was used; say so plainly.
const startFailed = (e) => status(/invoked|activeTab/i.test(e.message)
  ? "Chrome only allows capturing a tab after you click the Support_Interview icon on it (or press its shortcut). Click it on your interview's tab."
  : `Start failed: ${e.message}`, "error");

// Popped out: the panel shows as a floating box on the page (overlay.js) instead of in the side panel.
let floating = false;
chrome.storage.local.get("floating").then((r) => (floating = !!r.floating));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.floating) floating = !!changes.floating.newValue;
  // Company interview <-> free conversation: the direction strip reads different things, so read it afresh.
  if (area === "local" && changes.mode) ready.then(() => {
    session.direction = null;
    save();
    toPanel({ type: "direction", direction: null });
    updateDirection();
  });
});

// Free conversation: the topic's game plan (goal, reasons, likely objections) is made by the Analyze topic
// button in Options. Until it matches the topic text, replies work from the topic itself.
// The box can sit on any web page we can see the URL of (the interview's tab after its icon click, Meet always,
// other sites once "Pop out" has been granted access to them), but not on chrome:// pages or the Web Store,
// which extensions can't script.
const canFloat = (tab) => /^https?:\/\//.test(tab?.url ?? "")
  && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//.test(tab.url);

// Side panel, or the floating box when popped out. Call synchronously inside the user gesture:
// sidePanel.open requires one.
function showPanel(tab) {
  if (floating && canFloat(tab)) return showOverlay(tab.id);
  return chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
}

// Resolves whether the box is up. Re-injecting a live copy would rebuild the box and reload the panel in it,
// so inject only when no copy answers: pages other than Meet, and Meet tabs opened before the extension was
// installed or reloaded.
async function tryOverlay(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { target: "overlay", type: "show" }).then((up) => up === true, () => false);
  if (await ask()) return true;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] }).catch(() => {});
  return ask();
}

async function showOverlay(tabId) {
  if (await tryOverlay(tabId)) return true;
  // Can't show it here: drop back to the side panel so the icon opens something again.
  await chrome.storage.local.set({ floating: false });
  status("Couldn't show the floating window on this page, so it's back in the side panel. Reload the tab, then click the icon.", "warn");
  return false;
}

// "Pop out" in the side panel: switch to the floating box on the tab in view, or failing that the
// interview's tab or any Meet tab (this window's first), bringing it into view. Resolves false (the side
// panel stays open) when none of them can take the box.
async function floatPanel() {
  await ready;
  const id = capturingTabId ?? session.tabId;
  const own = id !== null ? await chrome.tabs.get(id).catch(() => null) : null;
  const current = await activeTab();
  const meets = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  meets.sort((a, b) => (b.windowId === current?.windowId) - (a.windowId === current?.windowId));
  for (const tab of [current, own, ...meets].filter(canFloat)) {
    if (!(await tryOverlay(tab.id))) continue;
    if (tab.id !== current?.id) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.storage.local.set({ floating: true });
    return true;
  }
  status("The floating window can't open on this page (Chrome pages and the Web Store block it). Switch to a website or your interview's tab, then click Pop out.", "warn");
  return false;
}

chrome.action.onClicked.addListener((tab) => {
  showPanel(tab);
  startCapture(tab).catch(startFailed);
});

// Keyboard shortcuts (chrome://extensions/shortcuts). _execute_action is handled by onClicked above.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "answer-last") return ready.then(answerLast);
  if (command === "take-lead") return ready.then(takeLead);
  if (command !== "toggle-listening") return;
  if (tab) showPanel(tab);
  ready.then(async () => {
    if (capturingTabId !== null) return stopCapture();
    return startCapture(tab ?? (await activeTab()));
  }).catch(startFailed);
});

const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

async function startCapture(tab) {
  await ready;
  if (capturingTabId !== null) return status("Already listening.");
  if (!tab) return status("Open your interview's tab, then click the extension icon on it.", "warn");
  lastProblem = null;
  // Any website works (Meet, Zoom, Teams, an AI interviewer...). The URL is hidden when we have no access to
  // the tab yet; then tabCapture decides, and startFailed explains.
  if (tab.url && !/^https?:\/\//.test(tab.url)) {
    return status("Chrome doesn't allow listening to this page. Open your interview's website, then click the extension icon on that tab.", "warn");
  }
  const s = await getSettings();
  if (!aiKey(s) || !s.deepgramKey) {
    status(s.keysLocked ? "Your API keys are locked. Enter your passphrase in Options, then start again."
      : `Set your ${providerName(s)} and Deepgram API keys in Options first.`, "error");
    chrome.runtime.openOptionsPage();
    return;
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  // A different tab or meeting means a different interview; resuming the same one keeps the transcript.
  const meetingUrl = meetingBase(tab.url);
  if (session.tabId !== tab.id || session.meetingUrl !== meetingUrl) resetSession(tab.id);
  Object.assign(session, { meetingUrl, title: tab.title || meetingUrl, startedAt: session.startedAt ?? Date.now() });
  save();
  setCapturing(tab.id);
  toOffscreen({ type: "start-capture", streamId, deepgramKey: s.deepgramKey, language: s.language, captureMic: s.captureMic, micDeviceId: s.micDeviceId });
  if (isFree(s.mode)) {
    status(s.freeTopic ? "Free conversation: listening..." : "Free conversation: listening. No topic yet: add it in Options so replies can steer toward your view.", s.freeTopic ? "info" : "warn");
  } else {
    status(s.profile ? "Listening to the conversation..." : "Listening. No CV profile yet: answers will be generic.", s.profile ? "info" : "warn");
  }
  warmCache(s).catch(() => {}); // best effort
}

// Start / Resume button in the panel. Resume prefers the paused interview's tab; Start uses the tab in view.
async function startFromPanel() {
  await ready;
  const paused = session.transcript.length > 0 && session.tabId !== null
    ? await chrome.tabs.get(session.tabId).catch(() => null)
    : null;
  return startCapture(paused ?? (await activeTab()));
}

async function stopCapture() {
  clearTimeout(leadTimer);
  toOffscreen({ type: "stop-capture" });
  currentAnswer?.abort();
  setCapturing(null);
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  status("Paused. Click Resume to continue, or End & get feedback when the interview is over.");
}

// Meeting over: save it to history and open the feedback report in its own tab
// (the interview's tab and its side panel may already be gone).
let ending = false;
async function endMeeting(reason) {
  if (ending) return;
  ending = true;
  try {
    await ready;
    if (capturingTabId !== null) await stopCapture();
    // Let the offscreen document flush its last utterances.
    await new Promise((r) => setTimeout(r, 300));
    if (session.transcript.length === 0) return status("Interview ended. Nothing was transcribed, so there is no feedback.", "warn");

    const s = await getSettings();
    const id = `${Date.now()}`;
    await addRecord({
      id,
      title: session.title || "Interview",
      meetingUrl: session.meetingUrl,
      startedAt: session.startedAt ?? session.transcript[0].t,
      endedAt: Date.now(),
      endReason: reason,
      mode: s.mode,
      jobDesc: isFree(s.mode) ? "" : s.jobDesc,
      // The plan only if it was made from this topic.
      ...(isFree(s.mode) && { freeTopic: s.freeTopic, freePlan: s.freePlanTopic === s.freeTopic.trim() ? s.freePlan : "" }),
      transcript: session.transcript,
      insights: session.insights,
      rapport: session.rapport ?? [],
      feedback: "",
    });
    resetSession(null);
    await chrome.tabs.create({ url: `report.html?id=${id}` });
    status("Interview ended. Your feedback report opened in a new tab.");
  } finally {
    ending = false;
  }
}

// Which interview a tab URL belongs to. On Meet the path is the meeting code. Elsewhere the path is often just
// the site's own routing (an AI interview moves through question and results pages), so the site is the interview.
function meetingBase(url) {
  try {
    const u = new URL(url);
    return u.hostname === "meet.google.com" ? u.origin + u.pathname : u.origin;
  } catch {
    return null;
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the interview tab's audio and microphone for live transcription",
  });
}

function emptySession(tabId) {
  // photo: the latest uploaded face screenshot, kept for Regenerate; never saved to history.
  return { tabId, meetingUrl: null, title: "", startedAt: null, transcript: [], insights: "", rapport: [], direction: null, answers: [], photo: null };
}

const snapshot = () => ({
  transcript: session.transcript,
  insights: session.insights,
  rapport: session.rapport ?? [],
  direction: session.direction ?? null,
  answers: session.answers ?? [],
});

function resetSession(tabId = session.tabId) {
  currentAnalysis?.abort();
  currentAnswer?.abort();
  clearTimeout(leadTimer);
  session = emptySession(tabId);
  sinceAnalysis = 0;
  sinceRapport = 0;
  sinceDirection = 0;
  save();
  toPanel({ type: "session", ...snapshot() });
  updateBadge();
}

// Both wait for `ready`: these events can be what wakes the worker, before capturingTabId is restored.
chrome.tabs.onRemoved.addListener((tabId) => ready.then(() => {
  if (tabId === capturingTabId) endMeeting("Interview tab closed");
}));

// Navigating the interview's tab away from the meeting (another Meet code, or another site) ends it. A URL we
// lost access to (activeTab ends at a cross-origin navigation) reads as undefined, which counts as leaving.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => ready.then(() => {
  if (tabId !== capturingTabId || !session.meetingUrl) return;
  if (change.url === undefined && change.status !== "loading") return;
  if (meetingBase(tab.url) !== session.meetingUrl) endMeeting("Left the meeting page");
}));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return;
  if (msg.type === "float") {
    floatPanel().then(sendResponse, () => sendResponse(false));
    return true; // answered asynchronously
  }
  // The floating box asks which tab it is on, for the Dock button in its always-on-top window.
  if (msg.type === "tab-id") return sendResponse(sender.tab?.id ?? null);
  ready.then(() => {
    switch (msg.type) {
      case "meeting-left":
        if (sender.tab?.id === capturingTabId) endMeeting("Left the call");
        return;
      case "end-meeting": return endMeeting("Ended manually");
      case "open-history": return chrome.tabs.create({ url: "report.html" });
      case "utterance": return onUtterance(msg.speaker, msg.text);
      case "ask": return answer(msg.text, { force: true, manual: true });
      case "answer-last": return answerLast();
      case "take-lead": return takeLead();
      case "answer-line": return answer(msg.text, { force: true });
      case "photo": return photoIcebreaker(msg.image);
      case "regenerate": return answer(msg.question, { force: true, style: msg.style, manual: msg.manual, lead: msg.lead, photo: msg.photo });
      case "speaking": return clearTimeout(leadTimer); // someone is talking: no lead into their speech
      case "stop-answer": return currentAnswer?.abort();
      case "delete-answer": return deleteAnswers([msg.id]);
      case "clear-answers": return deleteAnswers((session.answers ?? []).map((a) => a.id));
      case "analyze": return analyze();
      case "new-session": return resetSession();
      case "start": return startFromPanel().catch(startFailed);
      case "stop": return stopCapture();
      case "panel-ready":
        toPanel({ type: "session", ...snapshot() });
        if (lastProblem) return status(lastProblem.text, lastProblem.level);
        return status(capturingTabId !== null ? "Listening to the conversation..." : "Idle. Click the extension icon on your interview's tab to start.");
      case "capture-warning": return status(msg.text, "warn");
      case "capture-error":
        setCapturing(null);
        return status(msg.text, "error");
    }
  });
});

function onUtterance(speaker, text) {
  if (speaker === "me" && isEcho(text)) return; // mic picked up the interviewer from the speakers
  const entry = { speaker, text, t: Date.now() };
  session.transcript.push(entry);
  save();
  toPanel({ type: "transcript-append", entry });

  const kind = speaker === "interviewer" ? classify(text) : "respond";
  if (++sinceAnalysis >= ANALYZE_EVERY && !currentAnalysis) analyze();
  if (++sinceRapport >= RAPPORT_EVERY || kind === "humor") updateRapport();
  if (++sinceDirection >= DIRECTION_EVERY || !session.direction) updateDirection();
  // You finished speaking: if nobody picks it up, offer a way to keep the conversation going.
  clearTimeout(leadTimer);
  if (speaker === "me") leadTimer = setTimeout(pauseLead, LEAD_PAUSE_MS);
  if (speaker !== "interviewer" || kind === "skip") return;
  answer(text, { auto: true });
}

// "Take the lead" button / shortcut: a move to steer the conversation, on demand.
function takeLead() {
  return answer("Your move: steer the conversation", { force: true, manual: true, lead: true });
}

// Offered after a pause that follows your own speech, unless an answer is still streaming.
function pauseLead() {
  if (capturingTabId === null || currentAnswer) return;
  if (!session.transcript.some((u) => u.speaker === "interviewer")) return;
  answer("Pause: keep the conversation going", { auto: true, lead: true });
}

// Photo button / paste / drop in the panel: a movie-lookalike icebreaker from a screenshot of the interviewer.
function photoIcebreaker(image) {
  session.photo = { ...image, id: Date.now() };
  save();
  return answer(PHOTO_LABEL, { force: true, manual: true, photo: true });
}

// Trash on a card / Clear in the panel: drop those cards, stopping one still streaming. The uploaded photo
// goes too once no card made from it is left, so a deleted photo isn't kept for Regenerate.
function deleteAnswers(ids) {
  const gone = new Set(ids);
  if ((session.answers ?? []).some((a) => gone.has(a.id) && !a.done)) currentAnswer?.abort();
  session.answers = (session.answers ?? []).filter((a) => !gone.has(a.id));
  if (session.photo && !session.answers.some((a) => a.photoId === session.photo.id)) session.photo = null;
  save();
  toPanel({ type: "answers-removed", ids });
}

// "Answer last question" button / shortcut: the newest interviewer line, answered even if auto-answer is off.
function answerLast() {
  const last = session.transcript.findLast((u) => u.speaker === "interviewer");
  if (!last) return status("Nothing from the other side yet. Type the question in the box below instead.", "warn");
  return answer(last.text, { force: true });
}

const missingKey = (s) => s.keysLocked
  ? "Your API keys are locked. Enter your passphrase in Options."
  : `Missing ${providerName(s)} API key (Options).`;

// Structured read of the conversation's rapport and tone; feeds the panel meter and the answer style.
async function updateRapport() {
  if (rapportRunning || session.transcript.length < 2) return;
  const s = await getSettings();
  if (!aiKey(s)) return;
  rapportRunning = true;
  sinceRapport = 0;
  try {
    const r = await analyzeRapport(s, session.transcript);
    if (!r) return;
    const reading = { ...r, t: Date.now() };
    (session.rapport ??= []).push(reading);
    save();
    toPanel({ type: "rapport", reading, history: session.rapport });
  } catch {
    // Non-critical: answers still adapt tone from the transcript itself.
  } finally {
    rapportRunning = false;
  }
}

// Where the interview is and is heading (stage, topic, technical vs everyday, strengths to steer toward).
// Feeds the panel's direction strip and every answer and lead.
async function updateDirection() {
  const asked = session.transcript.filter((u) => u.speaker === "interviewer").length;
  if (directionRunning || asked < 2) return;
  const s = await getSettings();
  if (!aiKey(s)) return;
  directionRunning = true;
  sinceDirection = 0;
  try {
    const d = await analyzeDirection(s, session.transcript);
    if (!d) return;
    session.direction = { ...d, t: Date.now() };
    save();
    toPanel({ type: "direction", direction: session.direction });
  } catch {
    // Non-critical: answers still follow the conversation from the transcript itself.
  } finally {
    directionRunning = false;
  }
}

// Without headphones the mic hears the interviewer; drop "me" lines that mostly repeat recent interviewer speech.
function isEcho(text) {
  const words = new Set(normalize(text));
  if (words.size === 0) return true;
  const now = Date.now();
  return session.transcript.some((u) => {
    if (u.speaker !== "interviewer" || now - u.t > ECHO_WINDOW_MS) return false;
    const other = new Set(normalize(u.text));
    let shared = 0;
    for (const w of words) if (other.has(w)) shared++;
    return shared / words.size >= 0.7;
  });
}

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").split(/\s+/).filter(Boolean);

// lead: a move the candidate makes on their own initiative; photo: an icebreaker from session.photo.
// For both, question is just the card's label.
async function answer(question, { force = false, style = "", manual = false, auto = false, lead = false, photo = false } = {}) {
  const s = await getSettings();
  if (auto && !(lead ? s.proactive : s.autoAnswer)) return;
  if (!aiKey(s)) return status(missingKey(s), "error");
  if (photo && !session.photo) return status("That photo is gone with the old session. Upload it again.", "warn");

  currentAnswer?.abort(); // newest question wins
  const id = ++answerSeq;
  let buffered = "";
  const plain = lead ? "lead" : photo ? "icebreaker" : "answer"; // kind of a reply that carries no tag
  // "answer" | "smalltalk" | "lead" | "none", decided from the reply's first characters; icebreakers carry no tags.
  let kind = photo ? plain : null;
  // Kept in the session so a reopened panel shows the same cards.
  const card = { id, question, manual, lead, kind: plain, text: "", done: false, t: Date.now(), ...(photo && { photoId: session.photo.id }) };
  let shown = false;
  const show = (k) => {
    shown = true;
    card.kind = k;
    (session.answers ??= []).push(card);
    if (session.answers.length > MAX_ANSWERS) session.answers.shift();
    save();
    toPanel({ type: "answer-start", id, question, manual, lead, kind: k });
  };
  const emit = (text) => {
    if (!text) return;
    card.text += text;
    toPanel({ type: "answer-delta", id, text });
  };
  const finish = (extra = {}) => {
    Object.assign(card, extra, { done: true });
    save();
    toPanel({ type: "answer-end", id, ...extra });
  };
  // Manual asks get a card immediately; automatic ones only once we know there's something to show.
  if (force) show(plain);

  try {
    const rapport = session.rapport?.at(-1);
    const direction = session.direction;
    // Earlier suggestions for the same photo, so Regenerate offers a different movie.
    const avoid = () => session.answers.filter((a) => a.photoId === card.photoId && a.text && !a.error).map((a) => a.text);
    const stream = photo ? streamLookalike(s, session.transcript, session.photo, { style, avoid: avoid() })
      : lead ? streamLead(s, session.transcript, { force, style, rapport, direction })
      : streamAnswer(s, session.transcript, question, style, rapport, direction);
    currentAnswer = stream;
    stream.on("text", (delta) => {
      if (id !== answerSeq || kind === "none") return;
      if (kind) return emit(delta);
      // Hold back output until a NO_QUESTION / NO_LEAD / SMALLTALK: / LEAD: tag is ruled in or out.
      buffered += delta;
      const head = buffered.trimStart();
      if (TAGS.some((t) => head.length < t.length && t.startsWith(head))) return;
      if (head.startsWith(NO_Q) || head.startsWith(NO_LEAD)) {
        kind = card.kind = "none";
        if (force) emit(lead ? "Nothing worth adding right now. Let the interviewer lead." : "Nothing to respond to here. Try typing what they asked or requested.");
        return;
      }
      const tag = [SMALL, LEAD].find((t) => head.startsWith(t));
      kind = tag === SMALL ? "smalltalk" : tag === LEAD ? "lead" : plain;
      if (force) {
        card.kind = kind;
        toPanel({ type: "answer-kind", id, kind });
      } else {
        show(kind);
      }
      emit(tag ? head.slice(tag.length).trimStart() : buffered);
    });
    const final = await stream.finalMessage();
    if (!shown) return;
    finish(final.stop_reason === "refusal" ? { error: "Model declined to answer." } : {});
    if (!lead && !photo && isReply(card)) pickBest(question);
  } catch (e) {
    // Aborted by Stop, by a newer question, or by ending/discarding the session.
    const aborted = e?.name === "APIUserAbortError" || id !== answerSeq;
    if (shown) finish(aborted ? { stopped: true } : { error: e.message });
    else if (!aborted) status(`Answer failed: ${e.message}`, "error");
  } finally {
    if (id === answerSeq) currentAnswer = null;
  }
}

// Answers that can compete for "most appropriate": finished, with real text.
const isReply = (a) => a.done && a.text && !a.error && !a.stopped && a.kind !== "none";

// A question answered more than once (Regenerate / Shorter / Deeper / answered again): the model picks
// the reply to say, and the panel shows it slightly bold.
async function pickBest(question) {
  const replies = () => (session.answers ?? []).filter((a) => a.question === question && !a.lead && isReply(a));
  const candidates = replies();
  if (candidates.length < 2) return;
  try {
    const i = await pickBestAnswer(await getSettings(), session.transcript, question, candidates.map((a) => a.text));
    const now = replies();
    // Skip if a newer reply arrived meanwhile (its own pick follows) or the session was reset.
    if (i === null || now.at(-1) !== candidates.at(-1) || !now.includes(candidates[i])) return;
    for (const a of now) a.best = a === candidates[i];
    save();
    toPanel({ type: "answer-best", ids: now.map((a) => a.id), best: candidates[i].id });
  } catch {
    // Non-critical: every answer is still shown, just without the highlight.
  }
}

async function analyze() {
  const s = await getSettings();
  if (!aiKey(s)) return status(missingKey(s), "error");
  if (session.transcript.length === 0) return toPanel({ type: "insights-error", text: "Nothing to analyze yet." });

  currentAnalysis?.abort();
  sinceAnalysis = 0;
  let text = "";
  toPanel({ type: "insights-start" });
  try {
    const stream = streamAnalysis(s, session.transcript);
    currentAnalysis = stream;
    stream.on("text", (delta) => {
      text += delta;
      toPanel({ type: "insights-delta", text: delta });
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") return toPanel({ type: "insights-error", text: "Model declined to analyze." });
    session.insights = text;
    save();
    toPanel({ type: "insights-end" });
  } catch (e) {
    if (e?.name !== "APIUserAbortError") toPanel({ type: "insights-error", text: e.message });
  } finally {
    currentAnalysis = null;
  }
}
