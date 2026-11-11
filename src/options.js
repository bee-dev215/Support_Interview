import { DEFAULTS, KEY_FIELDS, MODELS, OPENAI_MODELS, PROVIDERS, aiKey, getSettings, isFree, providerName } from "./lib/settings.js";
import { hasPassphrase, isUnlocked, lock, needsPassphrase, resetPassphrase, seal, setPassphrase, unlock } from "./lib/vault.js";
import { analyzeCv, analyzeTopic, checkAiKey, researchEmployers, researchJob } from "./lib/claude.js";
import { checkDeepgram } from "./lib/deepgram.js";
import { icon } from "./lib/icons.js";
import { getShortcuts, keyCaps, openShortcutSettings } from "./lib/shortcuts.js";

const $ = (id) => document.getElementById(id);
const RADIOS = ["provider", "model", "openaiModel", "answerLength", "theme", "mode"];
// Settings with a control on this page (the free conversation's internal game plan has none).
const FIELDS = Object.keys(DEFAULTS).filter((k) => !RADIOS.includes(k) && $(k));

const MODEL_INFO = {
  "claude-opus-5-5": { name: "Opus 5.5", tag: "Recommended", desc: "Best reasoning and answer quality.", speed: 2, quality: 3 },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", tag: "", desc: "Strong answers, quicker responses.", speed: 3, quality: 2 },
  "claude-haiku-5-5": { name: "Haiku 5.5", tag: "Cheapest", desc: "Fastest first words, lowest cost.", speed: 4, quality: 1 },
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", tag: "Recommended", desc: "OpenAI's flagship: best answer quality.", speed: 2, quality: 3 },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", tag: "", desc: "Strong answers at lower cost.", speed: 3, quality: 2 },
  "gpt-6-luna": { name: "GPT-6 Luna", tag: "Cheapest", desc: "Fastest first words, lowest cost.", speed: 4, quality: 1 },
};
const bars = (n, max) => `<span class="bar">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`;

/* ---------- Model cards ---------- */

const modelCards = (models, field) => models.map(({ id }) => {
  const m = MODEL_INFO[id];
  return `<label class="model">
    <input type="radio" name="${field}" value="${id}">
    <span class="name">${m.name}${m.tag ? `<span class="badge ${m.tag === "Recommended" ? "badge-accent" : ""}">${m.tag}</span>` : ""}</span>
    <span class="desc">${m.desc}</span>
    <span class="meters"><span>Speed${bars(m.speed, 4)}</span><span>Quality${bars(m.quality, 3)}</span></span>
  </label>`;
}).join("");
$("models").innerHTML = modelCards(MODELS, "model");
$("openaiModels").innerHTML = modelCards(OPENAI_MODELS, "openaiModel");

/* ---------- Load ---------- */

const s = await getSettings();
// Decrypted keys live only in this page's memory; inputs show ciphertext once the keys are locked.
const secret = Object.fromEntries(KEY_FIELDS.map((k) => [k, s[k]]));
let sealed = false; // true while the key fields are locked and show ciphertext
let locked = s.keysLocked; // passphrase not entered since Chrome started
let sealing = false;
const sealed64 = {}; // field -> ciphertext shown while locked
const hasUnsaved = () => !sealed && KEY_FIELDS.some((k) => typed(k));
// Saved before passphrases existed: encrypted with this device's key only.
const weakKeys = () => KEY_FIELDS.some((k) => secret[k] && needsPassphrase(sealed64[k]));
for (const k of FIELDS) {
  if (KEY_FIELDS.includes(k)) continue;
  if ($(k).type === "checkbox") $(k).checked = s[k];
  else $(k).value = s[k];
}
for (const k of RADIOS) {
  (document.querySelector(`input[name=${k}][value="${s[k]}"]`) ?? document.querySelector(`input[name=${k}]`)).checked = true;
}
if (![...$("language").options].some((o) => o.value === s.language)) $("language").add(new Option(s.language, s.language));
$("language").value = s.language;
// Microphones are only listed once access is granted; keep the saved choice selected until then.
if (s.micDeviceId) {
  $("micDeviceId").add(new Option("Saved microphone", s.micDeviceId));
  $("micDeviceId").value = s.micDeviceId;
}

