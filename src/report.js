import { aiKey, getSettings, isFree, providerName, speakerLabel } from "./lib/settings.js";
import { clearHistory, deleteRecord, getHistory, getRecord, updateRecord } from "./lib/history.js";
import { streamFeedback } from "./lib/claude.js";
import { renderMarkdown } from "./lib/markdown.js";
import { icon } from "./lib/icons.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id");
let record;
let generating = null;

const fmtDate = (t) => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDuration = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clock = (ms) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
};

/* ---------- Parsing helpers ---------- */

function parseScore(md) {
  const m = md?.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*10/i);
  return m ? Number(m[1]) : null;
}
function parseOutcome(md) {
  const m = md?.match(/\*\*Likely outcome:\*\*\s*([^\n]+)/i);
  if (!m) return null;
  const [label, ...rest] = m[1].split(/\s+[—–-]\s+|,\s+|;\s+/);
  const l = label.toLowerCase();
  // Interview outcomes, then free-conversation ones (Convinced / Leaning my way / Undecided / Not convinced).
  const kind = l.includes("unlikely") || l.includes("not convinced") ? "danger"
    : l.includes("borderline") || l.includes("undecided") ? "warn"
    : l.includes("advance") || l.includes("convinced") || l.includes("leaning") ? "success" : "";
  const reason = rest.join(", ").trim();
  return { label: label.replace(/\.$/, "").trim(), kind, reason: reason && reason[0].toUpperCase() + reason.slice(1) };
}
const tier = (score) => (score == null ? "none" : score >= 7 ? "good" : score >= 5 ? "mid" : "low");

function ringHtml(score, cls = "") {
  return `<div class="ring ${cls} ${tier(score)}" style="--p:${score == null ? 0 : score * 10}">
    <div class="ring-inner"><span>${score == null ? "–" : score}</span><small>/10</small></div></div>`;
}

/* ---------- History list ---------- */

// Two-step confirm instead of a dialog: the first click arms the button for 3 s.
// Clicks stop here, so a button inside a list item doesn't also open the interview.
function twoStep(btn, prompt, action) {
  const idle = btn.innerHTML;
  const iconOnly = btn.classList.contains("btn-icon");
  let timer;
  const reset = () => {
    btn.dataset.armed = "";
    btn.classList.toggle("btn-icon", iconOnly);
    btn.innerHTML = idle;
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    if (btn.dataset.armed === "1") {
      reset();
      return action();
    }
    btn.dataset.armed = "1";
    btn.classList.remove("btn-icon");
    btn.textContent = prompt;
    timer = setTimeout(reset, 3000);
  });
}

if (id) showReport(); else showList();

let list = [];

async function showList() {
  $("listView").hidden = false;
  list = await getHistory();
  renderList();
}

function renderList() {
  $("listSummary").textContent = list.length
    ? `${list.length} interview${list.length === 1 ? "" : "s"} · newest first`
    : "Your past interviews and feedback reports.";
  $("clearHistory").hidden = list.length === 0;

  const q = $("search").value.trim().toLowerCase();
  const items = list.filter((r) => !q || `${r.title} ${r.jobDesc} ${r.freeTopic ?? ""}`.toLowerCase().includes(q));
  if (items.length === 0) {
    $("list").innerHTML = list.length
      ? `<div class="empty-list"><div class="empty-title">No matches</div>Try a different search.</div>`
      : `<div class="empty-list card"><div class="empty-title">No interviews yet</div>
          They appear here after you click <b>End</b> or leave a call.</div>`;
    return;
  }
  $("list").replaceChildren(...items.map((r) => {
    const score = parseScore(r.feedback);
    const outcome = parseOutcome(r.feedback);
    const a = document.createElement("a");
    a.className = "item card";
    a.href = `report.html?id=${r.id}`;
    a.innerHTML = `${ringHtml(score, "mini-ring")}
      <div><div class="t">${esc(r.title)}</div>
      <div class="s">${fmtDate(r.startedAt)} · ${fmtDuration(r.endedAt - r.startedAt)} · ${r.transcript.length} lines</div></div>
      <span class="badge ${outcome ? `badge-${outcome.kind}` : ""}">${outcome ? esc(outcome.label) : r.feedback ? "Reviewed" : "No feedback yet"}</span>
      <button class="btn btn-ghost btn-danger btn-icon btn-sm" title="Delete this interview" aria-label="Delete this interview">${icon("trash")}</button>`;
    twoStep(a.querySelector("button"), "Delete?", async () => {
      await deleteRecord(r.id);
      list = list.filter((x) => x !== r);
      renderList();
    });
    return a;
  }));
}

