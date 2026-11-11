// Minimal OpenAI Responses API client. Streams expose the same surface the app uses
// from Anthropic SDK streams: .on("text", fn), .finalMessage() and .abort().
const ENDPOINT = "https://api.openai.com/v1/responses";

async function request(apiKey, body, signal) {
  // The key lives in chrome.storage.local of your own browser; never ship it in a published build.
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    // store: false keeps interview content out of OpenAI's stored responses.
    body: JSON.stringify({ store: false, ...body }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(`OpenAI ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }
  return res;
}

// Maps a Responses API result onto the fields callers read from an Anthropic message.
function toMessage(response) {
  const parts = (response.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const text = parts.filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const stop_reason = parts.some((c) => c.type === "refusal") ? "refusal"
    : response.status === "incomplete" ? "max_tokens"
    : "end_turn";
  return { text, stop_reason };
}

// Live check of the key and the selected model, for the Options page.
export async function check(apiKey, model) {
  let res;
  try {
    res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch {
    return { state: "warn", text: "Couldn't reach OpenAI. Check your connection." };
  }
  if (res.ok) return { state: "ok", text: "Key works · model available" };
  if (res.status === 401) return { state: "bad", text: "Key rejected. Check that you copied all of it." };
  if (res.status === 403) return { state: "bad", text: "This key isn't allowed to use the API." };
  if (res.status === 404) return { state: "warn", text: "Key works, but this model isn't available to it. Pick another model." };
  return { state: "warn", text: `OpenAI answered ${res.status}. Try again in a moment.` };
}

export async function complete(apiKey, body) {
  const res = await request(apiKey, body);
  return toMessage(await res.json());
}

export function stream(apiKey, body) {
  const controller = new AbortController();
  const listeners = [];

  const final = (async () => {
    try {
      const res = await request(apiKey, { ...body, stream: true }, controller.signal);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value.replace(/\r\n/g, "\n");
        let end;
        while ((end = buf.indexOf("\n\n")) !== -1) {
          const data = buf.slice(0, end).split("\n")
            .filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          buf = buf.slice(end + 2);
          if (!data || data === "[DONE]") continue;
          const e = JSON.parse(data);
          if (e.type === "response.output_text.delta") listeners.forEach((fn) => fn(e.delta));
          else if (e.type === "response.completed" || e.type === "response.incomplete") return toMessage(e.response);
          else if (e.type === "response.failed") throw new Error(`OpenAI: ${e.response?.error?.message ?? "request failed"}`);
          else if (e.type === "error") throw new Error(`OpenAI: ${e.message ?? "stream error"}`);
        }
      }
      throw new Error("OpenAI: stream ended before the response completed");
    } catch (e) {
      if (!controller.signal.aborted) throw e;
      // Same name as the Anthropic SDK's abort error, so callers can ignore both alike.
      const abort = new Error("Request was aborted.");
      abort.name = "APIUserAbortError";
      throw abort;
    }
  })();
  final.catch(() => {}); // aborted streams are often never awaited

  return {
    on(event, fn) {
      if (event === "text") listeners.push(fn);
      return this;
    },
    finalMessage: () => final,
    abort: () => controller.abort(),
  };
}