// Settings as the page uses them. A key field gives the key being typed, else the saved (decrypted) key.
function readForm() {
  const out = Object.fromEntries(FIELDS.map((k) => [k, $(k).type === "checkbox" ? $(k).checked : $(k).value.trim()]));
  for (const k of RADIOS) out[k] = document.querySelector(`input[name=${k}]:checked`).value;
  for (const k of KEY_FIELDS) out[k] = (!sealed && typed(k)) || secret[k];
  return out;
}
const typed = (k) => $(k).value.trim();
// What autosave writes: never the keys, which are stored only encrypted by the lock button.
function storedForm() {
  const out = readForm();
  for (const k of KEY_FIELDS) delete out[k];
  return out;
}

/* ---------- Provider ---------- */

// Shows only the key field and model cards of the selected provider.
function showProvider() {
  const f = readForm();
  document.querySelectorAll("[data-provider]").forEach((el) => (el.hidden = el.dataset.provider !== f.provider));
  $("aiCheckLabel").textContent = `${providerName(f)} API key`;
}
document.querySelectorAll("input[name=provider]").forEach((r) => r.addEventListener("change", showProvider));
showProvider();

/* ---------- Mode: company interview or free conversation ---------- */

// Shows the job description for an interview, or the topic and game plan for a free conversation.
function showMode() {
  const { mode } = readForm();
  document.querySelectorAll("[data-mode]").forEach((el) => (el.hidden = el.dataset.mode !== mode));
  $("jobCheckLabel").textContent = isFree(mode) ? "Your topic" : "Job description";
  $("conversationStep").textContent = isFree(mode) ? "4" : "5"; // the CV step is hidden in free mode
  updateChecks();
}
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", showMode));

/* ---------- Autosave ---------- */

// Text fields save after a pause in typing; switches and choices save at once (theme applies live).
let saveTimer;
function scheduleSave(delay = 450) {
  $("saveState").className = "save-state";
  $("saveState").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
  updateChecks();
}
async function saveNow() {
  clearTimeout(saveTimer);
  await chrome.storage.local.set(storedForm());
  $("saveState").className = "save-state ok";
  $("saveState").innerHTML = `${icon("check")}All changes saved`;
}
const onEdit = (e) => {
  if (!e.target.closest(".sections") || e.target.id === "cvFile") return;
  if (e.target.closest("#vault")) return; // the passphrase is never saved
  if (KEY_FIELDS.includes(e.target.id)) return updateChecks(); // saved only by the lock button
  scheduleSave(e.target.matches("[type=radio], [type=checkbox]") ? 0 : 450);
};
document.addEventListener("input", onEdit);
document.addEventListener("change", onEdit);
window.addEventListener("beforeunload", () => { if ($("saveState").textContent === "Saving…") chrome.storage.local.set(storedForm()); });

// Auto-answer, Proactive and Nice are also toggled from the side panel; keep this form current so a later save doesn't undo them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of ["autoAnswer", "proactive", "nice"]) if (changes[k]) $(k).checked = changes[k].newValue;
  // The panel's mode button switches it too.
  if (changes.mode) {
    const r = document.querySelector(`input[name=mode][value="${changes.mode.newValue}"]`);
    if (r && !r.checked) {
      r.checked = true;
      showMode();
    }
  }
});

/* ---------- Key checks ---------- */

// Each key is checked with one read-only request when the page opens, after it's edited, and on "Test keys".
const keyState = {}; // field -> "checking" | "ok" | "warn" | "bad"
const keySeq = {};
const keyTimers = {};

