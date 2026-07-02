// M4.6 — the "make it listenable" pass. This is the heart of what Kirby loved
// in 2.0's clean-up button, rebuilt on our gateway with clinical mode kept.

import { generateText } from "@/lib/gateway";

const BASE = `You convert documents into text meant to be LISTENED to, not read.
Rules:
- Keep every substantive idea, finding, argument, and number. Never summarize away content.
- Delete listening garbage: page headers/footers, page numbers, running titles, nav text, cookie/copyright boilerplate, reference lists, inline citation markers like (Smith et al., 2020) or [12], figure/table captions and the tables themselves (instead say in one sentence what the table showed, if it matters).
- Rewrite for the ear: flowing paragraphs, natural sentences, no bullet fragments, no ALL-CAPS headings (turn section headings into a short spoken lead-in like "Next, the methods.").
- Expand abbreviations on first use when a listener would stumble.
- Output plain paragraphs only. No markdown, no headings, no lists.`;

const CLINICAL = `
This is a scientific/clinical document. Additionally:
- Speak statistics like a person: "p = .03" -> "a p-value of point zero three, which is statistically significant". "95% CI 1.2-3.4" -> "with a 95 percent confidence interval from 1.2 to 3.4". "n=142" -> "142 participants". Expand OR/HR/RR as odds ratio / hazard ratio / risk ratio.
- Expand Latin and jargon shorthand: e.g., i.e., et al., vs., mg/kg spoken naturally.
- Keep the study's structure audible: briefly signal background, methods, results, discussion as you pass through them.`;

const CHUNK = 9000; // chars per cleaning call

function splitChunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf("\n\n", CHUNK);
    if (cut < CHUNK * 0.5) cut = rest.lastIndexOf(". ", CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export async function cleanForListening(raw: string, mode: "standard" | "clinical"): Promise<string> {
  const sys = mode === "clinical" ? BASE + CLINICAL : BASE;
  const chunks = splitChunks(raw);
  const cleaned: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const position = chunks.length === 1 ? "" :
      `\n(You are cleaning part ${i + 1} of ${chunks.length} of the same document. Do not add an intro or outro; just continue.)`;
    const { text: out } = await generateText(
      sys + position,
      [{ role: "user", content: `Convert this document text now. Output only the listenable text.\n\n---\n${chunks[i]}` }],
      { maxTokens: 8000 }
    );
    cleaned.push(out.trim());
  }
  return cleaned.join("\n\n");
}

// Split listenable text into TTS-sized paragraphs (~2,200 chars) for
// sentence-streamed playback with prefetch — the Talk Mode trick, scaled up.
export function splitForSpeech(text: string): string[] {
  const paras = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > 2200 && cur) { out.push(cur); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
    while (cur.length > 2600) { // single monster paragraph
      let cut = cur.lastIndexOf(". ", 2200);
      if (cut < 800) cut = 2200;
      out.push(cur.slice(0, cut + 1)); cur = cur.slice(cut + 1).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}
