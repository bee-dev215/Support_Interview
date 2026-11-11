// Cheap first-pass filter on interviewer speech. Anything not obviously filler goes to Claude,
// which decides between answering, a casual small-talk reply, or NO_QUESTION.
const FILLER = /^(ok(ay)?|right|sure|great|cool|nice|perfect|got it|i see|mm+-?hm+|uh-?huh|yeah|yes|no|thanks|thank you|alright|awesome|sounds good)[.!?]*$/i;
const HUMOR = /\b(ha(ha)+|lol|lmao|hehe|just kidding|kidding|joke|funny|hilarious)\b|😂|😄/i;

export function classify(text) {
  const t = text.trim();
  if (t.split(/\s+/).length < 2 || FILLER.test(t)) return "skip";
  return HUMOR.test(t) ? "humor" : "respond";
}