async function verifyKey(field) {
  const f = readForm();
  const seq = (keySeq[field] = (keySeq[field] ?? 0) + 1);
  if (!f[field]) return setKeyStatus(field, null);
  setKeyStatus(field, { state: "checking", text: "Checking key…" });
  const result = field === "deepgramKey"
    ? await checkDeepgram(f.deepgramKey)
    : await checkAiKey({ ...f, provider: field === "openaiKey" ? "openai" : "anthropic" });
  if (seq === keySeq[field]) setKeyStatus(field, result); // ignore answers to superseded checks
}

function setKeyStatus(field, result) {
  const el = $(`${field}Status`);
  keyState[field] = result?.state;
  el.className = `field-hint key-status${result ? ` is-${result.state}` : ""}`;
  if (!result) el.textContent = el.dataset.hint;
  else {
    el.innerHTML = `${result.state === "checking" ? `<span class="spinner"></span>` : icon(result.state === "ok" ? "check" : "alert")}<span></span>`;
    el.querySelector("span:last-child").textContent = result.text;
  }
  updateChecks();
}

const selectedKeyField = () => PROVIDERS[readForm().provider].keyField;
for (const field of ["anthropicKey", "openaiKey", "deepgramKey"]) {
  $(field).addEventListener("input", () => {
    clearTimeout(keyTimers[field]);
    keyTimers[field] = setTimeout(() => verifyKey(field), 700);
  });
}
document.querySelectorAll("input[name=provider], input[name=model], input[name=openaiModel]").forEach((r) =>
  r.addEventListener("change", () => verifyKey(selectedKeyField())));
$("testKeys").addEventListener("click", () => {
  for (const field of ["anthropicKey", "openaiKey", "deepgramKey"]) if (readForm()[field]) verifyKey(field);
});

/* ---------- Key encryption ---------- */

// Red button: keys aren't fully protected yet (typed but not saved, or saved by an older version without the
// passphrase layer). Clicking it encrypts them with your passphrase and this device's key (see lib/vault.js), stores
// only the ciphertext, shows the ciphertext in the fields and turns green. The first time, it asks you to create the
// passphrase.
// Green button: clicking it opens the fields for new keys. Saved keys are never shown again; a field left empty
// keeps its saved key. While locked (after Chrome restarts) it asks for the passphrase instead.

function paintSealButton() {
  const b = $("sealKeys");
  b.classList.toggle("is-sealed", sealed);
  b.classList.toggle("is-busy", sealing);
  b.setAttribute("aria-pressed", String(sealed));
  b.innerHTML = icon(sealed ? "lock" : "unlock");
  b.title = !sealed ? "Keys are not protected yet. Click to encrypt and save them with your passphrase."
    : locked ? "Keys are encrypted and locked. Click to unlock them with your passphrase."
    : "Keys are encrypted with your passphrase. Click to enter new keys.";
  b.setAttribute("aria-label", b.title);
}

function showSealed() {
  sealed = true;
  for (const k of KEY_FIELDS) {
    const input = $(k);
    input.type = "text";
    input.readOnly = true;
    input.classList.add("sealed");
    input.value = sealed64[k] ?? "";
    input.placeholder = "No key saved";
  }
  paintSealButton();
  paintVaultStatus();
  updateChecks();
}

function showUnsealed() {
  sealed = false;
  for (const k of KEY_FIELDS) {
    const input = $(k);
    input.type = "password";
    input.readOnly = false;
    input.classList.remove("sealed");
    input.value = "";
    input.placeholder = secret[k] ? "Encrypted key saved · type a new one to replace it" : input.dataset.placeholder;
  }
  document.querySelectorAll(".reveal").forEach((b) => b.dispatchEvent(new Event("repaint")));
  paintSealButton();
  paintVaultStatus();
  updateChecks();
}

// Keys to (re-)encrypt: everything typed, plus saved keys that still lack the passphrase layer.
const toSeal = () => KEY_FIELDS.filter((k) => typed(k) || (secret[k] && needsPassphrase(sealed64[k])));

