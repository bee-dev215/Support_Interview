// Streams one audio source to its own Deepgram socket and reports what was said:
//   live text -> the panel ("transcript-live"), finished utterances -> the background ("utterance").
// Used by the offscreen document (tab audio, an audio input device, your microphone) and by the
// computer-audio window (desktop apps and phone calls played through the computer).

const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
const toPanel = (msg) => chrome.runtime.sendMessage({ target: "panel", ...msg }).catch(() => {});

// Returns { finalize, flush, stop }. onFail(text) is called once if the connection breaks.
export function transcribe(speaker, stream, { deepgramKey, language, onFail }) {
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
  // Only the audio is sent: a screen share also carries a video track, which MediaRecorder's audio format rejects.
  const audio = new MediaStream(stream.getAudioTracks());
  let recorder = null;
  let utterance = "";
  let spokeAt = 0;
  let stopped = false;

  const flush = () => {
    const text = utterance.trim();
    if (!text) return;
    utterance = "";
    toBackground({ type: "utterance", speaker, text });
  };

  ws.onopen = () => {
    recorder = new MediaRecorder(audio, { mimeType: "audio/webm;codecs=opus" });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    recorder.start(250);
  };

  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === "Results") {
      const text = d.channel?.alternatives?.[0]?.transcript ?? "";
      if (d.is_final && text) utterance = `${utterance} ${text}`.trim();
      toPanel({ type: "transcript-live", speaker, final: utterance, interim: d.is_final ? "" : text });
      // Someone is talking: the background holds off on suggesting a lead (at most one ping a second).
      if (text && Date.now() - spokeAt > 1000) {
        spokeAt = Date.now();
        toBackground({ type: "speaking", speaker });
      }
      // speech_final = endpoint after a pause; flush there for lower latency. from_finalize = the reply to finalize().
      if (d.speech_final || d.from_finalize) flush();
    } else if (d.type === "UtteranceEnd") {
      flush();
    }
  };

  const who = speaker === "me" ? "your microphone" : "the call";
  ws.onerror = () => !stopped && onFail(`Deepgram connection error for ${who} audio (check your API key).`);
  ws.onclose = (e) => {
    if (!stopped && e.code !== 1000) onFail(`Deepgram closed for ${who} audio (${e.code}${e.reason ? `: ${e.reason}` : ""}).`);
  };

  // Answer pressed mid-sentence: Deepgram transcribes the audio it still holds right away instead of waiting for
  // a pause, and that text is flushed as soon as it comes back.
  const finalize = () => {
    flush();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
  };

  const stop = () => {
    if (stopped) return;
    flush();
    stopped = true;
    if (recorder?.state === "recording") recorder.stop();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close(1000);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.onopen = () => ws.close(1000);
    }
    stream.getTracks().forEach((t) => t.stop());
  };

  return { finalize, flush, stop };
}
