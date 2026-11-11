import { isSealed, isUnlocked, needsPassphrase, seal, sealDeviceOnly, unseal } from "./vault.js";

export const DEFAULTS = {
  provider: "anthropic",
  anthropicKey: "",
  openaiKey: "",
  deepgramKey: "",
  model: "claude-opus-5-5",
  openaiModel: "gpt-6.1-sol",
  language: "en",
  captureMic: true,
  micDeviceId: "", // "" = the system default microphone
  autoAnswer: true,
  proactive: true,
  answerLength: "standard",
  readingGuide: true,
  nice: false, // weave friendly compliments to the interviewer into replies
  showPhoto: true, // show the lines prepared from an uploaded photo of the interviewer
  theme: "system",
  profile: "",
  employers: "", // researched briefs on each previous employer (Markdown)
  projects: "", // real project details the CV leaves out (numbers, bugs, decisions), written by the candidate
  // Marriage, family and everyday life, written by the candidate. Pre-filled so it works out of the box; edit it in Options.
  personal: "Married to Anna since 2019, daughter Mia (4). Weekends: hiking, cooking Vietnamese food.",
  jobDesc: "",
  mode: "company", // "company": a job interview; "free": a free conversation where you bring the other person round to your view
  // Free conversation: everything about it in one box (topic, your intention and point of view, questions to ask).
  freeTopic: "",
  freePlan: "", // internal game plan the background derives from freeTopic; not shown in Options
  freePlanTopic: "", // the freeTopic text that freePlan was made from (stale when they differ)
};

export const PROVIDERS = {
  anthropic: { name: "Anthropic", keyField: "anthropicKey" },
  openai: { name: "OpenAI", keyField: "openaiKey" },
};

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];

export const OPENAI_MODELS = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (best quality)" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra (balanced)" },
  { id: "gpt-6-luna", label: "GPT-6 Luna (fastest, cheapest)" },
];

export const SPEAKER_LABEL = { interviewer: "Interviewer", me: "Me" };
// In a free conversation the other side isn't interviewing you: their lines read "Them".
const FREE_LABEL = { interviewer: "Them", me: "Me" };
export const isFree = (mode) => mode === "free";
export const speakerLabel = (speaker, mode) => (isFree(mode) ? FREE_LABEL : SPEAKER_LABEL)[speaker];

// Fields that fall back to their default when left empty, not only when never saved (Options saves every field,
// so an untouched one is stored as "").
const FILLED = ["personal"];

// API keys are stored only as ciphertext (see vault.js); getSettings hands out the decrypted keys. While the
// passphrase is locked they come back empty and keysLocked is true.
export const KEY_FIELDS = ["anthropicKey", "openaiKey", "deepgramKey"];

export async function getSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  for (const k of FILLED) if (!s[k]?.trim()) s[k] = DEFAULTS[k];
  s.keysLocked = false;
  const upgrade = {};
  for (const k of KEY_FIELDS) {
    const stored = s[k];
    if (!stored) continue;
    if (isSealed(stored)) {
      try { s[k] = await unseal(k, stored); } catch (e) {
        s[k] = ""; // vault data lost (site data cleared): the key must be entered again
        if (e.locked) s.keysLocked = true;
        continue;
      }
    }
    // Older records gain the passphrase layer once unlocked; plain text is never left as it is.
    if (needsPassphrase(stored) && (await isUnlocked())) upgrade[k] = await seal(k, s[k]);
    else if (!isSealed(stored)) upgrade[k] = await seal(k, s[k]).catch(() => sealDeviceOnly(k, s[k]));
  }
  if (Object.keys(upgrade).length) await chrome.storage.local.set(upgrade);
  return s;
}

const provider = (s) => PROVIDERS[s.provider] ?? PROVIDERS.anthropic;
export const providerName = (s) => provider(s).name;
// API key of the provider selected in Options.
export const aiKey = (s) => s[provider(s).keyField];