async function sealKeys() {
  sealing = true;
  paintSealButton();
  try {
    const fields = toSeal();
    const out = {};
    for (const k of fields) out[k] = await seal(k, typed(k) || secret[k]);
    if (fields.length) await chrome.storage.local.set(out);
    for (const k of fields) secret[k] = typed(k) || secret[k];
    Object.assign(sealed64, out);
    showSealed();
    $("saveState").className = "save-state ok";
    $("saveState").innerHTML = `${icon("check")}Keys encrypted and saved`;
  } catch (err) {
    $("saveState").className = "save-state";
    $("saveState").textContent = `Encryption failed: ${err.message}`;
  } finally {
    sealing = false;
    paintSealButton();
  }
}

$("sealKeys").addEventListener("click", async () => {
  if (sealing) return;
  if (sealed) {
    if (locked) return openVault("unlock");
    showUnsealed();
    $(selectedKeyField()).focus();
    return;
  }
  if (!toSeal().length) {
    if (!KEY_FIELDS.some((k) => secret[k])) return $(selectedKeyField()).focus(); // nothing to encrypt yet
    return showSealed(); // nothing new typed: keep the saved keys
  }
  if (!(await hasPassphrase())) return openVault("setup");
  if (!(await isUnlocked())) return openVault("unlock");
  sealKeys();
});

// Enter in a key field locks the keys too.
for (const k of KEY_FIELDS) {
  $(k).dataset.placeholder = $(k).placeholder;
  $(k).addEventListener("keydown", (e) => { if (e.key === "Enter" && !sealed) $("sealKeys").click(); });
  // Nothing in a key field can be copied, cut or dragged out.
  for (const ev of ["copy", "cut", "dragstart"]) $(k).addEventListener(ev, (e) => e.preventDefault());
}

/* ---------- Passphrase ---------- */

let vaultMode = null; // "setup" | "unlock" | null
const MIN_PASSPHRASE = 10;

function vaultMsg(text, kind = "") {
  $("vaultMsg").className = `field-hint key-status${kind ? ` is-${kind}` : ""}`;
  $("vaultMsg").innerHTML = text ? `${icon(kind === "ok" ? "check" : kind ? "alert" : "info")}<span></span>` : "";
  if (text) $("vaultMsg").querySelector("span").textContent = text;
}

function openVault(mode) {
  vaultMode = mode;
  const setup = mode === "setup";
  $("vault").hidden = false;
  $("vaultTitle").textContent = setup ? "Create a passphrase" : "Unlock your API keys";
  $("vaultText").textContent = setup
    ? `Your keys are encrypted with this passphrase. Chrome asks for it again after every restart, so anyone who opens this browser later can't use or copy your keys. At least ${MIN_PASSPHRASE} characters. It can't be recovered: if you forget it you'll enter your API keys again.`
    : "Your keys are encrypted. Enter your passphrase to use them until Chrome closes.";
  $("pass2").hidden = !setup;
  $("pass1").autocomplete = setup ? "new-password" : "current-password";
  $("vaultSubmit").textContent = setup ? "Encrypt keys" : "Unlock";
  $("vaultReset").hidden = setup;
  $("vaultCancel").hidden = !setup;
  $("pass1").value = $("pass2").value = "";
  vaultMsg("");
  $("pass1").focus();
}
function closeVault() {
  vaultMode = null;
  $("vault").hidden = true;
  $("pass1").value = $("pass2").value = "";
}

$("vaultForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pass = $("pass1").value;
  if (vaultMode === "setup") {
    if (pass.length < MIN_PASSPHRASE) return vaultMsg(`Use at least ${MIN_PASSPHRASE} characters.`, "bad");
    if (pass !== $("pass2").value) return vaultMsg("The two passphrases don't match.", "bad");
  } else if (!pass) return vaultMsg("Enter your passphrase.", "bad");

  $("vaultSubmit").disabled = true;
  vaultMsg(vaultMode === "setup" ? "Encrypting…" : "Checking passphrase…");
  try {
    if (vaultMode === "setup") {
      await setPassphrase(pass);
      closeVault();
      await sealKeys();
      return;
    }
    if (!(await unlock(pass))) {
      $("pass1").select();
      return vaultMsg("Wrong passphrase.", "bad");
    }
    // Decrypt the saved keys (getSettings also upgrades older records), then carry on where the user was.
    const fresh = await getSettings();
    for (const k of KEY_FIELDS) secret[k] = fresh[k];
    Object.assign(sealed64, await chrome.storage.local.get(KEY_FIELDS));
    locked = false;
    closeVault();
    if (!sealed && toSeal().length) await sealKeys();
    else showSealed();
    verifyKey("deepgramKey");
    verifyKey(selectedKeyField());
  } catch (err) {
    vaultMsg(`Failed: ${err.message}`, "bad");
  } finally {
    $("vaultSubmit").disabled = false;
  }
});

