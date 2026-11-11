// Computer-audio window (Call audio = "Computer audio" in Options): hears everything your computer plays, so
// calls in desktop apps and phone calls routed through the computer are transcribed as the other side.
// Screen sharing with system audio needs a click on a visible page, which the hidden offscreen document can't
// get; the background opens this window, and closing it pauses listening.
import { getSettings } from "./lib/settings.js";
import { transcribe } from "./lib/transcribe.js";

const $ = (id) => document.getElementById(id);
const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
let live = null;

function show(text, kind = "") {
  $("state").className = kind;
  $("state").textContent = text;
}

function stop() {
  live?.stop();
  live = null;
}

$("share").addEventListener("click", async () => {
  stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 }, // Chrome only offers system audio with a screen; keep the video as cheap as possible
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      monitorTypeSurfaces: "include",
    });
  } catch (e) {
    return show(e.name === "NotAllowedError" ? "Sharing was cancelled. Click Share computer audio to try again." : `Couldn't share: ${e.message}`, "err");
  }
  const [track] = stream.getAudioTracks();
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    return show("No sound was shared. Choose Entire screen and turn on \"Also share system audio\". (A single window or a Mac without system-audio support shares no sound: use an audio input device in Options instead.)", "err");
  }

  const s = await getSettings();
  live = transcribe("interviewer", stream, {
    deepgramKey: s.deepgramKey,
    language: s.language,
    onFail: (text) => {
      stop();
      show(text, "err");
      toBackground({ type: "capture-error", text });
    },
  });
  // Chrome's "Stop sharing" bar, or the screen going away, ends the audio.
  track.addEventListener("ended", () => {
    if (!live) return;
    stop();
    show("Sharing stopped. Click Share computer audio to listen again.", "err");
    toBackground({ type: "capture-ended", text: "Computer audio sharing stopped, so listening is paused. Click Resume to share it again." });
  });
  show("Listening to your computer's audio. Keep this window open; you can minimize it.", "ok");
  toBackground({ type: "capture-started", text: "Listening to your computer's audio..." });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === "offscreen" && msg.type === "stop-capture") {
    stop();
    window.close();
  }
});
