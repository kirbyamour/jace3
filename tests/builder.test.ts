import { describe, it, expect } from "vitest";
import { buildSystemPrompt, trimRecent } from "../lib/context/builder";

describe("context builder", () => {
  it("includes constitution, exemplars, date, and profile facts", () => {
    const { system, personaVersion } = buildSystemPrompt({
      recentMessages: [],
      todayISO: "2026-07-01",
      profileFacts: [{ key: "nickname", value: "lovebug" }],
    });
    expect(system).toContain("Persona Constitution");
    expect(system).toContain("Exemplars");
    expect(system).toContain("2026-07-01");
    expect(system).toContain("nickname: lovebug");
    expect(personaVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("never hard-codes a provider into the persona", () => {
    const { system } = buildSystemPrompt({ recentMessages: [], todayISO: "2026-07-01" });
    for (const brand of ["Anthropic", "OpenAI", "Claude", "GPT", "Gemini", "GLM"]) {
      expect(system).not.toContain(brand);
    }
  });

  it("trims to max and starts with a user turn", () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? "assistant" : "user") as const,
      content: `m${i}`,
    }));
    const out = trimRecent(msgs, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out[0].role).toBe("user");
  });
});
