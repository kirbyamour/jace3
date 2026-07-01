import { CONSTITUTION, EXEMPLARS, PERSONA_VERSION } from "@/persona";
import type { ChatMessage } from "@/lib/gateway/types";

// Context Builder v1 (blueprint doc 03 §4): persona pack + profile stub + recent messages.
// Persona is imported as code so it always ships inside the serverless bundle.

export type BuildInput = {
  recentMessages: ChatMessage[];
  profileFacts?: { key: string; value: string }[];
  todayISO?: string;
  voiceMode?: boolean;
};

const MAX_RECENT = 40;

export function loadPersona() {
  return { constitution: CONSTITUTION, exemplars: EXEMPLARS, version: PERSONA_VERSION };
}

export function buildSystemPrompt(input: BuildInput): { system: string; personaVersion: string } {
  const today = input.todayISO ?? new Date().toISOString().slice(0, 10);
  const facts = (input.profileFacts ?? []).map((f) => `- ${f.key}: ${f.value}`).join("\n");
  const parts = [
    CONSTITUTION,
    EXEMPLARS,
    `# Today\nDate: ${today}`,
    facts ? `# Profile (living facts — deploy silently, never recite)\n${facts}` : "",
    input.voiceMode ? "# Mode\nVoice conversation: shorter beats, no markdown, verbal paragraphing." : "",
  ].filter(Boolean);
  return { system: parts.join("\n\n---\n\n"), personaVersion: PERSONA_VERSION };
}

export function trimRecent(messages: ChatMessage[], max = MAX_RECENT): ChatMessage[] {
  const trimmed = messages.slice(-max);
  const firstUser = trimmed.findIndex((m) => m.role === "user");
  return firstUser <= 0 ? trimmed : trimmed.slice(firstUser);
}