$("search").addEventListener("input", renderList);
twoStep($("clearHistory"), "Click again to delete all", async () => {
  await clearHistory();
  list = [];
  renderList();
});

/* ---------- Report ---------- */

async function showReport() {
  record = await getRecord(id);
  if (!record) {
    $("listView").hidden = false;
    $("list").innerHTML = `<div class="empty-list card"><div class="empty-title">Interview not found</div>It may have been deleted.</div>`;
    return;
  }
  $("reportView").hidden = false;
  document.title = `Feedback · ${record.title}`;
  $("title").textContent = record.title;

  const mine = record.transcript.filter((u) => u.speaker === "me").length;
  const chips = [
    fmtDate(record.startedAt),
    fmtDuration(record.endedAt - record.startedAt),
    `${record.transcript.length - mine} ${isFree(record.mode) ? "them" : "interviewer"} · ${mine} me`,
    record.endReason,
    ...(isFree(record.mode) ? ["Free conversation"] : []),
  ];
  $("meta").innerHTML = chips.map((c) => `<span class="badge">${esc(c)}</span>`).join("");
  if (mine === 0) $("meta").insertAdjacentHTML("beforeend", `<span class="badge badge-warn">Mic not captured</span>`);
  renderRapport(record.rapport ?? []);

  $("insights").innerHTML = record.insights ? renderMarkdown(record.insights) : `<p class="muted">No live insights were captured.</p>`;
  renderTranscript();

  // Feedback is written only when asked for (Regenerate): ending a call just saves it.
  if (record.feedback) renderFeedback(record.feedback);
  else $("feedback").innerHTML = `<p class="muted">No feedback for this call. Click <b>Regenerate</b> if you want one.</p>`;
}

function renderRapport(readings) {
  $("rapportCard").hidden = readings.length === 0;
  if (readings.length === 0) return;
  const first = readings[0].rapport, last = readings.at(-1).rapport;
  const arrow = last > first ? "↑" : last < first ? "↓" : "→";
  $("meta").insertAdjacentHTML("beforeend",
    `<span class="badge badge-${tier(last) === "good" ? "success" : tier(last) === "mid" ? "warn" : "danger"}" title="Rapport at the start → at the end">Rapport ${first} ${arrow} ${last}</span>`);

  const t0 = record.transcript[0]?.t ?? record.startedAt;
  const color = { good: "var(--success)", mid: "var(--warn)", low: "var(--danger)" };
  $("rapportTimeline").replaceChildren(...readings.map((r) => {
    const row = document.createElement("div");
    row.className = "rt-row";
    row.innerHTML = `<span class="time">${clock(r.t - t0)}</span>
      <span class="track"><span class="fill" style="width:${r.rapport * 10}%;background:${color[tier(r.rapport)]}"></span></span>
      <span class="val">${r.rapport}/10</span>
      <span class="tone">${r.tone[0].toUpperCase() + r.tone.slice(1)}${r.humor ? " · humor" : ""} · ${r.trend}</span>
      <span class="why"></span>`;
    row.querySelector(".why").textContent = r.signals.join(" · ");
    return row;
  }));
}

function renderTranscript() {
  const t0 = record.transcript[0]?.t ?? record.startedAt;
  $("transcript").replaceChildren(...record.transcript.map((u) => {
    const div = document.createElement("div");
    div.className = `tline ${u.speaker}`;
    div.innerHTML = `<span class="time">${clock(u.t - t0)}</span>
      <span class="who">${speakerLabel(u.speaker, record.mode)}</span><span class="text"></span>`;
    div.querySelector(".text").textContent = u.text;
    return div;
  }));
}

