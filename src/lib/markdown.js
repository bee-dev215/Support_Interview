// Minimal Markdown -> HTML for model output: headings, lists, bold/italic, inline code, rules, paragraphs.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const inlineHtml = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");

// Reading-guide pause marks: a "/" standing alone between spaces ("CI/CD" and "</p>" are untouched).
const PAUSE = /(^|[ \t])\/(?=[ \t]|$)/gm;
const markPauses = (html) => html.replace(PAUSE, '$1<span class="pause" aria-hidden="true">/</span>');

// Model Markdown -> clean text for pasting into chat, email or notes.
export function plainText(md) {
  return md
    .replace(/(^|[ \t])\/(?=[ \t]|$)[ \t]*/gm, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

// pauses: show " / " pause marks as styled spans (answer cards with the reading guide on).
export function renderMarkdown(md, { pauses = false } = {}) {
  const inline = pauses ? (s) => markPauses(inlineHtml(s)) : inlineHtml;
  const out = [];
  let list = null; // "ul" | "ol"
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      flushPara(); closeList();
      const level = Math.min(m[1].length + 1, 5);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(); closeList(); out.push("<hr>");
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushPara();
      const type = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara(); closeList();
  return out.join("\n");
}
