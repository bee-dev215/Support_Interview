// Live check of the Deepgram key, for the Options page. Any authenticated answer (even 403 for a
// narrowly scoped key) means the key itself is valid.
export async function checkDeepgram(key) {
  let res;
  try {
    res = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` } });
  } catch {
    return { state: "warn", text: "Couldn't reach Deepgram. Check your connection." };
  }
  if (res.ok || res.status === 403) return { state: "ok", text: "Key works" };
  if (res.status === 401) return { state: "bad", text: "Key rejected. Check that you copied all of it." };
  return { state: "warn", text: `Deepgram answered ${res.status}. Try again in a moment.` };
}
