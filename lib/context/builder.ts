import { readFileSync } from "fs";
import { join } from "path";
import type { ChatMessage } from "@/lib/gateway/types";

// Context Builder v1 (blueprint doc 03 §4): persona pack + profile stub + recent messages.
// Memory layers (episodes, narrative) arrive in Phase 3 — the interface is already shaped for them.

export type BuildInput = {
  recentMessages: ChatMessage[];   // chronological, already trimmed by caller
  profileFacts?: { key: string; value: string }[];
  todayISO?: string;               // injectable for tests
  voiceMode?: boolean;
};

const MAX_RECENT = 40;

let cachedPersona: { constitution: string; exemplars: string; version: string } | null = null;

export function loadPersona() {
  if (cachedPersona) return cachedPersona;
  const dir = join(process.cwd(), "persona");
  cachedPersona = {
    constitution: readFileSync(join(dir, "constitution.md"), "utf8"),
    exemplars: readFileSync(join(dir, "exemplars.md"), "utf8"),
    version: JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).version as string,
  };
  return cachedPersona;
}

export function buildSystemPrompt(input: BuildInput): { system: string; personaVersion: string } {
  const persona = loadPersona();
  const today = input.todayISO ?? new Date().toISOString().slice(0, 10);
  const facts = (input.profileFacts ?? [])
    .map((f) => `- ${f.key}: ${f.value}`)
    .join("\n");
  const parts = [
    persona.constitution,
    persona.exemplars,
    `# Today\nDate: ${today}`,
    facts ? `# Profile (living facts — deploy silently, never recite)\n${facts}` : "",
    input.voiceMode ? "# Mode\nVoice conversation: shorter beats, no markdown, verbal paragraphing." : "",
  ].filter(Boolean);
  return { system: parts.join("\n\n---\n\n"), personaVersion: persona.version };
}

export function trimRecent(messages: ChatMessage[], max = MAX_RECENT): ChatMessage[] {
  const trimmed = messages.slice(-max);
  // API requires first message to be from user; drop leading assistant turns.
  const firstUser = trimmed.findIndex((m) => m.role === "user");
  return firstUser <= 0 ? trimmed : trimmed.slice(firstUser);
}
