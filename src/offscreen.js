// Captures the call's audio and your microphone, each streamed to its own Deepgram socket:
//   - the other side -> "interviewer": the interview tab's audio (source "tab"), or an audio input device such as
//     Stereo Mix, VB-Cable or a phone plugged into the computer (source "device"). With source "system" the
//     computer-audio window (capture.js) hears the other side instead, and this document only takes the mic.
//   - your microphone -> "me"
import { transcribe } from "./lib/transcribe.js";

const sources = new Map(); // speaker -> { flush, stop }
let audioCtx;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start-capture") start(msg);
  if (msg.type === "stop-capture") stopAll();
});

async function start({ source = "tab", streamId, callDeviceId, deepgramKey, language, captureMic, micDeviceId }) {
  stopAll();
  const opts = { deepgramKey, language, onFail: fail };

  if (source === "tab") {
    try {
      const tab = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      });
      // Capturing mutes the tab; route it back to the speakers so you still hear the call.
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(tab).connect(audioCtx.destination);
      sources.set("interviewer", transcribe("interviewer", tab, opts));
    } catch (e) {
      return fail(`Tab audio capture failed: ${e.message}`);
    }
  } else if (source === "device") {
    try {
      // Raw audio: echo cancellation and noise suppression would eat a loopback device's sound.
      const device = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: callDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      sources.set("interviewer", transcribe("interviewer", device, opts));
    } catch (e) {
      return fail(e.name === "NotFoundError" || e.name === "OverconstrainedError"
        ? "The call audio device chosen in Options isn't connected. Plug it in or pick another one in Options → Call audio."
        : `Call audio device capture failed (${e.name}). Open Options and click "Grant access" under Microphone.`);
    }
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
    sources.set("me", transcribe("me", mic, opts));
  } catch (e) {
    toBackground({
      type: "capture-warning",
      text: `Microphone not captured (${e.name}). Open Options and click "Grant access". Only the other side is being transcribed.`,
    });
  }
}

function fail(text) {
  stopAll();
  toBackground({ type: "capture-error", text });
}

function stopAll() {
  for (const src of sources.values()) src.stop();
  sources.clear();
  audioCtx?.close();
  audioCtx = undefined;
}
