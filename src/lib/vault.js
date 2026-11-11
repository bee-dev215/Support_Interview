// Encrypts API keys at rest. Only ciphertext is ever written to chrome.storage.local or shown on screen.
//
// Every saved key ("siv2" record) is encrypted twice, inner layer first:
//  1. Passphrase layer: PBKDF2-HMAC-SHA-256 (600,000 iterations, random 256-bit salt) turns your passphrase into
//     256 bits. Nothing about the passphrase is stored, only a check record that decrypts with the right one.
//  2. Device layer: a random 256-bit root key held as a NON-EXTRACTABLE WebCrypto key in this extension's IndexedDB.
//     Scripts can use it but never read its bytes, so the records can't be decrypted in another browser or profile.
// Within each layer, every encryption draws a fresh 256-bit salt and derives a one-off AES-256-GCM key with
// HKDF-SHA-256, bound to the layer and field name. AES-GCM authenticates the field name and format version as
// additional data, so a record moved to another field or tampered with fails to decrypt. Plaintext is padded with
// random bytes to a multiple of 256 bytes, so a record doesn't reveal which provider's key it holds or how long it is.
//
// Unlocking keeps the passphrase-derived bits in chrome.storage.session: in memory, out of reach of content scripts,
// and wiped when Chrome closes, so the passphrase is asked again after every browser restart.
//
// "siv1" records (device layer only) come from the version before passphrases; they are re-encrypted as siv2 once
// a passphrase is set and unlocked.

const V1 = "siv1"; // device layer only
const V2 = "siv2"; // outer device layer of a passphrase-protected record
const PASS = "sivp"; // inner passphrase layer
const DB_NAME = "support-interview-vault";
const STORE = "keys";
const ROOT_ID = "root-v1";
const BLOCK = 256;
const ITERATIONS = 600_000;
const META = "vault"; // chrome.storage.local: { salt, iterations, check }
const SESSION = "vaultKey"; // chrome.storage.session: passphrase-derived bits while unlocked
const CHECK_TEXT = "support-interview vault check";

const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export class VaultLockedError extends Error {
  constructor() { super("API keys are locked. Enter your passphrase in Options."); this.locked = true; }
}

/* ---------- Device root key (IndexedDB) ---------- */

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function openDb() {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return req(r);
}

let rootKey;
function root() {
  rootKey ??= (async () => {
    const db = await openDb();
    const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
    const existing = await req(tx("readonly").get(ROOT_ID));
    if (existing) return existing;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    raw.fill(0);
    // add() fails if another page or the service worker created the root first; use theirs then.
    try { await req(tx("readwrite").add(key, ROOT_ID)); return key; }
    catch { return req(tx("readonly").get(ROOT_ID)); }
  })().catch((e) => { rootKey = undefined; throw e; });
  return rootKey;
}

/* ---------- One encryption layer ---------- */

// [2-byte length][text][random fill] up to a multiple of BLOCK bytes.
function pad(text) {
  const data = te.encode(text);
  if (data.length > 0xffff) throw new Error("Key is too long.");
  const out = crypto.getRandomValues(new Uint8Array(Math.ceil((data.length + 2) / BLOCK) * BLOCK));
  out[0] = data.length >> 8;
  out[1] = data.length & 0xff;
  out.set(data, 2);
  return out;
}
function unpad(bytes) {
  const n = (bytes[0] << 8) | bytes[1];
  if (n + 2 > bytes.length) throw new Error("Corrupt key record.");
  return td.decode(bytes.subarray(2, 2 + n));
}

const context = (tag, field) => te.encode(`${tag}|${field}`);

async function recordKey(base, tag, field, salt) {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: context(tag, field) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function sealWith(base, tag, field, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = pad(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(tag, field), tagLength: 128 }, await recordKey(base, tag, field, salt), data,
  ));
  data.fill(0);
  return [tag, b64(salt), b64(iv), b64(ct)].join(".");
}

async function openWith(base, tag, field, envelope) {
  const [v, salt, iv, ct] = envelope.split(".");
  if (v !== tag || !ct) throw new Error("Not an encrypted key.");
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: context(tag, field), tagLength: 128 },
    await recordKey(base, tag, field, unb64(salt)), unb64(ct),
  ));
  try { return unpad(plain); } finally { plain.fill(0); }
}

/* ---------- Passphrase ---------- */

async function deriveBits(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256));
}

const hkdf = (bits) => crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);

// Both layers with a given passphrase key.
const sealBoth = async (pass, field, plaintext) => sealWith(await root(), V2, field, await sealWith(pass, PASS, field, plaintext));
const openBoth = async (pass, field, envelope) => openWith(pass, PASS, field, await openWith(await root(), V2, field, envelope));

async function sessionKey() {
  const bits = (await chrome.storage.session.get(SESSION))[SESSION];
  return bits ? hkdf(unb64(bits)) : null;
}

export async function hasPassphrase() { return !!(await chrome.storage.local.get(META))[META]; }
export async function isUnlocked() { return !!(await chrome.storage.session.get(SESSION))[SESSION]; }

// Creates the passphrase and unlocks. Keys saved under an old passphrase must be re-encrypted by the caller.
export async function setPassphrase(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const bits = await deriveBits(passphrase, salt, ITERATIONS);
  const check = await sealBoth(await hkdf(bits), "check", CHECK_TEXT);
  await chrome.storage.local.set({ [META]: { salt: b64(salt), iterations: ITERATIONS, check } });
  await chrome.storage.session.set({ [SESSION]: b64(bits) });
  bits.fill(0);
}

// Unlocks until Chrome closes. Returns false for a wrong passphrase.
export async function unlock(passphrase) {
  const meta = (await chrome.storage.local.get(META))[META];
  if (!meta) throw new Error("No passphrase is set.");
  const bits = await deriveBits(passphrase, unb64(meta.salt), meta.iterations);
  try {
    if ((await openBoth(await hkdf(bits), "check", meta.check)) !== CHECK_TEXT) return false;
  } catch { return false; }
  await chrome.storage.session.set({ [SESSION]: b64(bits) });
  bits.fill(0);
  return true;
}

export const lock = () => chrome.storage.session.remove(SESSION);

// Forgotten passphrase: the saved keys can't be recovered, so the caller deletes them too.
export async function resetPassphrase() {
  await chrome.storage.local.remove(META);
  await lock();
}

/* ---------- Records ---------- */

export const isSealed = (v) => typeof v === "string" && (v.startsWith(`${V1}.`) || v.startsWith(`${V2}.`));
// Saved without the passphrase layer (plain text from an old version, or siv1).
export const needsPassphrase = (v) => !!v && !(typeof v === "string" && v.startsWith(`${V2}.`));

// Both layers when unlocked; device layer only before a passphrase exists. Throws VaultLockedError when a passphrase
// is set but locked.
export async function seal(field, plaintext) {
  const pass = await sessionKey();
  if (pass) return sealBoth(pass, field, plaintext);
  if (await hasPassphrase()) throw new VaultLockedError();
  return sealWith(await root(), V1, field, plaintext);
}

// Device layer only, for a plain-text key from an old version found while locked: better than leaving it readable.
export const sealDeviceOnly = async (field, plaintext) => sealWith(await root(), V1, field, plaintext);

export async function unseal(field, envelope) {
  if (envelope.startsWith(`${V1}.`)) return openWith(await root(), V1, field, envelope);
  const pass = await sessionKey();
  if (!pass) throw new VaultLockedError();
  return openBoth(pass, field, envelope);
}
