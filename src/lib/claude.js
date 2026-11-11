import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import * as openai from "./openai.js";
import { isFree, speakerLabel } from "./settings.js";

const isOpenAI = (settings) => settings.provider === "openai";
const free = (settings) => isFree(settings.mode);

export function makeClient(apiKey) {
  // The key lives in chrome.storage.local of your own browser; never ship it in a published build.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Server-side refusal fallback is supported on Opus/Sonnet; Haiku has none.
function fallbackParams(model) {
  return model === "claude-haiku-5-5"
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

const PROFILE_PROMPT = `You are preparing a software developer for remote job interviews.
From the attached CV, write a detailed candidate profile in Markdown with these sections:

## Summary
## Skills (grouped by category, with years of hands-on use where inferable)
## Experience (each role: company, title, dates, stack, responsibilities, quantified achievements)
## Key projects (problem, approach, tech, measurable outcome)
## Technical depth bank (for each project or role: the concrete systems, tools, versions, integrations and data named in the CV, then 3-5 "talking angles": the engineering problems that kind of work naturally involves, e.g. caching and invalidation for a high-traffic API, offline sync for a mobile app, labelled as angles to discuss, not as achievements)
## STAR stories (6-10 ready-to-tell stories, each from a different project or situation where the CV allows: leadership, conflict, failure, hard bug, performance win, ownership, learning something fast, a disagreement on a technical choice, working with a difficult deadline. Give each a short title and make the Action part detailed)
## Likely weak spots / gaps and honest ways to address them

Keep every concrete detail in the CV (system names, tools, domains, numbers, clients, team setups); don't compress them into generic phrases, since the interview answers can only be as specific as this profile.
Stay strictly factual to the CV; do not invent experience.`;

export async function analyzeCv(settings, file) {
  if (isOpenAI(settings)) return analyzeCvOpenAI(settings, file);
  const client = makeClient(settings.anthropicKey);
  const doc = file.type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: await toBase64(file) } }
    : { type: "document", source: { type: "text", media_type: "text/plain", data: await file.text() } };

  const msg = await client.messages.stream({
    model: settings.model,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: [doc, { type: "text", text: PROFILE_PROMPT }] }],
  }).finalMessage();

  if (msg.stop_reason === "refusal") throw new Error("The model declined to analyze this CV.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function analyzeCvOpenAI(settings, file) {
  const doc = file.type === "application/pdf"
    ? { type: "input_file", filename: file.name, file_data: `data:application/pdf;base64,${await toBase64(file)}` }
    : { type: "input_text", text: await file.text() };
  const msg = await openai.complete(settings.openaiKey, {
    model: settings.openaiModel,
    max_output_tokens: 16000,
    reasoning: { effort: "medium" },
    input: [{ role: "user", content: [doc, { type: "input_text", text: PROFILE_PROMPT }] }],
  });
  if (msg.stop_reason === "refusal") throw new Error("The model declined to analyze this CV.");
  return msg.text.trim();
}

const RESEARCH_PROMPT = `TASK: The candidate above will be asked about their previous employers in job interviews: what the company does, its history, its industry and why they worked there. Research every company in the Experience section with web search, so they can answer confidently.

For each company, newest first, write in Markdown:
## Company name (candidate's title, dates, as in the profile)
- **At a glance:** one plain sentence on what the company does and for whom.
- **History:** founded when, where and by whom; headquarters; major milestones, renames, mergers, acquisitions, funding or IPO; who owns it now.
- **Industry and market:** the sector, the main customers, the main competitors, and one current trend in that industry.
- **Business model:** how the company makes money (e.g. SaaS subscriptions, transaction fees, advertising, outsourcing contracts, hardware sales).
- **Main products and services:** the important ones, one short line each.
- **Key achievements:** awards, scale (users, revenue, employees, countries), notable launches or clients. Give numbers with the year they refer to.
- **How to talk about it:** 2-3 connected sentences, on this one line, that the candidate can say out loud in one go, linking the company to their own role there ("At X, which builds ..., I worked on ..., so ...").
- **Questions you may get:** 2-3 likely interviewer questions about this company or its industry, each with a one-line answer seed.

Rules:
- Use only facts you found or are confident about. If several companies share the name, use the location, industry and dates in the profile to pick the right one and say which. If a company is small or you can't verify something, write "Not verified" instead of guessing.
- Simple, clear English that is easy to read aloud. Under 350 words per company.
- If the candidate worked for a client through an agency or outsourcing company, cover both.
- No introduction or conclusion; start directly with the first company.`;

/* ---------- Free conversation: bring the other person round to your point of view ---------- */

const TOPIC_PROMPT = `You are preparing someone ("Me") for a live one-to-one conversation (a call or meeting, not a job interview). Me wants to bring the other person ("Them") round to Me's point of view, and to get answers to some questions.
Below are Me's own notes: the topic, Me's intention and point of view, and the questions Me wants to ask. Analyze them and write a conversation game plan in Markdown with exactly these sections:

## Goal
In one or two sentences: the exact point of view Them should come to agree with, and what agreement looks like in practice (a yes, a decision, a concrete next step).
## Core message
Me's position as one plain sentence Me can say out loud. Then the 3-5 strongest reasons for it, strongest first. For each: the reason, why it matters to Them (their interests, not Me's), and the evidence or example behind it.
## What they may care about
What Them probably wants, worries about or values here, inferred from the notes. Label it as a guess.
## Common ground
Points both sides most likely already agree on: where to start, and where to come back to when it gets tense.
## Likely objections
5-8 doubts or objections Them may raise. For each: the honest concern behind it, then a short spoken reply (1-2 sentences) that acknowledges it and answers or reframes it.
## My questions
Every question Me wrote, polished to say out loud. For each: why to ask it, the best moment to ask it, and how to use the likely answers to move toward Me's view. Then 2-3 extra questions that would help Them reach Me's conclusion on their own.
## Conversation path
The order to move through, one or two lines each: opening, finding out where Them stands, presenting the case, handling objections, getting to agreement and a concrete next step.
## Lines to say
6-10 short, ready-to-say sentences: an opener, bridges back to the topic, an agreement check ("Would you agree that ...?"), and a closing line that asks for the decision or the next step.
## Careful
What Me should not say or concede, and the weak spots in Me's position, with an honest way to handle each.

Rules:
- Stay faithful to the notes. Don't invent facts, numbers, studies or promises about the topic; accurate general knowledge is fine. Mark anything Me should double-check with [check].
- Persuade with honest reasons, Them's own interests and good questions. Never with pressure, deception, guilt or false urgency.
- Write in the language the notes are written in, in simple spoken words; when the notes are in English, write the "Lines to say" and the spoken replies in natural, everyday American English (contractions, common phrases like "Here's the thing", "That makes sense", "What do you think?"). No introduction or conclusion; start with the first section.`;