function renderHero(md) {
  const score = parseScore(md);
  const ring = $("ring");
  ring.className = `ring ${tier(score)}`;
  ring.style.setProperty("--p", score == null ? 0 : score * 10);
  $("ringScore").textContent = score == null ? "–" : score;

  const outcome = parseOutcome(md);
  $("outcome").hidden = !outcome;
  $("outcomeWhy").textContent = outcome?.reason ?? "";
  if (outcome) {
    $("outcome").className = `badge badge-${outcome.kind || "accent"}`;
    $("outcome").innerHTML = `<span class="dot"></span>${esc(outcome.label)}`;
  }
}

// Turns the model's Markdown into section cards, score bars, question cards and an email block.
function renderFeedback(md, streaming = false) {
  renderHero(md);
  const tmp = document.createElement("div");
  tmp.innerHTML = renderMarkdown(md);

  const sections = [];
  let current = null;
  for (const node of [...tmp.children]) {
    if (node.tagName === "H2") continue; // "# Interview feedback" title; the hero replaces it
    if (node.tagName === "H3") {
      current = document.createElement("section");
      current.className = "card fb-section md";
      current.append(node);
      sections.push(current);
    } else if (current) {
      current.append(node);
    } else {
      node.classList.add("fb-intro");
      sections.push(node);
    }
  }

  $("summary").textContent = "";
  for (const sec of sections) {
    const title = sec.querySelector("h3")?.textContent.trim().toLowerCase() ?? "";
    if (title === "overall") enhanceOverall(sec);
    else if (title === "scores") enhanceScores(sec);
    else if (title.startsWith("question")) enhanceQuestions(sec);
    else if (title.startsWith("follow-up email")) enhanceEmail(sec, md);
  }

  if (streaming) sections.at(-1)?.classList.add("streaming-caret");
  $("feedback").replaceChildren(...sections.filter((s) => !s.dataset.drop));
}

function enhanceOverall(sec) {
  // Score and outcome are shown in the hero; move the summary there too.
  const summary = [...sec.querySelectorAll("li")].find((li) => !/^(Score|Likely outcome):/i.test(li.textContent.trim()));
  $("summary").textContent = summary?.textContent || sec.querySelector("p")?.textContent || "";
  sec.dataset.drop = "1";
}

function enhanceScores(sec) {
  const ul = sec.querySelector("ul");
  if (!ul) return;
  const rows = [...ul.children].map((li) => {
    const m = li.textContent.match(/^(.+?):\s*([\d.]+)\s*\/\s*10\s*[,—–:-]?\s*(.*)$/s);
    if (!m) return li;
    const [, label, val, why] = m;
    const n = Number(val);
    const row = document.createElement("li");
    row.className = `score-row ${tier(n)}`;
    row.innerHTML = `<span class="label"></span><span class="track"><span class="fill" style="width:${n * 10}%"></span></span>
      <span class="val">${n}/10</span>${why ? `<span class="why"></span>` : ""}`;
    row.querySelector(".label").textContent = label.trim();
    if (why) row.querySelector(".why").textContent = why.trim();
    return row;
  });
  ul.className = "scores";
  ul.replaceChildren(...rows);
}

function enhanceQuestions(sec) {
  const wrap = document.createElement("div");
  wrap.className = "qcards";
  let card = null;
  for (const node of [...sec.children]) {
    if (node.tagName === "H3") continue;
    if (node.tagName === "H4") {
      card = document.createElement("div");
      card.className = "qcard";
      wrap.append(card);
    }
    (card ?? wrap).append(node);
  }
  for (const c of wrap.querySelectorAll(".qcard")) {
    const lis = [...c.querySelectorAll("li")];
    const rating = lis.find((li) => /^Rating:/i.test(li.textContent.trim()));
    if (rating) {
      const r = rating.textContent.replace(/^Rating:\s*/i, "").trim();
      const kind = /^strong/i.test(r) ? "success" : /^weak/i.test(r) ? "danger" : "warn";
      c.querySelector("h4")?.insertAdjacentHTML("beforeend", `<span class="badge badge-${kind}">${esc(r.split(/\s/)[0])}</span>`);
      rating.remove();
    }
    lis.find((li) => /^Stronger answer:/i.test(li.textContent.trim()))?.classList.add("stronger");
  }
  sec.append(wrap);
}