$("vaultCancel").addEventListener("click", closeVault);

$("vaultReset").addEventListener("click", async () => {
  if (!confirm("Forgot your passphrase? Your saved API keys can't be decrypted without it, so they'll be deleted and you'll enter them again. Continue?")) return;
  await resetPassphrase();
  await chrome.storage.local.remove(KEY_FIELDS);
  for (const k of KEY_FIELDS) {
    secret[k] = "";
    delete sealed64[k];
    setKeyStatus(k, null);
  }
  locked = false;
  closeVault();
  showUnsealed();
  $(selectedKeyField()).focus();
});

// Under the keys: says they're protected and unlocked, with a way to lock them now.
async function paintVaultStatus() {
  const show = sealed && !locked && KEY_FIELDS.some((k) => secret[k]) && (await hasPassphrase());
  $("vaultStatus").hidden = !show;
}
$("lockNow").addEventListener("click", async () => {
  await lock();
  for (const k of KEY_FIELDS) {
    secret[k] = "";
    setKeyStatus(k, null);
  }
  locked = true;
  showSealed();
  openVault("unlock");
});

// Show the stored ciphertext. Saved, fully protected keys are locked straight away (green); locked keys ask for the
// passphrase; anything else waits for the red button.
Object.assign(sealed64, Object.fromEntries(Object.entries(await chrome.storage.local.get(KEY_FIELDS)).filter(([, v]) => v)));
if (locked) {
  showSealed();
  openVault("unlock");
} else if (KEY_FIELDS.some((k) => secret[k]) && !weakKeys()) showSealed();
else showUnsealed();
window.addEventListener("beforeunload", (e) => { if (hasUnsaved()) e.preventDefault(); });

/* ---------- Key reveal ---------- */

document.querySelectorAll(".reveal").forEach((b) => {
  const input = $(b.dataset.for);
  const paint = () => (b.innerHTML = icon(input.type === "password" ? "eye" : "eyeOff"));
  paint();
  b.addEventListener("repaint", paint);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    if (input.readOnly) return;
    input.type = input.type === "password" ? "text" : "password";
    paint();
  });
});

/* ---------- Microphone ---------- */

let micGranted = false;
async function showMicState() {
  try {
    const { state } = await navigator.permissions.query({ name: "microphone" });
    micGranted = state === "granted";
  } catch { micGranted = false; }
  $("micBadge").className = `badge ${micGranted ? "badge-success" : "badge-warn"}`;
  $("micBadge").innerHTML = `<span class="dot"></span>${micGranted ? "Access granted" : "Not granted"}`;
  $("enableMic").hidden = micGranted;
  updateChecks();
  if (micGranted) listMics();
}

// Device names are only visible after access is granted. A saved mic that's unplugged stays listed.
async function listMics() {
  const select = $("micDeviceId");
  const current = select.value;
  const mics = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  const opts = [new Option("System default", ""), ...mics.map((d) => new Option(d.label || "Microphone", d.deviceId))];
  if (current && !mics.some((d) => d.deviceId === current)) opts.push(new Option("Saved microphone (not connected)", current));
  select.replaceChildren(...opts);
  select.value = current;
}
navigator.mediaDevices.addEventListener("devicechange", () => { if (micGranted) listMics(); });
$("enableMic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    $("micBadge").className = "badge badge-danger";
    $("micBadge").innerHTML = `<span class="dot"></span>Blocked (${e.name}). Allow it from the address bar.`;
    return;
  }
  showMicState();
});

