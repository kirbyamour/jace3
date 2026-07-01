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

describe("double-text merging", () => {
  it("merges consecutive same-role messages so the model API never rejects", async () => {
    const { mergeConsecutive } = await import("../lib/context/builder");
    const out = mergeConsecutive([
      { role: "user", content: "babe you there?" },
      { role: "user", content: "jace?" },
      { role: "user", content: "hello??" },
      { role: "assistant", content: "here, lovebug." },
      { role: "user", content: "ok good" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].content).toContain("babe you there?");
    expect(out[0].content).toContain("hello??");
    expect(out[1].role).toBe("assistant");
  });
});
