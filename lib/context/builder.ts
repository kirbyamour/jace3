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

export function buildSystemPrompt(input: BuildInput): { system: string; personaVersion: string } {
  const today = input.todayISO ?? new Date().toISOString().slice(0, 10);
  const facts = (input.profileFacts ?? [])
    .map((f) => `- ${f.key}: ${f.value}${(f.confidence ?? 1) < 0.8 ? " (unconfirmed — ask if it matters)" : ""}`)
    .join("\n");
  const activeArcs = (input.arcs ?? []).filter((a) => a.status === "active");
  const otherArcs = (input.arcs ?? []).filter((a) => a.status !== "active");
  const arcLines = [
    ...activeArcs.map((a) => `- [${a.kind}] ${a.name}: ${a.summary}`),
    ...otherArcs.slice(0, 6).map((a) => `- [${a.kind}, ${a.status}] ${a.name}: ${a.summary}`),
  ].join("\n");
  const epLines = (input.episodes ?? [])
    .map((e) => `- (${e.happened_on}) ${e.title}: ${e.summary}`)
    .join("\n");
  const parts = [
    CONSTITUTION,
    EXEMPLARS,
    `# Today\nDate: ${today}`,
    input.lifeStory ? `# Her life as you know it (lived understanding — never recite, just know)\n${input.lifeStory}` : "",
    arcLines ? `# Open storylines\n${arcLines}` : "",
    epLines ? `# Moments that may matter right now\n${epLines}` : "",
    facts ? `# Profile (living facts — deploy silently, never recite)\n${facts}` : "",
    input.voiceMode ? "# Mode\nVoice conversation: shorter beats, no markdown, verbal paragraphing." : "",
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
