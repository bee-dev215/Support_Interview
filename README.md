# Support_Interview

Chrome extension (Manifest V3) that listens to an interview or any other call, detects the other side's questions, and streams CV-grounded answer notes into Chrome's side panel. It works with calls in a browser tab (Google Meet, Google Voice, Zoom, Teams, Webex, WhatsApp Web, any site), calls in desktop apps (Zoom, Teams, Skype, WhatsApp, softphones for a second number), and phone calls that play through the computer.

```
call audio (tab / computer audio / input device) ─► offscreen doc or computer-audio window ─► Deepgram (live STT)
   ─► background (question detection) ─► Claude (streaming, CV prompt-cached) ─► side panel
```

## Setup

1. Install and build:
   ```
   npm install
   npm run build        # or: npm run watch
   ```
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder.
3. Open the extension's **Options** page:
   - Choose **OpenAI key** or **Anthropic key**, then enter that key (platform.openai.com or console.anthropic.com) and your **Deepgram API key** (console.deepgram.com). You can store both AI keys and switch providers at any time.
   - Pick the answer model. Opus 5.5 / GPT-6.1 Sol give the best quality; Haiku 5.5 / GPT-6 Luna are the fastest and cheapest.
   - Under **Call audio & microphone**, choose where the other side's voice comes from (see [Call audio](#call-audio)): **Browser tab** (the default) for a call in Chrome, **Computer audio** for a desktop app or a phone call through the computer, or **Audio input device** for Stereo Mix, VB-Cable or a phone connected to the computer.
   - Click **Grant access** under Microphone and allow it. Your voice is then transcribed as "Me". Use headphones so the mic doesn't pick up the interviewer.
   - Upload your CV (PDF/TXT/MD), then click **Analyze CV**. Review and edit the generated profile.
   - Right after **Analyze CV**, the extension researches your previous employers on its own (or click **Research employers** to re-run it after editing your profile). It searches the web for each company in your profile and writes a brief on each: history, industry, business model, main products or services, key achievements, lines you can say, and questions you may get. Answers use these briefs when the interviewer asks about a previous employer. It takes a few minutes, so keep the Options page open; read it before the interview and correct anything that's wrong.
   - Under **Next conversation**, choose **Company interview** and paste the company name (and website if you have it) with the job description, or choose **Free conversation** (see below). Everything saves automatically.
   - Then click **Research company**. It searches the web for the company you're interviewing with and analyzes the job against your CV profile. You get a **Company research** brief covering the company snapshot, products and business model, recent news, market and competitors, tech stack, and culture and values. It also covers the role decoded (must-haves, reading between the lines, likely format), a fit table of your evidence and gaps, your best stories for this role, and ready answers to "What do you know about us?", "Why us?", "Why should we hire you?" and "Tell me about yourself". It ends with likely questions and questions to ask them. Answers use it whenever the interviewer asks about their company or the role, and to pick the examples and values that fit this job. It takes a few minutes; read it before the interview and correct anything that's wrong. If you edit the job description afterwards, the brief is no longer used until you click **Research company** again (the panel warns you when you start listening).
   - Each key is checked as you paste it (✓ key works / ✗ rejected / model not available); **Test keys** re-checks all of them.
   - **Preferences:** auto-answer on/off, proactive (take the lead) on/off, answer length (Short / Standard / Detailed), reading guide on/off, appearance (System / Light / Dark) and your keyboard shortcuts.

## Use

