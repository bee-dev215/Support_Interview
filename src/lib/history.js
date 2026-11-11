// Past interviews, newest first, in chrome.storage.local.
const KEY = "history";
const MAX_RECORDS = 100;

export async function getHistory() {
  return (await chrome.storage.local.get(KEY))[KEY] ?? [];
}

export async function getRecord(id) {
  return (await getHistory()).find((r) => r.id === id);
}

export async function addRecord(record) {
  const list = [record, ...(await getHistory())].slice(0, MAX_RECORDS);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function updateRecord(id, patch) {
  const list = (await getHistory()).map((r) => (r.id === id ? { ...r, ...patch } : r));
  await chrome.storage.local.set({ [KEY]: list });
}

export async function deleteRecord(id) {
  await chrome.storage.local.set({ [KEY]: (await getHistory()).filter((r) => r.id !== id) });
}

export async function clearHistory() {
  await chrome.storage.local.remove(KEY);
}
