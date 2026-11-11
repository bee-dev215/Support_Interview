// Captures two audio sources and streams each to its own Deepgram socket:
//   - the interview tab's audio -> "interviewer"
//   - your microphone     -> "me"

const sources = new Map(); // speaker -> { stream, recorder, ws, utterance }
let audioCtx;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
const toPanel = (msg) => chrome.runtime.sendMessage({ target: "panel", ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start-capture") start(msg);
  if (msg.type === "stop-capture") stopAll();
});

async function start({ streamId, deepgramKey, language, captureMic, micDeviceId }) {
  stopAll();
  try {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
    // Capturing mutes the tab; route it back to the speakers so you still hear the call.
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(tab).connect(audioCtx.destination);
    transcribe("interviewer", tab, deepgramKey, language);
  } catch (e) {
    return fail(`Tab audio capture failed: ${e.message}`);
  }

  if (!captureMic) return;
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: micDeviceId ? { ...audio, deviceId: { exact: micDeviceId } } : audio });
    } catch (e) {
      if (!micDeviceId || !["NotFoundError", "OverconstrainedError"].includes(e.name)) throw e;
      // The chosen mic is unplugged: fall back to the default one rather than not hearing you at all.
      mic = await navigator.mediaDevices.getUserMedia({ audio });
      toBackground({ type: "capture-warning", text: "The microphone chosen in Options isn't connected. Using the system default microphone instead." });
    }
    transcribe("me", mic, deepgramKey, language);
  } catch (e) {
    toBackground({
      type: "capture-warning",
      text: `Microphone not captured (${e.name}). Open Options and click "Enable microphone". Only the interviewer is being transcribed.`,
    });
  }
}

function transcribe(speaker, stream, deepgramKey, language) {
  const params = new URLSearchParams({
    model: "nova-3",
    language,
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1200",
    vad_events: "true",
  });
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", deepgramKey]);
  const src = { stream, ws, recorder: null, utterance: "", spokeAt: 0 };
  sources.set(speaker, src);

  ws.onopen = () => {
    src.recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    src.recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    src.recorder.start(250);
  };

  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === "Results") {
      const text = d.channel?.alternatives?.[0]?.transcript ?? "";
      if (d.is_final && text) src.utterance = `${src.utterance} ${text}`.trim();
      toPanel({ type: "transcript-live", speaker, final: src.utterance, interim: d.is_final ? "" : text });
      // Someone is talking: the background holds off on suggesting a lead (at most one ping a second).
      if (text && Date.now() - src.spokeAt > 1000) {
        src.spokeAt = Date.now();
        toBackground({ type: "speaking", speaker });
      }
      // speech_final = endpoint after a pause; flush there for lower latency.
      if (d.speech_final) flush(speaker);
    } else if (d.type === "UtteranceEnd") {
      flush(speaker);
    }
  };

  ws.onerror = () => fail(`Deepgram connection error for ${speaker} audio (check your API key).`);
  ws.onclose = (e) => {
    if (sources.get(speaker) === src && e.code !== 1000) {
      fail(`Deepgram closed for ${speaker} audio (${e.code}${e.reason ? `: ${e.reason}` : ""}).`);
    }
  };
}

function flush(speaker) {
  const src = sources.get(speaker);
  const text = src?.utterance.trim();
  if (!text) return;
  src.utterance = "";
  toBackground({ type: "utterance", speaker, text });
}

function fail(text) {
  stopAll();
  toBackground({ type: "capture-error", text });
}

function stopAll() {
  for (const [speaker, src] of sources) {
    flush(speaker);
    if (src.recorder?.state === "recording") src.recorder.stop();
    if (src.ws.readyState === WebSocket.OPEN) {
      src.ws.send(JSON.stringify({ type: "CloseStream" }));
      src.ws.close(1000);
    }
    src.stream.getTracks().forEach((t) => t.stop());
  }
  sources.clear();
  audioCtx?.close();
  audioCtx = undefined;
}