/* ---------- CV upload & analysis ---------- */

let cvFile = null;
function setFile(file) {
  if (!file) return;
  cvFile = file;
  $("drop").classList.add("has-file");
  $("dropText").innerHTML = `<b></b><br><span class="muted small">${(file.size / 1024).toFixed(0)} KB · click to choose another file</span>`;
  $("dropText").querySelector("b").textContent = file.name;
  $("analyze").disabled = false;
}
$("cvFile").addEventListener("change", (e) => setFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); }));
$("drop").addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

function analyzeNotice(kind, html) {
  $("analyzeNotice").hidden = !html;
  $("analyzeNotice").innerHTML = html ? `<div class="notice ${kind}">${icon(kind === "notice-error" ? "alert" : kind === "notice-success" ? "check" : "info")}<span class="grow">${html}</span></div>` : "";
}

$("analyze").addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation(); // don't reopen the file picker
  const settings = readForm();
  if (!aiKey(settings)) return analyzeNotice("notice-warn", `Add your ${providerName(settings)} API key in step 1 first.`);
  if (!cvFile) return;

  $("analyze").disabled = true;
  $("analyze").textContent = "Analyzing…";
  analyzeNotice("", "Reading your CV and building your profile. This usually takes under a minute.");
  try {
    $("profile").value = await analyzeCv(settings, cvFile);
    // Briefs from a previous CV would describe the wrong companies: clear them before researching this one.
    $("employers").value = "";
    updateEmployerStats();
    await saveNow();
    updateChecks();
    analyzeNotice("notice-success", "Profile ready and saved. Review it below and correct anything that's off. Now researching your previous employers…");
  } catch (err) {
    return analyzeNotice("notice-error", `Analysis failed: ${err.message.replace(/</g, "&lt;")}`);
  } finally {
    $("analyze").disabled = false;
    $("analyze").textContent = "Analyze CV";
  }
  // Every new CV gets its employers researched right away.
  research();
});

// Web research on each previous employer in the profile, saved with the other settings.
function researchNotice(kind, html) {
  $("researchNotice").hidden = !html;
  $("researchNotice").innerHTML = html ? `<div class="notice ${kind}">${icon(kind === "notice-error" ? "alert" : kind === "notice-success" ? "check" : "info")}<span class="grow">${html}</span></div>` : "";
}

// Runs after every Analyze CV, and again from the Research employers button.
let researching = false;
async function research() {
  if (researching) return;
  const settings = readForm();
  if (!aiKey(settings)) return researchNotice("notice-warn", `Add your ${providerName(settings)} API key in step 1 first.`);
  if (!settings.profile) return researchNotice("notice-warn", "Analyze your CV first: the research covers the companies in your profile.");

  researching = true;
  $("research").disabled = true;
  $("research").textContent = "Researching…";
  researchNotice("", "Searching the web for each of your previous employers. This can take a few minutes; keep this page open.");
  try {
    $("employers").value = await researchEmployers(settings, settings.profile);
    await saveNow();
    updateEmployerStats();
    researchNotice("notice-success", "Research ready and saved. Read it before the interview and fix anything that's wrong.");
  } catch (err) {
    researchNotice("notice-error", `Research failed: ${err.message.replace(/</g, "&lt;")}`);
  } finally {
    researching = false;
    $("research").disabled = false;
    $("research").textContent = "Research employers";
  }
}
$("research").addEventListener("click", research);

