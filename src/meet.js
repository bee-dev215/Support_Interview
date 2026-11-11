// Content script on Google Meet and Google Voice: tells the extension when you leave the call.
// Their markup changes often, so this keys off the accessible hang-up button (English UI): "Leave call" on Meet,
// "End call" on Google Voice. Tab close / navigation are handled separately in the background.
const LEAVE_SELECTOR = [
  '[aria-label*="leave call" i]', '[data-tooltip*="leave call" i]',
  '[aria-label*="end call" i]', '[data-tooltip*="end call" i]', '[aria-label*="hang up" i]',
].join(", ");
const GONE_FOR_MS = 4000;

let wasInCall = false;
let goneSince = 0;

setInterval(() => {
  const inCall = !!document.querySelector(LEAVE_SELECTOR);
  if (inCall) {
    wasInCall = true;
    goneSince = 0;
    return;
  }
  if (!wasInCall) return;
  goneSince ||= Date.now();
  if (Date.now() - goneSince >= GONE_FOR_MS) {
    wasInCall = false;
    chrome.runtime.sendMessage({ target: "background", type: "meeting-left" }).catch(() => {});
  }
}, 1000);