// Uses the raw Markdown so the email keeps its line breaks.
function enhanceEmail(sec, md) {
  const h3 = sec.querySelector("h3");
  const raw = md.split(/^##\s+Follow-up email\s*$/im)[1]?.split(/^##\s/m)[0] ?? "";
  const text = raw.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^\s*>\s?/gm, "").trim();
  const box = document.createElement("div");
  box.className = "email";
  box.textContent = text;
  for (const node of [...sec.children]) if (node !== h3) node.remove();
  const btn = document.createElement("button");
  btn.className = "btn btn-sm";
  btn.innerHTML = `${icon("copy")}<span>Copy email</span>`;
  btn.addEventListener("click", () => copy(text, btn.querySelector("span")));
  h3.append(btn);
  sec.append(box);
}

/* ---------- Generation ---------- */

async function generate() {
  const s = await getSettings();
  if (!aiKey(s)) {
    $("feedback").innerHTML = `<div class="notice notice-warn">${icon("alert")}<span class="grow">${s.keysLocked ? `Your API keys are locked. Enter your passphrase in <a href="options.html">Settings</a>` : `Add your ${providerName(s)} API key in <a href="options.html">Settings</a>`}, then click Regenerate.</span></div>`;
    return;
  }
  generating?.abort();
  setBusy(true);
  let text = "";
  let frame = 0;
  $("feedback").innerHTML = `<div class="loading"><span class="spinner"></span>Reviewing the interview and writing your feedback…</div>`;
  try {
    const stream = streamFeedback(s, record);
    generating = stream;
    stream.on("text", (delta) => {
      text += delta;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => renderFeedback(text, true));
    });
    const final = await stream.finalMessage();
    cancelAnimationFrame(frame);
    if (final.stop_reason === "refusal") throw new Error("The model declined to write feedback.");
    record.feedback = text;
    await updateRecord(record.id, { feedback: text });
    renderFeedback(text);
    flash("Saved");
  } catch (e) {
    if (e?.name === "APIUserAbortError") return;
    if (text) renderFeedback(text);
    $("feedback").insertAdjacentHTML("beforeend",
      `<div class="notice notice-error">${icon("alert")}<span class="grow">Feedback failed: ${esc(e.message)}</span></div>`);
  } finally {
    generating = null;
    setBusy(false);
  }
}

function setBusy(busy) {
  $("regen").disabled = busy;
  $("copy").disabled = busy;
}

function flash(text) {
  $("msg").textContent = text;
  setTimeout(() => { if ($("msg").textContent === text) $("msg").textContent = ""; }, 2000);
}

async function copy(text, labelEl) {
  await navigator.clipboard.writeText(text);
  if (!labelEl) return flash("Copied");
  const prev = labelEl.textContent;
  labelEl.textContent = "Copied";
  setTimeout(() => (labelEl.textContent = prev), 1400);
}

/* ---------- Controls ---------- */

document.querySelectorAll(".seg-tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".seg-tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${t.dataset.view}`));
}));

// One Markdown file with everything: feedback, live insights and the timestamped transcript.
function download() {
  const t0 = record.transcript[0]?.t ?? record.startedAt;
  const md = [
    `# ${record.title}`,
    `${fmtDate(record.startedAt)} · ${fmtDuration(record.endedAt - record.startedAt)}`,
    record.feedback || "_No feedback generated yet._",
    record.insights && `## Live insights\n\n${record.insights}`,
    `## Transcript\n\n${record.transcript.map((u) => `**${clock(u.t - t0)} ${speakerLabel(u.speaker, record.mode)}:** ${u.text}`).join("\n\n")}`,
  ].filter(Boolean).join("\n\n");
  const slug = record.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "interview";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([`${md}\n`], { type: "text/markdown" }));
  a.download = `${slug}-${new Date(record.startedAt).toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash("Downloaded");
}

$("regen").addEventListener("click", generate);
$("copy").addEventListener("click", () => copy(record.feedback));
$("download").addEventListener("click", download);
$("print").addEventListener("click", () => window.print());

twoStep($("del"), "Click again to delete", async () => {
  generating?.abort();
  await deleteRecord(record.id);
  location.href = "report.html";
});
