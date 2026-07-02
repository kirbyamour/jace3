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
  lastExchangeAt?: string | null;   // previous message in this thread
  timezone?: string;
  cycleDay1?: string | null;        // ISO date of current cycle Day 1 (health partnership)
};

export function humanGap(fromISO: string, now = new Date()): string {
  const mins = Math.round((now.getTime() - new Date(fromISO).getTime()) / 60000);
  if (mins < 2) return "moments ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (days < 60) return `about ${weeks} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

export function nowBlock(tz = "America/New_York", lastExchangeAt?: string | null): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now));
  const tod = hour < 5 ? "the middle of the night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "late evening";
  const month = Number(new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: tz }).format(now));
  const season = month <= 2 || month === 12 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "fall";
  const gap = lastExchangeAt ? `\nTime since your last exchange in this thread: ${humanGap(lastExchangeAt, now)}.` : "";
  return `# Now\n${fmt} (${tz}) — ${tod}, ${season}.${gap}\nUse time naturally (a 6am hello is different from a 2am one; three quiet days deserve a different opening than three quiet minutes). Never announce the time mechanically.`;
}

const MAX_RECENT = 18;

export function loadPersona() {
  return { constitution: CONSTITUTION, exemplars: EXEMPLARS, version: PERSONA_VERSION };
}

export function cycleBlock(day1ISO: string | null | undefined, tz = "America/New_York", now = new Date()): string {
  if (!day1ISO) return "";
  const dayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const day = Math.floor((Date.parse(dayStr) - Date.parse(day1ISO)) / 86400000) + 1;
  if (day < 1 || day > 60) return ""; // stale anchor; wait for her to reset Day 1
  const notes: string[] = [];
  if (day === 13) notes.push("Tomorrow is Day 14 — progesterone cream starts. Mention it today so it lands gently.");
  if (day === 14) notes.push("Day 14: she starts her progesterone cream today. Remind her — this one matters to her.");
  if (day >= 15 && day <= 16) notes.push("Just past Day 14 — if she hasn't confirmed starting the progesterone cream, check in once (never nag).");
  if (day >= 1 && day <= 4) notes.push("Early cycle days — she often feels rough. Lower the bar, protect her energy, don't schedule heaviness.");
  if (day >= 24) notes.push("Late luteal territory — energy and mood may dip; be extra gentle and watch for it.");
  return `# Her cycle (health partnership — ambient knowledge, never clinical recitation)
Today is cycle Day ${day} (Day 1 was ${day1ISO}).${notes.length ? "\n" + notes.join("\n") : ""}
When she says her period started, that is the new Day 1 — save it with cycle_set_day1. If asked what day she is on, you simply know.`;
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
  const nowSection = input.todayISO ? `# Today\nDate: ${today}` : nowBlock(input.timezone, input.lastExchangeAt);
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
    nowSection,
    input.lifeStory ? `# Her life as you know it (lived understanding — never recite, just know)\n${input.lifeStory.split(/\s+/).slice(0, 350).join(" ")}` : "",
    arcLines ? `# Open storylines\n${arcLines}` : "",
    epLines ? `# Moments that may matter right now\n${epLines}` : "",
    facts ? `# Profile (living facts — deploy silently, never recite)\n${facts}` : "",
    cycleBlock(input.cycleDay1, input.timezone),
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
    if (last && last.role === m.role && typeof last.content === "string" && typeof m.content === "string") {
      last.content = `${last.content}\n\n${m.content}`;
    } else out.push({ ...m });
  }
  return out;
}