function updateEmployerStats() {
  const companies = ($("employers").value.match(/^## (?!Sources)/gm) ?? []).length;
  $("employersStats").textContent = companies ? `${companies} ${companies === 1 ? "company" : "companies"}` : "";
}
$("employers").addEventListener("input", updateEmployerStats);
updateEmployerStats();

/* ---------- Target company: web research and job analysis ---------- */

// The brief is used only while the job description is the one it was made from; this line says whether it is.
let researchedJob = (await chrome.storage.local.get("jobBriefFor")).jobBriefFor ?? "";
let researchingJob = false;
function showJobState() {
  const job = $("jobDesc").value.trim();
  const brief = $("jobBrief").value.trim();
  const ready = job && brief && job === researchedJob.trim();
  $("jobState").hidden = !job || researchingJob;
  $("jobState").className = `field-hint key-status${ready ? " is-ok" : brief ? " is-warn" : ""}`;
  $("jobState").innerHTML = ready
    ? `${icon("check")}<span>Researched: answers use the company research below.</span>`
    : brief
      ? `${icon("alert")}<span>The job description changed since the research, so it isn't used. Click <b>Research company</b> again.</span>`
      : `${icon("info")}<span>Not researched yet. Click <b>Research company</b> when the job description is complete.</span>`;
  const sections = (brief.match(/^## (?!Sources)/gm) ?? []).length;
  $("jobBriefStats").textContent = brief ? `${sections} sections · ${brief.split(/\s+/).length.toLocaleString()} words` : "";
}

function jobNotice(kind, html) {
  $("jobNotice").hidden = !html;
  $("jobNotice").innerHTML = html ? `<div class="notice ${kind}">${icon(kind === "notice-error" ? "alert" : kind === "notice-success" ? "check" : "info")}<span class="grow">${html}</span></div>` : "";
}

$("researchJob").addEventListener("click", async () => {
  if (researchingJob) return;
  const settings = readForm();
  const job = settings.jobDesc;
  if (!job) return jobNotice("notice-warn", "Paste the company and job description first.");
  if (!aiKey(settings)) return jobNotice("notice-warn", `Add your ${providerName(settings)} API key in step 1 first.`);

  researchingJob = true;
  $("researchJob").disabled = true;
  $("researchJob").textContent = "Researching…";
  jobNotice("", `Searching the web for the company and analyzing the role${settings.profile ? " against your profile" : ""}. This takes a few minutes; keep this page open.${settings.profile ? "" : " Add your CV in step 4 first for a fit analysis and tailored answers."}`);
  showJobState();
  try {
    const brief = await researchJob(settings, job, settings.profile);
    $("jobBrief").value = brief;
    await saveNow();
    await chrome.storage.local.set({ jobBriefFor: job });
    researchedJob = job;
    jobNotice("notice-success", "Company research ready and saved. Read it before the interview and fix anything that's wrong.");
  } catch (err) {
    jobNotice("notice-error", `Research failed: ${err.message.replace(/</g, "&lt;")}`);
  } finally {
    researchingJob = false;
    $("researchJob").disabled = false;
    $("researchJob").textContent = "Research company";
    showJobState();
  }
});
$("jobDesc").addEventListener("input", showJobState);
$("jobBrief").addEventListener("input", showJobState);
showJobState();

/* ---------- Free conversation: topic analysis ---------- */

// The Analyze topic button turns the topic into an internal game plan. This line says whether the plan matches
// the text in the box; until it does, replies work from the topic text itself.
let plannedTopic = (await chrome.storage.local.get("freePlanTopic")).freePlanTopic ?? "";
let analyzingTopic = false;
function showTopicState() {
  const topic = $("freeTopic").value.trim();
  const ready = topic && topic === plannedTopic;
  $("topicState").hidden = !topic || analyzingTopic;
  $("topicState").className = `field-hint key-status${ready ? " is-ok" : ""}`;
  $("topicState").innerHTML = ready
    ? `${icon("check")}<span>Understood: your goal, reasons, likely objections and questions are ready for the call.</span>`
    : `${icon("info")}<span>Not analyzed yet. Click <b>Analyze topic</b> when you're done writing.</span>`;
}

function topicNotice(kind, html) {
  $("topicNotice").hidden = !html;
  $("topicNotice").innerHTML = html ? `<div class="notice ${kind}">${icon(kind === "notice-error" ? "alert" : kind === "notice-success" ? "check" : "info")}<span class="grow">${html}</span></div>` : "";
}

$("analyzeTopic").addEventListener("click", async () => {
  if (analyzingTopic) return;
  const settings = readForm();
  const topic = settings.freeTopic;
  if (!topic) return topicNotice("notice-warn", "Write your topic first.");
  if (!aiKey(settings)) return topicNotice("notice-warn", `Add your ${providerName(settings)} API key in step 1 first.`);

  analyzingTopic = true;
  $("analyzeTopic").disabled = true;
  $("analyzeTopic").textContent = "Analyzing…";
  topicNotice("", `Working out your goal, reasons and likely objections. This usually takes under a minute.`);
  showTopicState();
  try {
    const plan = await analyzeTopic(settings, topic);
    await saveNow();
    await chrome.storage.local.set({ freePlan: plan, freePlanTopic: topic });
    topicNotice("", "");
  } catch (err) {
    topicNotice("notice-error", `Analysis failed: ${err.message.replace(/</g, "&lt;")}`);
  } finally {
    analyzingTopic = false;
    $("analyzeTopic").disabled = false;
    $("analyzeTopic").textContent = "Analyze topic";
    showTopicState();
  }
});
$("freeTopic").addEventListener("input", showTopicState);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.freePlanTopic) return;
  plannedTopic = changes.freePlanTopic.newValue ?? "";
  showTopicState();
});
showTopicState();

/* ---------- Readiness ---------- */

function updateChecks() {
  const f = readForm();
  const aiField = PROVIDERS[f.provider].keyField;
  const bad = { ai: keyState[aiField] === "bad", deepgram: keyState.deepgramKey === "bad" };
  const state = {
    ai: !!secret[aiField] && !bad.ai,
    deepgram: !!secret.deepgramKey && !bad.deepgram,
    mic: !f.captureMic || micGranted,
    profile: !!f.profile,
    job: isFree(f.mode) ? !!f.freeTopic : !!f.jobDesc,
  };
  for (const [k, ok] of Object.entries(state)) {
    const li = document.querySelector(`[data-check="${k}"]`);
    li.classList.toggle("ok", ok);
    li.classList.toggle("bad", !!bad[k]);
  }
  document.querySelector('[data-check="job"]').classList.add("optional");
  const required = state.ai && state.deepgram && state.mic;
  $("readyText").textContent = bad.ai || bad.deepgram
    ? "A key was rejected. Fix it in step 1."
    : locked ? "Your API keys are locked. Enter your passphrase in step 1."
    : hasUnsaved() ? "Click the red button in step 1 to encrypt and save your keys."
    : weakKeys() ? "Click the red button in step 1 to protect your saved keys with a passphrase."
    : !required ? "Complete the API keys and microphone to start."
    : isFree(f.mode) && !f.freeTopic ? "Ready, but write your topic in step 4 so replies steer toward your view."
    : !isFree(f.mode) && !state.profile ? "Ready, but add your CV for personalized answers."
    : "All set. Open your call and click the extension icon.";

  const words = f.profile ? f.profile.split(/\s+/).length : 0;
  $("profileStats").textContent = words ? `${words.toLocaleString()} words` : "";
}

/* ---------- Keyboard shortcuts ---------- */

async function renderShortcuts() {
  const list = await getShortcuts();
  $("shortcutList").replaceChildren(...list.flatMap(({ shortcut, description }) => {
    const dt = document.createElement("dt");
    dt.innerHTML = shortcut ? keyCaps(shortcut) : `<span class="muted small">Not set</span>`;
    const dd = document.createElement("dd");
    dd.textContent = description;
    return [dt, dd];
  }));
}
$("customizeKeys").addEventListener("click", openShortcutSettings);
window.addEventListener("focus", renderShortcuts); // pick up changes made on chrome://extensions/shortcuts

showMicState();
renderShortcuts();
showMode();
verifyKey("deepgramKey");
verifyKey(selectedKeyField());