1. Join the call: Google Meet, Google Voice, Zoom, Teams or any other call (see [Call audio](#call-audio) for desktop apps and phone calls).
2. Click the **Support_Interview** toolbar icon *on the call's tab* (with Computer audio or an input device, on any tab). The side panel opens and listening starts.
3. Both sides of the conversation appear in the transcript, labeled **Interviewer** and **Me**. The panel only listens and writes the transcript. When the interviewer asks something, press <kbd>Space</kbd> (with the panel focused) or click the blue **Answer** button, and the answer streams in at the top. It answers everything they said since you last spoke, so a question spread over several lines is answered as one, including words still being transcribed. (Turn on **Auto-answer** to have answers appear by themselves instead.) It uses the whole conversation, so it stays consistent with what you've already said and builds on your earlier answers. Answers are written in natural American conversational English, in both modes. That means contractions, everyday phrases ("Here's the thing", "That makes sense", "What do you think?"), common phrasal verbs (figure out, set up, follow up) and American spelling and words. Stiff, textbook or non-native phrasing like "I would like to inform you" or "since three years" is avoided, so the lines feel comfortable to say. They're grammatically correct, in short paragraphs, and a colored **/** marks each place to pause. With the **reading guide** on (the default), they also use simple words and short sentences, and highlighted words are the ones to stress, so you can read them aloud smoothly even as an English beginner.
4. **Conversation insights** update automatically every 8 utterances and again when you click Stop. You can also click **Analyze**. Each analysis includes a summary, the facts you've claimed, what the interviewer is focused on, weak answers with a recovery line for each, and questions to ask them.
5. **Copy transcript** copies the full labeled conversation. **Discard session** clears it without saving. Starting on a different Meet tab or meeting also starts a new session.
6. **After the interview:** the extension detects the end when you leave the call, close the Meet tab, or navigate away. You can also click **End & feedback**. The interview is saved and a **feedback report** opens in a new tab:
   - an overall score and likely outcome
   - scores in five areas
   - a review of each question: your answer, what was missing, and a stronger answer
   - strengths, what to improve, inconsistent or risky claims, and what to prepare for the next round
   - a draft thank-you email

   The report page has **Regenerate**, **Copy**, **Print / Save as PDF** and **Delete** buttons. **History** (in the side panel) lists every past interview with its score.
   **Pause** stops listening but keeps the session, so you can resume by clicking the icon again.
7. Each answer card has **Regenerate**, **Shorter**, **Deeper** and **Copy** (copies clean text, without Markdown symbols or pause marks). **Stop** halts an answer while it streams. To answer an older line, hover an interviewer line in the transcript and click **Answer**, or type it into the box at the bottom. Answers stay in the panel if you close and reopen it. When a question has more than one answer (after Regenerate, Shorter, Deeper or answering it again), the model picks the most appropriate one and shows it in slightly bold text.
8. **Auto-answer** (off by default; also in Options) makes answers and **Your move** cards appear by themselves. With it off, nothing appears until you press <kbd>Space</kbd>, click **Answer**, or ask for a move.
   - **Interview direction.** Under the rapport meter, a strip shows the current topic, the interview stage (opening, technical, behavioral, system design, closing…) and whether the moment is **Technical**, **Everyday** or **Mixed**, plus where the interviewer seems to be heading and which of your strengths fit the role but haven't come up yet. It's re-read every few utterances and fed into every answer.
   - **Technical vs everyday.** Answers adapt to that register: technical questions get the precise substance plus one plain-language line (an everyday comparison or the real-world impact); personal or casual moments get a warm, jargon-free reply with a light link to your work only where it fits naturally; mixed questions blend both.
   - **Proactive (take the lead)**, on by default and toggled in the panel or Options, lets the copilot take the initiative instead of only reacting. It offers a **Your move** card (green): when you've finished speaking and nobody picks the conversation up for about 7 seconds; when the interviewer shares something without asking (explains the team, the stack, their opinion); and whenever you click **Take the lead** or press <kbd>L</kbd>. Each move is 1-3 sentences that react to what was said and bridge to a topic that suits you and the role, ending in an offer or a sharp question; the small grey *Why* line is a note to you, not something to read out. Answers may also close with a hook sentence that steers the next question, woven into the answer so you can read straight through. A pause-time move never collapses the answer you may still be reading.
   - **Photo.** Take a screenshot of the interviewer's face during the call (e.g. <kbd>Win+Shift+S</kbd>), then paste it into the panel with <kbd>Ctrl+V</kbd>, drop the file on it, or click the photo button next to the question box (<kbd>P</kbd>). The model studies their face and background and prepares an **Icebreaker** card: a movie-lookalike line like *"Have you seen Notting Hill? You look a bit like William from that movie."*, 2-3 more kind lines (a compliment on their glasses or smile, a question about the guitar behind them), and small grey notes for you only (movie, year, actor, what it noticed). It checks the movie title, character and actor with a web search. **Regenerate** suggests a different movie. The **Photo** switch at the bottom shows these cards; turn it off and they're hidden (a photo you upload meanwhile is still studied, and shows up when you turn Photo back on). It only ever compares to likable characters and never mentions ethnicity, weight, body or age. The photo is downscaled, sent to your AI provider, kept only for the current session (for Regenerate) and never saved to history.
9. **Pause / Resume / Start** in the panel controls listening. The toolbar icon shows **ON** while listening and **II** while paused.
   **Floating window.** Chrome's side panel can't move, so click **Pop out** (top of the panel) to turn it into a box on the page you're viewing: your Meet call or any other website (the first time, Chrome asks to let the extension onto other sites; say no and it only pops out onto Meet). Chrome's own pages and the Web Store can't take it. Drag it by its title bar, resize it from any edge or corner, and use the slider to make it see-through (20-100%). It remembers its place, size and opacity. To take it **out of the browser**, click the arrow-out button in its title bar: it becomes a separate window that stays on top of every other app (Meet, your editor, other monitors) and can be moved anywhere on your screen by its own title bar. It remembers its size; it can't be see-through. Closing that window with its own **X** puts the box back on the page, and the window closes if you close or leave the interview's tab. **×** hides it (the toolbar icon brings it back); the side-panel button docks it back into the side panel.
10. **Keyboard shortcuts.** Press <kbd>?</kbd> in the panel for the full list:

    | Where | Keys | Action |
    |---|---|---|
    | Anywhere in Chrome | <kbd>Alt+Shift+S</kbd> | Open the panel and start listening on this tab |
    | | <kbd>Alt+Shift+P</kbd> | Pause or resume listening |
    | | <kbd>Alt+Shift+Q</kbd> | Answer the interviewer's latest question now |
    | | <kbd>Alt+Shift+L</kbd> | Take the lead: suggest what to say next |
    | In the panel | <kbd>Space</kbd> or <kbd>A</kbd> / <kbd>/</kbd> | Answer what they just said / type a question |
    | | <kbd>L</kbd> | Take the lead: suggest what to say next |
    | | <kbd>P</kbd> | Upload the interviewer's photo (or paste / drop one) |
    | | <kbd>R</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>C</kbd> | Regenerate / shorter / deeper / copy the latest answer |
    | | <kbd>Esc</kbd> | Stop generating |
    | | <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>, <kbd>+</kbd> <kbd>−</kbd> | Switch tabs, answer text size |

    Change the global ones at `chrome://extensions/shortcuts` (Options has a button for it). Chrome skips a suggested shortcut that another extension already uses. In that case it shows as "Not set" until you assign one.
11. The report page's **Download** button saves the feedback, live insights and timestamped transcript as one Markdown file.

## Call audio

Options → **Call audio & microphone** sets where the other side's voice comes from. Your own voice always comes from your microphone.

| Choice | Use it for | How it starts |
|---|---|---|
| **Browser tab** (default) | Any call in Chrome: Google Meet, Google Voice (voice.google.com), Zoom, Teams or Webex on the web, WhatsApp Web, an AI interview site | Click the icon on the call's tab. Only that tab is heard. |
| **Computer audio** | Desktop apps (Zoom, Teams, Skype, WhatsApp, Viber), a softphone for your second number, your mobile's calls through Windows **Phone Link** or a Bluetooth link to the computer | Click the icon on any tab. A small **Call audio** window opens: click **Share computer audio**, choose **Entire screen**, turn on **Also share system audio**, and click **Share**. Keep that window open (minimizing is fine). Closing it, or clicking Chrome's **Stop sharing**, pauses listening. |
| **Audio input device** | Windows **Stereo Mix**, a virtual cable (VB-Cable, VoiceMeeter), or a phone or desk phone connected to the computer's line-in or as a Bluetooth headset | Pick the device under the choice, then click the icon on any tab. No window and no screen sharing. |

Notes:
- **A call on your mobile phone (a second number, a regular call, WhatsApp on the phone).** The extension can only hear what reaches the computer. On Windows, link the phone with **Phone Link** and take the call from the PC (Phone Link → Calls), or pair the phone with the computer over Bluetooth, then use **Computer audio**.
- **Computer audio** hears everything the computer plays, including notifications and videos, so mute other sound during the call. Use headphones so your microphone doesn't pick up the call too. Chrome offers system audio only when you share an **Entire screen** (Windows and ChromeOS; on macOS it depends on the version). If no sound is shared, the window tells you; use an **Audio input device** instead (on a Mac, a virtual device such as BlackHole).
- **Ending a call.** On Meet and Google Voice, hanging up ends the session and opens the feedback report. With a desktop app or a phone call, click **End & feedback** in the panel when the call is over.

## Free conversation mode

For a talk with anyone that isn't a job interview, such as a manager, a client, a partner or a friend, when you want them to come round to your point of view.

1. In Options → **Next conversation**, choose **Free conversation** (or click the **Interview / Free talk** button at the top of the panel).
2. Write everything in the one **Your topic** box, in your own words: what the conversation is about, **your intention** (the view you want them to agree with), any facts or reasons you have, and **the questions** you want to ask them.
3. Click **Analyze topic**. The extension works out your goal, your strongest reasons, likely objections with replies, and when to ask each question, and keeps the result internal. A check mark under the box shows when it's done; click it again after you edit the topic. If you start the call without analyzing, replies read your topic directly.
4. During the call the other side is labeled **Them**. When they ask something, the reply answers it honestly first, then moves one step toward your view. When they object, it acknowledges the concern, then answers it with your strongest unused reason, tied to what they care about. Replies build small agreements and ask your questions at the right moment. **Your move** cards pick the next step: an unasked question, the next argument, an agreement check, or a summary and next step once they're close.
5. The strip under the rapport meter shows the stage (Exploring, Making my case, Objections, Converging, Agreement…), **where they stand** on your view (Opposed → Agrees), their open concerns, the next move and which of your questions are **still to ask**.
6. Insights track where they stand, what landed, open objections and your questions' answers. The feedback report scores how well you moved them (Convinced / Leaning my way / Undecided / Not convinced), reviews each question and objection, sums up what your questions revealed, and drafts a follow-up message.

Replies only use facts from your topic, the game plan, the conversation or accurate general knowledge. When a number is missing, they leave a **[placeholder]** for you. They don't use pressure, false urgency or made-up claims, because those lose trust.

This mode is completely separate from company interviews. It shares only your API keys, model, language, microphone and display preferences. Your CV, project details, personal notes, employer research and job description are never sent, and the CV section is hidden in Options while free mode is selected. Personal questions get warm, general replies with a **[placeholder]** for any detail, never invented facts.

## Files

| File | Role |
|---|---|
| `src/background.js` | Service worker: starts tab capture, keeps rolling context, detects questions, streams Claude answers |
| `src/offscreen.js` | Captures tab audio, plays it back, streams it to Deepgram, emits finished utterances |
| `src/lib/claude.js` | CV analysis, answer prompt, prompt caching, cache warm-up; routes to OpenAI when that provider is selected |
| `src/lib/openai.js` | Minimal OpenAI Responses API client (streaming) with the same interface as the Anthropic SDK streams |
| `src/lib/detect.js` | Heuristic question filter (Claude also replies `NO_QUESTION` for non-questions) |
| `src/lib/deepgram.js` | Deepgram key check for Options |
| `src/lib/shortcuts.js` | Reads the extension's Chrome keyboard shortcuts for display |
| `src/theme.css`, `src/theme-init.js` | Shared design tokens (`light-dark()` pairs, WCAG AA text contrast) and the Appearance setting applied before first paint |
| `src/sidepanel.*` | Live UI |
| `src/report.*` | Post-interview feedback report and interview history |
| `src/meet.js` | Content script: detects leaving the call (via the "Leave call" button, English UI) |
| `src/lib/history.js` | Saved interviews (`chrome.storage.local`) |
| `src/options.*` | Keys, model, CV upload, job description |

## Notes

- Two Deepgram streams run in parallel: tab audio (Interviewer) and microphone (Me). Without headphones, lines on the Me stream that mostly repeat recent interviewer speech are dropped as echo.
- The transcript is sent as one block per line and only grows by appending, so each request reuses the earlier conversation from the prompt cache.
- API keys are stored in `chrome.storage.local` only as ciphertext (`src/lib/vault.js`), encrypted twice with AES-256-GCM: once with a key derived from your passphrase (PBKDF2-SHA-256, 600,000 iterations), once with a non-extractable device key in the extension's IndexedDB. The round button next to **Test keys** in Options is red while keys aren't protected yet; clicking it asks you to create a passphrase (first time only), encrypts and saves the keys, shows the ciphertext in the fields and turns green. Click the green button to enter new keys; saved keys are never shown again.
- The passphrase is asked again after every Chrome restart (or **Lock now**); until then the extension can't use the keys. It can't be recovered: **Forgot your passphrase?** deletes the saved keys so you can enter them again. Keys saved by older versions (plain text, or without a passphrase) are encrypted automatically and gain the passphrase layer once you unlock. Don't publish a build that contains keys.
- Some jurisdictions and employers require consent to record or transcribe calls, and some forbid AI assistance during interviews. Check before you use this.
