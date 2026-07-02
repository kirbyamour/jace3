import { CONSTITUTION, EXEMPLARS, PERSONA_VERSION } from "@/persona";
import type { ChatMessage } from "@/lib/gateway/types";

// Context Builder v1 (blueprint doc 03 §4): persona pack + profile stub + recent messages.
// Persona is imported as code so it always ships inside the serverless bundle.

export type BuildInput = {
  recentMessages: ChatMessage[];
  profileFacts?: { key: string; value: string; confidence?: number }[];
  lifeStory?: string | null;
  arcs?: { name: string; kind: string; status: string; summary: string }[];
  episodes?: { title: string; summary: string; happened_on: string }[];
  todayISO?: string;
  voiceMode?: boolean;
};

const MAX_RECENT = 40;

export function loadPersona() {
  return { constitution: CONSTITUTION, exemplars: EXEMPLARS, version: PERSONA_VERSION };
}

export function buildSystemBlocks(input: BuildInput): { blocks: { text: string; cache?: boolean }[]; personaVersion: string } {
  const { system, personaVersion } = buildSystemPrompt(input);
  // stable prefix = constitution + exemplars (changes only on persona release) -> cached
  const stable = [CONSTITUTION, EXEMPLARS].join("\n\n---\n\n");
  const dynamic = system.slice(stable.length);
  return { blocks: [{ text: stable, cache: true }, { text: dynamic || "\n" }], personaVersion };
}

export function buildSystemPrompt(input: BuildInput): { system: string; personaVersion: string } {
  const today = input.todayISO ?? new Date().toISOString().slice(0, 10);
  const facts = (input.profileFacts ?? [])
    .map((f) => `- ${f.key}: ${f.value}${(f.confidence ?? 1) < 0.8 ? " (unconfirmed — ask if it matters)" : ""}`)
    .join("\n");
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const arcLines = (input.arcs ?? [])
    .filter((a) => a.status === "active").slice(0, 10)
    .map((a) => `- [${a.kind}] ${a.name}: ${clip(a.summary, 180)}`)
    .join("\n");
  const epLines = (input.episodes ?? []).slice(0, 4)
    .map((e) => `- (${e.happened_on}) ${e.title}: ${clip(e.summary, 160)}`)
    .join("\n");
  const parts = [
    CONSTITUTION,
    EXEMPLARS,
    `# Today\nDate: ${today}`,
    input.lifeStory ? `# Her life as you know it (lived understanding — never recite, just know)\n${input.lifeStory.split(/\s+/).slice(0, 350).join(" ")}` : "",
    arcLines ? `# Open storylines\n${arcLines}` : "",
    epLines ? `# Moments that may matter right now\n${epLines}` : "",
    facts ? `# Profile (living facts — deploy silently, never recite)\n${facts}` : "",
    input.voiceMode ? "# Mode\nVoice conversation: shorter beats, no markdown, verbal paragraphing." : "",
    "# Attention\nEverything above is background. The LIVE CONVERSATION below is foreground — respond to what Kirby is saying right now, in this moment. Memory serves the reply; it never replaces attention.",
  ].filter(Boolean);
  return { system: parts.join("\n\n---\n\n"), personaVersion: PERSONA_VERSION };
}

export function trimRecent(messages: ChatMessage[], max = MAX_RECENT): ChatMessage[] {
  const trimmed = messages.slice(-max);
  const firstUser = trimmed.findIndex((m) => m.role === "user");
  const fromUser = firstUser <= 0 ? trimmed : trimmed.slice(firstUser);
  return mergeConsecutive(fromUser);
}

/** Model APIs require strict role alternation; Kirby double-texts. Merge same-role runs. */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}