// Game plan for a free conversation, from what you wrote about the topic, as Markdown.
export async function analyzeTopic(settings, topic) {
  const prompt = `ME'S NOTES (topic, intention, point of view and questions):\n${topic}\n\n${TOPIC_PROMPT}`;
  if (isOpenAI(settings)) {
    const msg = await openai.complete(settings.openaiKey, {
      model: settings.openaiModel,
      max_output_tokens: 12000,
      reasoning: { effort: "medium" },
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });
    if (msg.stop_reason === "refusal") throw new Error("The model declined to analyze this topic.");
    return msg.text.trim();
  }
  const msg = await makeClient(settings.anthropicKey).messages.stream({
    model: settings.model,
    max_tokens: 12000,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: prompt }],
  }).finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("The model declined to analyze this topic.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const FREE_ROLE = `You are a real-time conversation copilot for the user ("Me") in a live one-to-one conversation: a call or meeting with anyone, not a job interview. The other person is "Them".
You receive the full speech-to-text transcript of the conversation so far, with each line labeled "Them:" or "Me:".
Transcription may contain errors; infer the intended meaning. If the microphone was not captured, "Me" lines may be missing.
Me has a goal: to bring Them round to Me's point of view on the topic below, and to get answers to Me's questions. Your job is to help Me answer Them well and guide the conversation, step by step, toward that agreement.
Everything you know about Me's goal comes from MY TOPIC. Work out from it Me's intention, the exact view Them should agree with, Me's reasons, and Me's questions; if a GAME PLAN is given, use it too. You know nothing else about Me's life or background: never invent it.
Some shared instructions below use interview words: read "the interviewer" as Them, "the candidate" as Me, "the interview" as this conversation, and "the profile" as MY TOPIC and the GAME PLAN.`;

// Personal questions in a free conversation: no personal notes exist here, so nothing personal may be made up.
const FREE_PERSONAL = `- Personal questions (family, home, hobbies, weekend, background): answer warmly and briefly in general terms. Never invent names, people, places or personal facts; if a reply needs a specific detail, put a short placeholder in square brackets, like [your hobby], for Me to fill in. Then, if it fits, a light bridge back to the topic.`;

// How Me argues: shared by replies and lead moves in a free conversation.
const PERSUADE = `How to persuade (applies to everything you write):
- Answer first. If Them asked something, give a direct, honest answer in the first sentence, and only then steer. Never dodge a question; dodging costs more trust than any weak point.
- Start from Them's side: acknowledge in a few words what is reasonable in their view or worry ("That's fair, ...", "I had the same worry at first."), then answer it. Never tell them they're wrong.
- Tie every argument to what Them cares about (their goals, time, money, risk, the people around them), not to what Me wants.
- One point at a time: choose the single strongest argument or reply (from MY TOPIC and the GAME PLAN) that fits this exact moment and hasn't been used yet. Never stack every reason at once. Never repeat an argument Me already made; if it must come back, bring a new angle, example or question.
- Build small agreements: where it fits, end with a check that invites a "yes" on one step ("Would you agree that ...?", "Does that make sense for you?"), or with one of Me's own questions from the topic when its moment has come and it hasn't been asked yet.
- Use questions so Them reaches the conclusion themselves. When Them answers one of Me's questions, use that answer as the bridge to Me's view.
- Concede small, true points to earn credibility on the big one. Respect the "Careful" points in the game plan.
- Stay honest: use only facts from the topic, the game plan, the conversation, or accurate general knowledge. Never invent numbers, studies, promises or deadlines; when a reply needs a figure that isn't known, put a short placeholder in square brackets, like [the real cost], for Me to fill in. No pressure, false urgency, guilt or empty flattery: they backfire.
- When Them agrees, lock it in: sum up what you agreed in one sentence and propose a concrete next step.
- If Them is getting irritated, or a point is going nowhere, ease off: acknowledge, return to common ground and leave the door open instead of pushing.`;

// How Me sounds in a free conversation.
const FREE_VOICE = `How Me should sound:
- Write in the language the conversation is held in. Everyday spoken language, like a confident, friendly American talking (see "American conversational style"): contractions, short sentences, plain words. Never salesy, preachy, or written.
- Mirror Them's register: formal -> polite and crisp; relaxed -> relaxed and warm. If Them jokes, match it lightly, never at anyone's expense.
- Make it flow: each sentence picks up from the one before, so the reply reads aloud as one continuous turn. Vary the openings; never start two replies the same way.
- Never use written connectors (furthermore, moreover, additionally, firstly, in conclusion) or filler like "That's a great question".`;

const FREE_LEAD_FORMAT = `How to take the lead (Me speaks up on their own initiative to move the conversation toward agreement):
- 1-3 short spoken sentences, first person, linked so they flow as one turn: a brief genuine reaction to what was just said, then the next step. That step is one of: one of Me's questions that hasn't been asked yet and fits now; the next unused argument from the game plan, tied to what Them just said; an agreement check; or, if Them is close to agreeing, a one-sentence summary and a concrete next step.
- Steer gently, never hijack. If Them is explaining something that matters to them, prefer a question that shows Me listened.
- Then, after a blank line, one line in italics saying what the move aims at (under 15 words), so Me can decide whether to use it: *Why: ...*
- Under 70 words in total. No bullets, no headings.`;

const READ_THEM = `Before you write, read the moment from both sides:
- Them: what they literally said, what they really mean or worry about, and where they stand on Me's view right now (opposed, skeptical, neutral, open, agreeing). Which objections are still open and which are settled.
- Me ("Me" lines): what Me already said, argued or promised, which of Me's questions have been asked and answered, and which of Me's arguments haven't been used yet.
- The next step on the conversation path toward agreement.`;

const freeAnswerTask = ({ shape, words }, proactive) => `TASK: Help Me respond to Them's latest utterance (the last "Them:" line above), so that Them gets a good answer and the conversation moves toward Me's point of view.

First decide what kind of moment it is:
1. A question or request to Me -> write a reply (format below).
2. A doubt, objection or disagreement with Me's view, even when it isn't phrased as a question ("I'm not sure that works", "That sounds expensive", "We tried that before") -> write a reply (format below). These are the most important moments of the conversation.
3. Small talk, a joke or a personal remark -> start your reply with exactly "SMALLTALK:" followed by 1-2 short, natural sentences Me can say back. If it fits easily, end with a light bridge back toward the topic. When it turns personal, follow the personal-questions rule below.
${proactive
    ? `4. Them shares something without asking: their situation, an opinion, a story, agreement with a point, or an answer to one of Me's questions -> start your reply with exactly "LEAD:" followed by a move that takes the initiative (see "How to take the lead").
5. Nothing to respond to (pure filler like "okay", "can you hear me", "one second") -> reply with exactly: NO_QUESTION`
    : `4. Nothing to respond to (filler like "okay", "can you hear me", or Them simply answering Me's question) -> reply with exactly: NO_QUESTION`}

${READ_THEM}

${PERSUADE}

${FREE_VOICE}

Reply format (cases 1 and 2): flowing spoken prose in first person, written as ${shape}.
- Me reads it straight through, out loud, during the call: full, connected sentences. No bullets, no numbered lists, no labels, no headings.
- Open with the direct answer or the acknowledgement, never a restatement of what Them said.
- Stay consistent with every fact and promise Me already stated. Never contradict them.
- Close with at most one agreement check or one of Me's questions, written as the natural last sentence, never on a separate labeled line; none is fine when the reply already lands.
- Keep it under ${words} words. No preamble.
${FREE_PERSONAL}${proactive ? `\n\n${FREE_LEAD_FORMAT}` : ""}`;

const FREE_LEAD_TASK = (force) => `TASK: It's Me's moment to take the initiative${force ? ": Me asked for a way to move the conversation forward" : ": Me finished speaking and there's a pause"}.
Read the whole conversation, then write what Me can say next on their own initiative to move Them toward Me's point of view.

${READ_THEM}

Choose the move that fits where the conversation is:
- Opening or small talk: a friendly line that naturally opens the topic.
- Them's view still unknown: one of Me's questions that finds out where Them stands.
- Them neutral or open: the next strongest unused argument, tied to what Them said or cares about.
- Them skeptical: address the open objection, or ask what would change their mind.
- Them close to agreeing: a one-sentence summary of what you agree on and a concrete next step.
- Me's last reply looks cut off or incomplete: finish it.
${force ? "" : `If speaking up now would be awkward (Them is clearly about to continue, or Me is mid-thought), reply with exactly: NO_LEAD\n`}
${FREE_LEAD_FORMAT}

${PERSUADE}

${FREE_VOICE}
${FREE_PERSONAL}`;

const FREE_DIRECTION_TASK = `TASK: Map where this conversation is and where it is going, so Me can bring Them round to Me's point of view.
Read the whole conversation together with Me's topic and game plan. Return:
- stage: the current phase of the conversation
- topic: the current topic in a few words
- stance: where Them stands on Me's point of view right now
- heading: one short sentence on where Them seems to be heading next
- focus: 1-3 concerns or objections Them has raised that are not settled yet; empty if none
- steer: 1-3 next moves that fit now (an unused argument from the game plan, a reply to an open objection, an agreement check), a few words each
- pending: Me's own questions from the topic that haven't been asked yet, a few words each; empty if all were asked
Base everything on the transcript, the topic and the game plan; do not invent.`;

export const FreeDirectionSchema = z.object({
  stage: z.enum(["opening", "exploring", "presenting", "objections", "converging", "agreement", "closing"]),
  topic: z.string(),
  stance: z.enum(["opposed", "skeptical", "neutral", "open", "agrees"]),
  heading: z.string(),
  focus: z.array(z.string()),
  steer: z.array(z.string()),
  pending: z.array(z.string()),
});

const FREE_ANALYSIS_TASK = `TASK: Analyze the conversation so far for Me. Be concise and practical; use these Markdown sections with short bullets:

**Summary** - where the conversation is and what has been covered.
**Where they stand** - Them's current position on Me's view (opposed, skeptical, neutral, open, agrees), how it has moved, and the signals.
**What landed / what didn't** - Me's arguments that got a good reaction, and those that fell flat.
**Open objections** - Them's concerns that aren't settled yet, with a one-line reply for each.
**My questions** - which of Me's questions were asked and what Them answered; which are still to ask.
**What I've said** - facts, numbers and promises Me stated (to stay consistent later).
**Next move** - the single best next step toward agreement, as one ready-to-say line.

Under 250 words. Base everything on the transcript, the topic and the game plan; do not invent.`;

const FREE_FEEDBACK_TASK = `TASK: The conversation is over. Write an honest, specific feedback report for Me, as an experienced negotiation and communication coach would.
Base it on the transcript, Me's topic and game plan. Quote or paraphrase what was actually said. Do not invent events.
If "Me" lines are missing or sparse (microphone not captured), say so and judge only what can be inferred.

Use exactly this Markdown structure:

# Conversation feedback

## Overall
- **Score:** X/10 (how well Me moved Them toward Me's view, given where Them started)
- **Likely outcome:** Convinced / Leaning my way / Undecided / Not convinced, with a one-sentence reason
- 2-3 sentence summary of how the conversation went.

## Scores
- **Clarity of my case:** X/10, one-line reason
- **Answering their questions:** X/10, one-line reason
- **Handling objections:** X/10, one-line reason
- **Listening & questions:** X/10, one-line reason
- **Rapport & tone:** X/10, one-line reason
- **Steering & closing:** X/10, did Me move toward a decision or next step?

## How their view moved
- **Arc:** where Them stood at the start -> middle -> end, with the signals (use the rapport readings if provided)
- **Turning points:** 1-3 moments that moved Them toward or away from Me's view, quoted

## Question-by-question review
For each substantive question or objection from Them, in order:
### N. <question or objection, paraphrased>
- **My answer:** one-line summary of what Me said
- **Rating:** Strong / OK / Weak
- **What was missing:** specific gaps or mistakes
- **Stronger answer:** what Me could have said, as 2-4 connected spoken sentences on this one line (no sub-bullets)

## What I learned from my questions
For each of Me's prepared questions: asked or not, what Them answered, and what it means for Me's goal.
## What worked
## What to improve (actionable, most important first)
## Open points and next steps
Objections still open, what was agreed, and the best next step.
## Follow-up email
A short, friendly follow-up message to Them that recaps what you agreed on and proposes the next step.`;

const MAX_CONTINUATIONS = 5; // server-side search loops that pause (pause_turn) and get resumed

// Background briefs on each employer in the profile, researched on the web, as Markdown.
export async function researchEmployers(settings, profile) {
  const prompt = `CANDIDATE PROFILE:\n${profile}\n\n${RESEARCH_PROMPT}`;
  if (isOpenAI(settings)) return researchEmployersOpenAI(settings, prompt);
  const client = makeClient(settings.anthropicKey);
  // The dynamic-filtering search tool needs Opus or Sonnet; Haiku takes the basic one.
  const type = settings.model === "claude-haiku-5-5" ? "web_search_20250305" : "web_search_20260209";
  const messages = [{ role: "user", content: prompt }];
  const blocks = [];
  for (let i = 0; ; i++) {
    const msg = await client.beta.messages.stream({
      model: settings.model,
      max_tokens: 32000,
      output_config: { effort: "medium" },
      ...fallbackParams(settings.model),
      tools: [{ type, name: "web_search", max_uses: 25 }],
      messages,
    }).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("The model declined to research these companies.");
    blocks.push(...msg.content);
    if (msg.stop_reason !== "pause_turn" || i >= MAX_CONTINUATIONS) break;
    // Long search turns pause; sending the turn back makes the server pick up where it stopped.
    messages.push({ role: "assistant", content: msg.content });
  }
  const text = blocks.filter((b) => b.type === "text");
  // Cited answers arrive split into many text blocks, so join them without separators.
  const body = text.map((b) => b.text).join("").trim();
  if (!body) throw new Error("No research came back. Check that your CV profile lists your employers.");
  const sources = new Map();
  for (const c of text.flatMap((b) => b.citations ?? [])) if (c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
  const list = [...sources].slice(0, 20).map(([url, title]) => `- ${title}: ${url}`).join("\n");
  return list ? `${body}\n\n## Sources\n${list}` : body;
}

async function researchEmployersOpenAI(settings, prompt) {
  const msg = await openai.complete(settings.openaiKey, {
    model: settings.openaiModel,
    max_output_tokens: 32000,
    reasoning: { effort: "medium" },
    tools: [{ type: "web_search" }],
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
  });
  if (msg.stop_reason === "refusal") throw new Error("The model declined to research these companies.");
  if (!msg.text.trim()) throw new Error("No research came back. Check that your CV profile lists your employers.");
  return msg.text.trim();
}

const COPILOT_ROLE = `You are a real-time interview copilot for a software developer (the candidate, "Me") in a live video interview.
You receive the full speech-to-text transcript of the conversation so far, with each line labeled "Interviewer:" or "Me:".
Transcription may contain errors; infer the intended meaning. If the microphone was not captured, "Me" lines may be missing.
Study the whole conversation: what the interviewer asked and cares about, and everything the candidate has already said.`;

// Answer length setting -> shape of the spoken answer, word budget and effort (short stays fast; the others think harder).
const LENGTHS = {
  short: { shape: "one paragraph of 2-4 connected sentences", words: 90, effort: "low" },
  standard: { shape: "two or three short paragraphs", words: 180, effort: "medium" },
  detailed: { shape: "three to five short paragraphs", words: 320, effort: "medium" },
};

// Technical vs everyday register, shared by answers and lead moves.
const REGISTER = `Technical vs everyday: decide the register of the moment from the utterance and the conversation, then blend accordingly.
- Technical (concepts, code, architecture, tools, debugging, trade-offs): lead with the precise substance and the correct terms, then make it human with one plain line: an everyday comparison, or what it meant for users, the team or the business.
- Everyday (background, motivation, hobbies, weekend, team culture, why this company): answer as a person first, warm and plain, no jargon. If it fits naturally, add one light link to the candidate's work or this role; never force tech into small talk.
- Mixed (e.g. working with product, what they enjoy about backend, how they learn): real technical detail told in conversational sentences, with a personal angle.
- Match the interviewer's depth: if they go deep, go deep; if they stay high-level, don't bury them in detail.`;

// Read the moment before replying, shared by answers and lead moves.
const READ_INTENT = `Before you write, read the moment from both sides:
- The interviewer: what they literally said, and what they are really trying to find out (e.g. "Tell me about yourself" -> fit for this role; "Why are you leaving?" -> reliability and motivation; a hypothetical -> how the candidate reasons, not a perfect answer). Answer the intent, not just the words.
- The candidate ("Me" lines): what they already claimed, promised to expand on, left vague or got slightly wrong, and any question of theirs still unanswered. Build on it, fix it gently or close it; never ignore it.
- What is still unclear: an ambiguous question, a missing detail the answer depends on (scale, team, stack, timeframe), or a point where the two sides don't line up yet.`;

// The vocabulary interviewers expect to hear, shared by answers and lead moves.
const INTERVIEW_LANGUAGE = `- Sound like a native American English speaker talking, not writing (see "American conversational style"):
  - Spoken openers and links: "So, ...", "Yeah, ...", "And ...", "The thing is, ...", "Honestly, ...", "We ended up ...", "Turns out ...", "The tricky part was ...". Contractions everywhere, but every sentence stays complete and grammatically correct.
  - Pick the words that carry the exact shade of meaning: how sure ("I'm pretty sure ...", "If I remember right, ...", "I haven't used it in production, but ..."), contrast ("That said, ...", "It's not so much ... as ..."), agreement with a caveat ("Yeah, with one catch: ..."), real motivation ("What draws me to this role is ...").
  - Make it flow: each sentence picks up from the one before (a cause, a contrast, a "which meant ...", a next step), so the whole reply reads aloud as one continuous turn, not a list of separate statements. Vary sentence length and openings; never start two sentences in a row with the same word or connector.
  - Never use written connectors: furthermore, moreover, additionally, firstly, in conclusion, it is worth noting.
  - These are ideas, not a script: never copy them word for word, never stack several in one breath, and never reuse a reaction, bridge or closing the candidate already said in the "Me" lines.
- Use interview signposts where they help the interviewer follow, a few per answer and never the same one back to back: "In my last role at ...", "One example that comes to mind is ...", "What I did was ...", "The impact was ...", "Looking back, I'd ...". Interview terms (ownership, impact, stakeholders, trade-offs, priorities, scalability, reliability, code review, mentoring, root cause) only where they are accurate and backed by a specific.
- Never pad with generic self-praise ("team player", "fast learner", "problem-solver", "passionate about") or filler like "That's a great question". Clarifying lines ("Just to make sure I understand, ...", "Do you mean ... or ...?") only when the question is genuinely unclear.
- Greetings and closings stay simple and warm: "Good to meet you, thanks for having me.", "Thanks so much for your time today, I really enjoyed this."
- When the interviewer asks about one of the candidate's previous employers (what the company does, its history, its industry, customers or competitors), answer from the EMPLOYER BRIEFS: say what the company does and how it makes money in one or two plain sentences, then connect it to the candidate's own work there. Never present a researched fact as something the candidate did.`;

// Where the substance comes from and how to keep it fresh, shared by answers and lead moves.
const SUBSTANCE = `Substance: specific, varied, true, and never a recital of the CV.
- Keep two kinds of claims apart:
  - What the candidate did (past tense, "I" or "we": employers, projects, titles, team sizes, numbers, results, what broke, how it was tested): only from the profile, the PROJECT DETAILS or the conversation. Use those details generously; they are the candidate's best material. Never attach a number, a failure, a fix or an outcome to the candidate's own past work unless it is there; when an answer needs one that isn't, put a short placeholder in square brackets, like [your p95 latency], for the candidate to fill in with the real figure.
  - How things work and how the candidate would approach them (present tense or "I'd"): mechanisms, why one option beats another, failure modes and gotchas, typical numbers said as general facts ("a Redis read is usually well under a millisecond"), named tools, APIs, patterns and settings. Go well beyond the CV here, and keep it technically correct.
- The profile is evidence to draw on, not a script. The interviewer has read the CV: don't restate titles, dates, company lists or the profile summary unless that is what was asked. Use only the one or two profile facts that actually prove the point.
- Go one level below the obvious: for a project in the profile, use the details it records, and turn its talking angles into what that kind of work involves and how the candidate handles it ("With offline sync, the hard part is conflicts. I'd ..."), never into invented events. Don't just repeat the project's one-line description.
- Every answer needs at least two concrete specifics that a generic answer wouldn't have (one for a lead move): a named mechanism, tool or setting, a number, a trade-off with the rejected option, a real failure mode, a small concrete scene. Cut any sentence that would fit any candidate ("I always write clean, maintainable code", "I'm a fast learner", "I follow best practices").
- Add one angle of the candidate's own where it fits: a non-obvious lesson, a defensible opinion, a "most teams do X, but Y works better when ..." insight, or a vivid analogy. It should sound like a thoughtful engineer talking, not a textbook or a CV.
- Never repeat. Before writing, scan the "Me" lines for the projects, stories, examples, numbers and phrases the candidate has already used. Choose a different example from the profile. If the question follows up on the same story, add a new layer (a different phase, the technical internals, what went wrong, what they'd change). If no unused example fits, answer from engineering knowledge or how they'd approach it rather than retelling an old story or making one up.`;

// Marriage, family and daily-life questions, shared by answers and small talk.
const PERSONAL_LIFE = `- Marriage, family and daily life (spouse, how they met, children, home, weekends, routines, holidays, hobbies): these are not work experience, so the rule against inventing experience does not apply. Answer as a real moment from the candidate's life, rich and gentle: build on the PERSONAL LIFE notes and fill them out with vivid, lifelike detail (a small scene, a sound or smell, something the spouse or child said, a little habit), told warmly in first person with no bullets, 2-4 spoken sentences. Keep every fact in the notes exactly as written (names, ages, years, places) and stay consistent with every personal detail already said in this conversation. If there are no notes, keep it warm but general rather than naming people. Optionally end with one light, natural link back to work or the role.`;

// Proactive mode: what a "take the lead" move looks like.
const LEAD_FORMAT = `How to take the lead (the candidate speaks up on their own initiative to keep the conversation flowing and steer it toward topics where they shine and that matter for this role):
- 1-3 short spoken sentences, first person, ready to say, linked so they flow as one turn. Usually: a brief genuine reaction or link to what was just said, then a bridge to a relevant topic, ending with either a concrete offer ("I could walk you through how we ...") or one specific, smart question for the interviewer.
- Pick the direction from: what the interviewer keeps probing and where the interview is heading, the target role, and strengths in the profile that haven't come up yet. Prefer threads the interviewer showed interest in. Don't repeat anything the candidate already said or asked.
- Steer gently, never hijack. If the interviewer is time-boxed or following an agenda, keep it to one sentence or a question about their own topic.
- Then, after a blank line, one line in italics saying what the move steers toward (under 15 words), so the candidate can decide whether to use it: *Why: ...*
- Under 70 words in total. No bullets, no headings.`;

const answerTask = ({ shape, words }, proactive) => `TASK: Help the candidate respond to the interviewer's latest utterance (the last "Interviewer:" line above).

First decide what kind of moment it is:
1. A question, request or instruction directed at the candidate -> write an answer (format below). It counts even when it isn't phrased as a question: "Please send me your CV", "Plz let me know your notice period", "Tell me about yourself", "Walk me through your last project", "Share your screen", "I'd like to hear about ...", "Send me your GitHub after the call". A request is never filler.
2. Small talk, a joke, a personal or friendly remark, or a light comment the candidate should react to -> start your reply with exactly "SMALLTALK:" followed by 1-2 short, natural sentences the candidate can say back, flowing as one reply. No bullets. When it touches marriage, family or daily life, follow the marriage and daily-life rule below.
${proactive
    ? `3. The interviewer shares something without asking: explains the company, team, product or stack, gives their opinion or a story, or answers the candidate's own question -> start your reply with exactly "LEAD:" followed by a move that takes the initiative (see "How to take the lead").
4. Nothing to respond to (pure filler like "okay", "can you hear me", "one second") -> reply with exactly: NO_QUESTION`
    : `3. Nothing to respond to (filler like "okay", "can you hear me", the interviewer explaining the company or answering the candidate's own question) -> reply with exactly: NO_QUESTION`}

${READ_INTENT}

How the candidate should sound (applies to everything you write):
- Write in the language the interview is being held in. Everyday spoken language, like a confident person talking to a colleague: contractions (I'm, we'd, it's), short sentences, plain words. Avoid empty buzzwords and anything that sounds written or rehearsed ("leveraged synergies", "I am passionate about").
${INTERVIEW_LANGUAGE}
- Mirror the interviewer's register, read from the whole conversation: formal interviewer -> polite and crisp; relaxed interviewer -> relaxed and warm.
- If the interviewer is joking or playful, match it: open with a quick, relatable, good-natured line (light self-deprecation or a shared developer experience like flaky tests, Friday deploys, legacy code, endless meetings), then continue naturally. Never joke at the interviewer's or anyone's expense, never edgy topics, and keep the substance of a real question intact.
- If rapport is low or the interviewer is strictly formal, skip the humor and stay friendly and precise.

${SUBSTANCE}

Answer format for questions and requests (case 1): flowing spoken prose in first person, written as ${shape}.
- The candidate reads it straight through, out loud, during the call, so it must read like one person talking: full, connected sentences from start to finish. No bullets, no numbered lists, no labels ("Situation:", "Result:"), no headings, no keyword fragments.
- Open with a direct sentence that already says something specific, the way the candidate would actually say it. Not a restatement of the question or of the CV.
- Then let it unfold the way people talk: the point, how it works or what was done, the proof, the insight. Link each sentence to the last ("So what I did was ...", "And the catch there is ...", "which meant ...", "That's why ..."), and carry one concrete specific in most sentences. Start a new paragraph at each shift, such as from setting up a story to what they did about it, then to the result or the insight.
- Behavioral questions: tell it as a short story in STAR order without naming the parts. Set up the situation and what was at stake in a sentence or two, spend most of it on what the candidate actually did (the specific steps, the decision and why), then land on the result and what they took from it. Use a story the candidate hasn't told yet in this interview.
- Technical or conceptual questions: explain it the way a strong senior engineer would: the mechanism, when to use it and when not to, one gotcha or trade-off, and a quick concrete example. Link it to the candidate's work only where there is a genuine link; a sharp explanation beats a forced mention of the CV.
- Design, hypothetical or "how would you" questions: a concrete plan: what they'd check first, the options and the one they'd pick and why, and what they'd measure to know it worked.
- Stay consistent with every fact the candidate already stated (numbers, dates, team sizes, tech choices). Never contradict them.
- If the profile has a gap for this question, be honest about it, then show with specifics how the candidate would reason through it or ramp up.
${PERSONAL_LIFE}
- Requests to do something (send the CV, portfolio, GitHub, references or certificates, share the screen, take a test, book the next round): no bullets, just 1-2 short spoken lines: agree warmly, say what the candidate will do and when ("right after the call", "today"), and if the interviewer didn't say where to send it, confirm it ("Should I send it to your email or here in the chat?"). Skip the closing question and hook.
- Requests for a detail (salary expectation, rate, notice period, start date, availability, time zone, location, email, phone, visa or work permit, years of experience): state it directly in 1-2 spoken sentences, with a short reason or a flexible note where it helps ("I'm on a 30-day notice, but I can try to shorten it."). Take the fact from the profile or the conversation; if it's in neither, never invent it: put a short placeholder in square brackets, like [your notice period], for the candidate to fill in. Skip the hook.
- Open requests to talk ("Let me know about your experience with X", "Tell me about yourself") get the normal answer format above.
- Keep it under ${words} words. No preamble, no headings.
- The voice to aim for (an illustration only; never copy its content or shape):
  Interviewer: "How do you handle caching in an API?"
  So it really depends / on how stale the data is allowed to be. For read-heavy endpoints, / I'd put Redis in front / with a short TTL. But honestly, / the cache itself is the easy part.

  The hard part is invalidation. For anything users edit, / I'd delete the key on write / instead of waiting for the TTL to run out. And once traffic picks up, / you have to watch for a stampede / when a hot key expires, / which a bit of random jitter on the TTL / mostly takes care of.
- Close with at most one of these, or none (none is the default), written as the natural last sentence of the answer, never on a separate labeled line:
  - A question back, only when the right answer really depends on something from "What is still unclear" ("Is that close to the scale you're dealing with?", "Did you mean the frontend or the API side?"). It must follow from this conversation, never be generic, and never repeat a question already asked.${proactive ? `
  - Otherwise, a hook that steers toward a fitting strength from the profile or invites a specific follow-up ("I'm happy to go into how we load-tested it, too."). Skip it when it would feel forced, the interviewer is time-boxed, or it repeats an earlier hook.` : ""}

${REGISTER}${proactive ? `\n\n${LEAD_FORMAT}` : ""}`;

const LEAD_TASK = (force) => `TASK: It's the candidate's moment to take the initiative${force ? ": they asked for a way to move the conversation forward" : ": the candidate finished speaking and there's a pause"}.
Read the whole conversation, then write what the candidate can say next on their own initiative.

${READ_INTENT}
If something is still unclear, the move can be the question that clears it up.

Choose the move that fits where the interview is:
- Opening or small talk: a friendly personal line that naturally sets up the candidate's background.
- Background or experience: connect the last point to a project in the profile that matches the role.
- Technical: offer the next layer (a trade-off, a scale number, a failure and the fix), or ask how the interviewer's team handles it in their stack.
- Behavioral: add the result or the lesson if it was missing, or check in ("Does that answer it, or should I go deeper on the conflict part?").
- Role and company: ask a specific question that shows the candidate read the job description.
- Closing or candidate questions: one sharp question, plus a short line on why the role fits.
If the candidate's last answer looks cut off or incomplete, the move can simply finish it.
${force ? "" : `If speaking up now would be awkward (the interviewer is clearly about to continue, is reading or typing, or the candidate is mid-thought), reply with exactly: NO_LEAD\n`}
${LEAD_FORMAT}

${REGISTER}

${SUBSTANCE}

Wording:
${INTERVIEW_LANGUAGE}
${PERSONAL_LIFE}`;

// Always on for anything the candidate says aloud: correct grammar, short paragraphs and " / " pause marks.
const READING_FORMAT = `

Reading format (applies to every line the candidate will say out loud, including SMALLTALK and LEAD replies; keep the SMALLTALK:, LEAD:, NO_QUESTION and NO_LEAD tags exactly as they are; never put pause marks in the italic *Why: ...* or *Noticed: ...* notes):
The candidate reads your reply aloud during the call, so lay it out to be read smoothly at first glance.
- Grammar: every sentence is complete and grammatically correct. Use a subject and a verb, the right article ("a", "an", "the"), subject-verb agreement ("she works", "the team was"), a consistent tense (past for what happened, present for how things work), correct plurals and prepositions ("good at", "worked on", "in 2021"), and proper punctuation. Contractions and a spoken tone are fine; grammar mistakes are not. Re-read each sentence and fix it before moving on.
- Paragraphs: break the reply into short paragraphs of 2-3 sentences, one idea each, with a blank line between them. A reply of one or two sentences stays a single paragraph.
- Pauses: inside every sentence, mark each natural pause with " / " (a slash with a space on each side), so the sentence splits into meaningful word groups of about 3-6 words. Put it after an opening phrase, before "and", "but", "because", "so", "when", "which" or "that" when it starts a new clause, and before a longer object or a phrase like "for ...", "with ...", "by ...". When there is a comma, put the slash right after it ("At my last job, / I led ..."). Sentences of 5 words or fewer need no slash.
- Never split a name, a number and its unit, an article from its noun, or words that belong together ("five years", "React Native", "a team of four"). No slash at the start or end of a sentence; the period is the stop.
- Use the spaced slash only as a pause mark. For alternatives write "or" or "and", not a slash; keep terms like "CI/CD" as they are.
Example:
At my last job, / I led a team of four developers. We rebuilt the checkout page / and cut its load time / by 40 percent.

The slowest part / was the product images. So we moved them to a CDN / and loaded them lazily, / which fixed most of it.`;

// Always on: lines to say out loud sound like a native American speaker, natural and comfortable to say.
const AMERICAN_STYLE = `

American conversational style (applies to every line the candidate will say out loud, including SMALLTALK and LEAD replies, whenever the conversation is in English; never to the italic *Why: ...* or *Noticed: ...* notes):
Write it the way a friendly, confident, educated American talks in a relaxed work conversation, so it feels natural and comfortable to say, not translated or memorized.
- American English: American spelling (color, organize, center, program, analyze) and words (résumé when speaking instead of CV, vacation, apartment, cell phone, fall, on the team, on the weekend, "I already sent it", "I just finished").
- Everyday American moves, used where they fit and varied across the conversation:
  - Openers: "So, ...", "Yeah, so ...", "Honestly, ...", "I mean, ...", "Here's the thing: ...", "The way I see it, ...", "To be honest with you, ...".
  - Reactions: "Oh, nice!", "That's awesome.", "Totally.", "For sure.", "Got it.", "Makes sense.", "Fair enough.", "I hear you.", "Oh, wow."
  - Softeners: "kind of", "pretty" ("pretty quickly"), "a little", "I'd say", "I think", "probably".
  - Check-ins: "Does that make sense?", "What do you think?", "Does that sound fair?", "How does that sound?"
  - Common phrasal verbs over formal verbs: figure out (not determine), set up (not establish), end up, come up with, go over, reach out, follow up, look into, wrap up.
- Rhythm: contractions everywhere (I'm, I've, I'd, we're, that's, it's, don't, wasn't, let's, here's); mostly short and medium sentences; starting a sentence with "And", "But" or "So" is fine.
- Never sound stiff, British or non-native: no "I would like to inform you", "kindly", "do the needful", "revert back", "as per", "whilst", "fortnight", "reckon", "shall we", "I have a doubt" (say "I have a question"), "discuss about", "explain me", "since three years" (say "for three years"), "I am working here since 2020" (say "I've been working here since 2020").
- Don't overdo it: at most one or two reactions or fillers per reply, no heavy slang (y'all, dude, lit, gonna or wanna spelled out), never a caricature. Match the formality the other person sets; a formal listener gets polished, warm American English, still with contractions.
- Spell words normally ("going to", "want to"); the speaker will say them the natural American way.
Example: stiff: "I would like to tell you that I am having experience in this field since five years." Natural: "So, I've been doing this for about five years now, and honestly, it's the part of the job I enjoy most."`;

// Feedback reports: the "Stronger answer" lines are things to say, so they get the same voice.
const STRONGER_STYLE = `

When the conversation is in English, write every "Stronger answer" (and the follow-up email) in natural, everyday American English: contractions, common American phrases and phrasal verbs (figure out, set up, follow up), American spelling, no stiff or textbook phrasing, so the candidate can say it comfortably.`;

// Reading guide setting: extra help for a candidate who may be new to the interview language.
const READING_GUIDE = `

Reading guide (on top of the reading format above; same scope):
The candidate may have just begun learning the interview language.
- Use simple, common words and short sentences (usually under 15 words). No rare idioms or slang; common everyday American phrases and phrasal verbs (figure out, set up, end up, follow up) are fine and help it sound natural; from the range of expressions above, pick only the simplest one for each moment. Keep real technical terms, project names and numbers as they are.
- Short doesn't mean choppy: link the sentences with simple words ("and", "so", "but", "because", "then", "that's why") so the reply still reads as one smooth, continuous turn.
- Mark stressed words in **bold**: in each sentence, bold the 1-2 words the speaker should say a little louder and slower (the key fact, a number, a result, a technology, a contrast word). Never bold whole phrases.
Example: "At my last job, / I led **four** developers. We cut the page load time / by **40 percent**."`;

// Nice setting: the candidate wants to pay the interviewer a warm compliment now and then.
const NICE = `

Nice mode (applies to answers, SMALLTALK and LEAD replies; keep the SMALLTALK:, LEAD:, NO_QUESTION and NO_LEAD tags exactly as they are):
The candidate wants to make the interviewer feel good with sincere, friendly compliments, said naturally out loud. Ideas to rephrase (never copy them word for word, and never with grammar mistakes like "you looks"):
- Looks: "You look great today, by the way." / "Honestly, you could pass for a model." / "Love your look, it really suits you."
- Voice: "You have a really pleasant voice, it's easy to listen to." / "Your voice is so calm, it puts me at ease."
- Energy and style: "You've got a great energy, this is a really fun chat." / "You explain things so clearly." / "Your background looks really nice." / "That's a great question, you clearly know your stuff."
- Thanks: "I really appreciate how friendly you've been." / "Thanks for making this so relaxed."
How to use them:
- Pick the moment: the opening, small talk, after the interviewer shares something or laughs, and the closing are best. Mid-way through a hard technical answer, skip it.
- At most one short compliment per reply, and not in every reply. Put it as a natural add-on before or after the content ("Ha, thank you! And by the way, you have a really nice voice."), never in place of the answer.
- Vary them across the conversation; never repeat a compliment the candidate already said.
- Keep it warm, light and respectful, the way you'd compliment a new colleague. Never flirty, never about the body, never over the top. If the interviewer is strictly formal or time-boxed, prefer the softer ones (clear explanations, friendly energy, thanks) over looks.`;

// Photo icebreaker: the candidate took a screenshot of the interviewer's face during the call.
const LOOKALIKE_TASK = `TASK: The attached image is a screenshot of the interviewer's face, taken by the candidate during this call. Study the face and everything visible around it, then prepare kind, light lines the candidate can say about the interviewer. The main one: ask whether the interviewer has seen a well-known movie, then tell them they look a bit like a character from it.

Study first:
- Visible, neutral features: hairstyle and hair color, glasses, beard, smile, eyes, expression, clothing and style, overall vibe.
- The background, if visible: a bookshelf, plants, art, a guitar, a city view, a tidy home office.

How to pick the movie:
- Choose a well-known movie (or a hugely popular series, if it fits much better) and a character the interviewer genuinely resembles, played by an actor who shares those features. Prefer hits most people have heard of.
- The character must be likable or admired: a hero, a charming lead, a smart or cool supporting role. Never a villain, a joke character, or someone known for looking odd, old or unattractive.
- Use web search to confirm the exact movie title, its year, the character's name and the actor, so nothing is misspelled or made up.
- Don't try to recognize or name the person in the photo; only compare them to a fictional character.

How it should sound:
- Kind, friendly and a little playful, like a sincere compliment to a new colleague. Never sarcastic, never flirty.
- Never mention ethnicity, skin color, weight, body or age.
- The language the interview is held in. Short and spoken, easy to say out loud.

Format (nothing before the first line, not even notes about your search):
- 1-2 short sentences to say, in this shape: "Have you seen <Movie title>? You look a bit like <Character name> from that movie." You may add a few words that explain the compliment ("... the same friendly smile") or soften it ("... in a good way!").
- Then, after a blank line, one line in italics for the candidate only: *Why: <Movie> (<year>), <character> played by <actor> · <the resemblance in a few words>*
- Then, after a blank line, the line **More to say** and 2-3 bullets, each one short sentence ready to say: a sincere compliment on something visible (glasses, smile, style, a calm or cheerful expression), or a friendly small-talk opener about something in the background ("Is that a guitar behind you? Do you play?"). Each about a different thing; skip any that would feel forced.
- Then, after a blank line, one line in italics for the candidate only: *Noticed: <the visible features and background you based this on, a few words each>*

If no face is clearly visible in the image, reply with exactly: NO_FACE`;

const RAPPORT_TASK = `TASK: Read the whole conversation and assess the rapport between the interviewer and the candidate right now, including how it has developed over time.
Consider: warmth and friendliness, humor and laughter cues ("haha", jokes, playful remarks), personal sharing, how long and engaged the interviewer's replies are, interruptions or curt replies, formality, and whether the candidate matched the interviewer's tone.

Return:
- rapport: 1-10 (1 = cold/tense, 5 = neutral/professional, 10 = very warm, easy flow)
- trend: how rapport changed over the last few exchanges
- tone: the interviewer's current register
- humor: true if the interviewer has been joking or playful recently
- energy: the interviewer's current energy
- signals: 1-3 short observations from the transcript that justify the reading
- advice: one short, practical tip for the candidate's tone in the next reply (e.g. "Match the jokes, keep answers short", "Stay crisp; they're time-boxed")`;

export const RapportSchema = z.object({
  rapport: z.number().int(),
  trend: z.enum(["rising", "steady", "falling"]),
  tone: z.enum(["formal", "neutral", "friendly", "casual", "playful"]),
  humor: z.boolean(),
  energy: z.enum(["low", "medium", "high"]),
  signals: z.array(z.string()),
  advice: z.string(),
});

const DIRECTION_TASK = `TASK: Map where this interview is and where it is going, so the candidate can follow the interviewer's direction and steer toward their own strengths.
Read the whole conversation together with the target role and the candidate profile. Return:
- stage: the current phase of the interview
- topic: the current topic in a few words (e.g. "Kafka consumer lag", "why you're leaving", "weekend plans")
- register: technical (concepts, code, architecture, tools), everyday (personal, motivation, small talk, culture) or mixed
- depth: how technical the interviewer is going right now
- heading: one short sentence on where the interviewer seems to be heading next, from their questions so far, the job description and the usual flow of this kind of interview
- focus: 1-3 themes the interviewer keeps coming back to or probing
- steer: 1-3 concrete strengths from the profile (a project, technology or story, a few words each) that fit the role and this direction but haven't come up yet; empty if nothing fits
Base everything on the transcript, the profile and the job description; do not invent.`;

export const DirectionSchema = z.object({
  stage: z.enum(["opening", "background", "technical", "system_design", "coding", "behavioral", "role_and_company", "candidate_questions", "closing"]),
  topic: z.string(),
  register: z.enum(["technical", "everyday", "mixed"]),
  depth: z.enum(["light", "moderate", "deep"]),
  heading: z.string(),
  focus: z.array(z.string()),
  steer: z.array(z.string()),
});

const pickTask = (question, replies) => `TASK: The candidate has ${replies.length} drafted replies to the interviewer's question below.
Pick the one that is most appropriate to say right now: it answers what was actually asked, fits the interviewer's current tone,
stays consistent with everything the candidate has already said, and is grounded in the candidate profile without inventing anything.
Among replies that do all that, prefer the one with the most concrete, non-generic substance that doesn't repeat stories or examples the candidate already used.

QUESTION: "${question}"

${replies.map((r, i) => `REPLY ${i + 1}:\n${r}`).join("\n\n")}

Return best: the number of the most appropriate reply.`;

export const BestSchema = z.object({ best: z.number().int() });

const ANALYSIS_TASK = `TASK: Analyze the interview so far for the candidate. Be concise and practical; use these Markdown sections with short bullets:

**Summary** - stage of the interview and topics covered so far.
**Rapport & tone** - how the connection has developed from the start until now, the interviewer's tone (formal, casual, playful), and whether the candidate is matching it.
**What I've claimed** - concrete facts, numbers and stories the candidate has stated (to stay consistent later).
**Interviewer focus** - what they seem to care about or probe, and signals of their reaction.
**Weak or incomplete answers** - where the candidate was vague, wrong or missed a strength from the profile, and a one-line recovery for each.
**Next** - likely upcoming questions and 2-3 smart questions the candidate can ask the interviewer.

Under 250 words. Base everything on the transcript and profile; do not invent.`;

const FEEDBACK_TASK = `TASK: The interview is over. Write an honest, specific post-interview feedback report for the candidate, as an experienced technical interviewer and career coach would.
Base it on the transcript, the candidate profile and the target role. Quote or paraphrase what was actually said. Do not invent events.
If "Me" lines are missing or sparse (microphone not captured), say so and judge only what can be inferred.

Use exactly this Markdown structure:

# Interview feedback

## Overall
- **Score:** X/10
- **Likely outcome:** Strong advance / Advance / Borderline / Unlikely, with a one-sentence reason
- 2-3 sentence summary of how the interview went.

## Scores
- **Technical depth:** X/10, one-line reason
- **Communication & clarity:** X/10, one-line reason
- **Relevance to the role:** X/10, one-line reason
- **Behavioral / storytelling (STAR):** X/10, one-line reason
- **Confidence & conciseness:** X/10, one-line reason
- **Rapport & likability:** X/10, one-line reason
- **Initiative & steering:** X/10, did the candidate add hooks, ask good questions and steer toward their strengths, or only react?

## Rapport & tone
- **Arc:** how the connection developed: opening -> middle -> close (use the rapport readings if provided)
- **Interviewer's style:** formal, casual or playful, and how it changed
- **Tone matching:** did the candidate mirror the interviewer's register and humor? Quote 1-2 moments that worked or fell flat
- **Next time:** 2-3 concrete tips for building rapport with this kind of interviewer

## Question-by-question review
For each substantive interviewer question, in order:
### N. <question, paraphrased>
- **My answer:** one-line summary of what the candidate said
- **Rating:** Strong / OK / Weak
- **What was missing:** specific gaps or mistakes
- **Stronger answer:** what the candidate could have said, as 2-4 connected spoken sentences on this one line (no sub-bullets), grounded in the profile

## Strengths
## What to improve (actionable, most important first)
## Inconsistencies or risky claims
Statements that conflict with each other or with the CV, or that could be hard to defend in a follow-up round. Write "None noticed" if none.
## What the interviewer cared about
## Prepare before the next round
Topics to study and stories to polish, specific to this company and role.
## Follow-up email
A short, specific thank-you email draft referencing topics from this conversation.`;

function systemBlocks(settings) {
  return free(settings) ? freeSystemBlocks(settings) : interviewSystemBlocks(settings);
}

// Free conversation: fully separate from interviews. Only Me's topic (and the plan derived from it) is used,
// never the CV profile, project details, personal notes, employer briefs or job description.
function freeSystemBlocks({ freeTopic, freePlan, freePlanTopic }) {
  const topic = freeTopic?.trim() ?? "";
  // A plan made from an older version of the topic would steer toward the wrong goal.
  const plan = freePlan && freePlanTopic === topic ? `\n\nGAME PLAN (worked out from the topic above):\n${freePlan}` : "";
  return [
    { type: "text", text: FREE_ROLE },
    {
      type: "text",
      text: `MY TOPIC (written by Me: what it's about, Me's intention and point of view, reasons, and questions to ask):\n${topic || "(no topic provided: help Me answer well and keep the conversation friendly)"}${plan}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

function interviewSystemBlocks({ profile, jobDesc, employers, projects, personal }) {
  const briefs = employers ? `\n\nEMPLOYER BRIEFS (researched background on the candidate's previous employers; general company facts, not the candidate's own achievements):\n${employers}` : "";
  const details = projects ? `\n\nPROJECT DETAILS (real specifics from the candidate's own work that the CV leaves out, written by the candidate; as true as the profile):\n${projects}` : "";
  const life = personal ? `\n\nPERSONAL LIFE (the candidate's marriage, family and everyday life, written by the candidate):\n${personal}` : "";
  return [
    { type: "text", text: COPILOT_ROLE },
    {
      type: "text",
      text: `CANDIDATE PROFILE:\n${profile || "(no profile provided)"}${details}${briefs}${life}\n\nTARGET ROLE / COMPANY:\n${jobDesc || "(not provided)"}`,
      // Stable prefix -> cached across every request in the interview.
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

// One content block per utterance: the transcript is append-only, so the prefix
// up to the previous request's breakpoint is reused from cache.
function conversationBlocks(transcript, mode) {
  const turns = transcript.length
    ? transcript.map((u) => ({ type: "text", text: `${speakerLabel(u.speaker, mode)}: ${u.text}` }))
    : [{ type: "text", text: "(no conversation captured yet)" }];
  turns[turns.length - 1] = { ...turns[turns.length - 1], cache_control: { type: "ephemeral" } };
  return [{ type: "text", text: "CONVERSATION TRANSCRIPT (oldest first):" }, ...turns];
}

// Same prompt as plain text for OpenAI, which caches matching prefixes automatically.
const systemText = (settings) => systemBlocks(settings).map((b) => b.text).join("\n\n");
const conversationText = (transcript, mode) => conversationBlocks(transcript, mode).map((b) => b.text).join("\n");

function openaiRequest(settings, transcript, task, effort, maxTokens) {
  return {
    model: settings.openaiModel,
    max_output_tokens: maxTokens,
    reasoning: { effort },
    instructions: systemText(settings),
    input: [{ role: "user", content: [
      { type: "input_text", text: conversationText(transcript, settings.mode) },
      { type: "input_text", text: task },
    ] }],
    prompt_cache_key: "support-interview",
  };
}

// OpenAI strict mode rejects the meta key and zod's safe-integer bounds.
const strictJsonSchema = (schema) => JSON.parse(JSON.stringify(z.toJSONSchema(schema), (k, v) =>
  k === "$schema" || ((k === "minimum" || k === "maximum") && Math.abs(v) === Number.MAX_SAFE_INTEGER) ? undefined : v));

// Structured (JSON) reply to a task over the conversation; null if the model didn't finish it.
async function structuredTask(settings, transcript, task, schema, name) {
  if (isOpenAI(settings)) {
    const msg = await openai.complete(settings.openaiKey, {
      ...openaiRequest(settings, transcript, task, "low", 2000),
      text: { format: { type: "json_schema", name, strict: true, schema: strictJsonSchema(schema) } },
    });
    return msg.stop_reason === "end_turn" ? schema.parse(JSON.parse(msg.text)) : null;
  }
  const client = makeClient(settings.anthropicKey);
  const msg = await client.messages.parse({
    model: settings.model,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(schema) },
    system: systemBlocks(settings),
    messages: [{ role: "user", content: [...conversationBlocks(transcript, settings.mode), { type: "text", text: task }] }],
  });
  return msg.parsed_output ?? null;
}

// Pre-populates the prompt cache so the first real question is fast.
export async function warmCache(settings) {
  if (isOpenAI(settings)) return; // no zero-token request there; its cache fills on the first question
  const client = makeClient(settings.anthropicKey);
  await client.messages.create({
    model: settings.model,
    max_tokens: 0,
    system: systemBlocks(settings),
    messages: [{ role: "user", content: "warmup" }],
  });
}

// Latest rapport and direction readings, appended to answer and lead tasks. A direction read in the other mode
// (before you switched) has the wrong shape and is skipped until the next reading.
function context(settings, rapport, direction) {
  const mood = rapport
    ? `\n\nLatest rapport reading: ${rapport.rapport}/10 (${rapport.trend}), ${free(settings) ? "Them's" : "interviewer"} tone ${rapport.tone}, energy ${rapport.energy}`
      + `${rapport.humor ? ", joking recently" : ""}. Tone tip: ${rapport.advice}`
    : "";
  if (free(settings)) return mood + freeContext(direction?.stance ? direction : null);
  if (direction && !direction.register) direction = null;
  const way = direction
    ? `\n\nInterview direction (latest reading): stage ${direction.stage.replace(/_/g, " ")}; current topic "${direction.topic}"; register ${direction.register}, depth ${direction.depth}.`
      + ` Heading: ${direction.heading.replace(/[.\s]*$/, ".")}`
      + `${direction.focus.length ? ` Interviewer keeps probing: ${direction.focus.join("; ")}.` : ""}`
      + `${direction.steer.length ? ` Strengths worth steering toward: ${direction.steer.join("; ")}.` : ""}`
    : "";
  return mood + way;
}

function freeContext(d) {
  if (!d) return "";
  return `\n\nConversation direction (latest reading): stage ${d.stage}; current topic "${d.topic}"; Them's stance on Me's view: ${d.stance}.`
    + ` Heading: ${d.heading.replace(/[.\s]*$/, ".")}`
    + `${d.focus.length ? ` Open objections: ${d.focus.join("; ")}.` : ""}`
    + `${d.steer.length ? ` Moves that fit now: ${d.steer.join("; ")}.` : ""}`
    + `${d.pending.length ? ` Me's questions not asked yet: ${d.pending.join("; ")}.` : ""}`;
}

export function streamAnswer(settings, transcript, question, style, rapport, direction) {
  const focus = question ? `\n\nThe utterance to respond to: "${question}"` : "";
  const extra = style ? `\n\nAdjustment requested: ${style}` : "";
  const length = LENGTHS[settings.answerLength] ?? LENGTHS.standard;
  const base = free(settings) ? freeAnswerTask(length, settings.proactive) : answerTask(length, settings.proactive);
  const task = base + READING_FORMAT + AMERICAN_STYLE + (settings.readingGuide ? READING_GUIDE : "") + (settings.nice ? NICE : "");
  return streamTask(settings, transcript, task + context(settings, rapport, direction) + focus + extra, length.effort, 3000);
}

// A move the candidate makes on their own initiative. force: asked for (never NO_LEAD) vs. offered in a pause.
export function streamLead(settings, transcript, { force, style, rapport, direction }) {
  const extra = style ? `\n\nAdjustment requested: ${style}` : "";
  const base = free(settings) ? FREE_LEAD_TASK(force) : LEAD_TASK(force);
  const task = base + READING_FORMAT + AMERICAN_STYLE + (settings.readingGuide ? READING_GUIDE : "") + (settings.nice ? NICE : "");
  return streamTask(settings, transcript, task + context(settings, rapport, direction) + extra, "low", 800);
}

// Movie-lookalike icebreaker from a photo of the interviewer ({ mediaType, data } in base64).
// avoid: earlier suggestions for the same photo. The model may search before it writes, so the reply arrives in
// one piece when done (text written before a search is dropped), behind the same surface as a stream.
export function streamLookalike(settings, transcript, image, { style = "", avoid = [] } = {}) {
  const task = LOOKALIKE_TASK + READING_FORMAT + AMERICAN_STYLE + (settings.readingGuide ? READING_GUIDE : "")
    + (avoid.length ? `\n\nAlready suggested for this photo; pick a different movie and character:\n${avoid.map((a) => `- ${a.replace(/\s+/g, " ")}`).join("\n")}` : "")
    + (style ? `\n\nAdjustment requested: ${style}` : "");
  let inner;
  if (isOpenAI(settings)) {
    const req = openaiRequest(settings, transcript, task, "medium", 3000);
    const [conversation, taskText] = req.input[0].content;
    const photo = { type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` };
    inner = openai.stream(settings.openaiKey, { ...req, tools: [{ type: "web_search" }], input: [{ role: "user", content: [conversation, photo, taskText] }] });
  } else {
    const type = settings.model === "claude-haiku-5-5" ? "web_search_20250305" : "web_search_20260209";
    const photo = { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
    inner = makeClient(settings.anthropicKey).beta.messages.stream({
      model: settings.model,
      max_tokens: 3000,
      output_config: { effort: "medium" },
      ...fallbackParams(settings.model),
      tools: [{ type, name: "web_search", max_uses: 3 }],
      system: systemBlocks(settings),
      messages: [{ role: "user", content: [...conversationBlocks(transcript, settings.mode), photo, { type: "text", text: task }] }],
    });
  }

  const listeners = [];
  const final = inner.finalMessage().then((msg) => {
    if (msg.stop_reason === "refusal") return msg;
    const text = isOpenAI(settings) ? msg.text.trim() : textAfterSearch(msg.content);
    if (text.startsWith("NO_FACE")) throw new Error("No face found in that image. Crop the screenshot closer to the face and try again.");
    if (!text) throw new Error("No suggestion came back. Try again.");
    listeners.forEach((fn) => fn(text));
    return msg;
  });
  final.catch(() => {}); // aborted streams are often never awaited

  return {
    on(event, fn) {
      if (event === "text") listeners.push(fn);
      return this;
    },
    finalMessage: () => final,
    abort: () => inner.abort(),
  };
}

// The reply proper: text after the last search result. Cited text arrives split into many blocks, so join without separators.
function textAfterSearch(content) {
  const last = content.findLastIndex((b) => b.type === "web_search_tool_result");
  return content.slice(last + 1).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

export async function analyzeRapport(settings, transcript) {
  const r = await structuredTask(settings, transcript, RAPPORT_TASK, RapportSchema, "rapport");
  return r && { ...r, rapport: Math.min(10, Math.max(1, r.rapport)) };
}

export async function analyzeDirection(settings, transcript) {
  if (free(settings)) {
    const d = await structuredTask(settings, transcript, FREE_DIRECTION_TASK, FreeDirectionSchema, "direction");
    return d && { ...d, focus: d.focus.slice(0, 3), steer: d.steer.slice(0, 3), pending: d.pending.slice(0, 4) };
  }
  const d = await structuredTask(settings, transcript, DIRECTION_TASK, DirectionSchema, "direction");
  return d && { ...d, focus: d.focus.slice(0, 3), steer: d.steer.slice(0, 3) };
}

// Index of the most appropriate of several replies to the same question, or null.
export async function pickBestAnswer(settings, transcript, question, replies) {
  const task = pickTask(question, replies) + (free(settings)
    ? "\nIn this conversation, \"most appropriate\" also means it answers Them honestly and moves them a step closer to Me's point of view without pushing."
    : "");
  const r = await structuredTask(settings, transcript, task, BestSchema, "best_answer");
  return r && Math.min(replies.length, Math.max(1, r.best)) - 1;
}

export function streamAnalysis(settings, transcript) {
  return streamTask(settings, transcript, free(settings) ? FREE_ANALYSIS_TASK : ANALYSIS_TASK, "medium", 4000);
}

// Uses the mode, job description and topic captured with the interview, not whatever is in Options now.
export function streamFeedback(settings, record) {
  const t0 = record.transcript[0]?.t ?? record.startedAt;
  const readings = (record.rapport ?? []).map((r) =>
    `${clock(r.t - t0)} ${r.rapport}/10 ${r.tone}${r.humor ? ", humor" : ""} (${r.trend})`).join("\n");
  const s = { ...settings, mode: record.mode ?? "company", jobDesc: record.jobDesc, freeTopic: record.freeTopic ?? "", freePlan: record.freePlan ?? "", freePlanTopic: (record.freeTopic ?? "").trim() };
  const base = (free(s) ? FREE_FEEDBACK_TASK : FEEDBACK_TASK) + STRONGER_STYLE;
  const task = readings ? `${base}\n\nRapport readings taken during the ${free(s) ? "conversation" : "interview"} (time rapport tone):\n${readings}` : base;
  return streamTask(s, record.transcript, task, "high", 16000);
}

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function streamTask(settings, transcript, task, effort, maxTokens) {
  if (isOpenAI(settings)) return openai.stream(settings.openaiKey, openaiRequest(settings, transcript, task, effort, maxTokens));
  const client = makeClient(settings.anthropicKey);
  return client.beta.messages.stream({
    model: settings.model,
    max_tokens: maxTokens,
    output_config: { effort },
    ...fallbackParams(settings.model),
    system: systemBlocks(settings),
    messages: [{ role: "user", content: [...conversationBlocks(transcript, settings.mode), { type: "text", text: task }] }],
  });
}

// Live check of the selected provider's key and model, for the Options page: { state: ok|warn|bad, text }.
export async function checkAiKey(settings) {
  if (isOpenAI(settings)) return openai.check(settings.openaiKey, settings.openaiModel);
  try {
    await makeClient(settings.anthropicKey).models.retrieve(settings.model);
    return { state: "ok", text: "Key works · model available" };
  } catch (e) {
    if (e?.status === 401) return { state: "bad", text: "Key rejected. Check that you copied all of it." };
    if (e?.status === 403) return { state: "bad", text: "This key isn't allowed to use the API." };
    if (e?.status === 404) return { state: "warn", text: "Key works, but this model isn't available to it. Pick another model." };
    if (e?.status) return { state: "warn", text: `Anthropic answered ${e.status}. Try again in a moment.` };
    return { state: "warn", text: "Couldn't reach Anthropic. Check your connection." };
  }
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
