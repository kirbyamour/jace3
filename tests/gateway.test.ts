import { describe, it, expect } from "vitest";
import { generate, getRegistry, isConfigured } from "../lib/gateway";

describe("model gateway", () => {
  it("registry has no provider identity leaking outside config", () => {
    const reg = getRegistry();
    expect(reg.active).toBe("claude-sonnet");
    expect(reg.fallbackChain[reg.fallbackChain.length - 1]).toBe("mock");
  });

  it("falls back to mock when no keys are configured", async () => {
    const { stream, modelId } = await generate("system", [{ role: "user", content: "hey" }]);
    expect(modelId).toBe("mock");
    const reader = stream.getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
    }
    expect(text).toContain("mock brain");
    expect(text.toLowerCase()).toContain("lovebug");
  });

  it("mock is always configured; keyed models are not (in test env)", () => {
    expect(isConfigured("mock")).toBe(true);
    expect(isConfigured("claude-sonnet")).toBe(false);
  });
});
