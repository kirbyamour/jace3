import registryJson from "@/config/models.json";
import type { Adapter, ChatMessage, GenerateOptions, GenerateResult, ModelRegistry } from "./types";
import { anthropicAdapter } from "./anthropic";
import { openaiCompatibleAdapter } from "./openai-compatible";
import { mockAdapter } from "./mock";

const registry = registryJson as unknown as ModelRegistry;

const adapters: Record<string, Adapter> = {
  anthropic: anthropicAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  mock: mockAdapter,
};

export function getRegistry(): ModelRegistry { return registry; }

export function isConfigured(modelId: string): boolean {
  const entry = registry.models[modelId];
  if (!entry) return false;
  if (entry.adapter === "mock") return true;
  return Boolean(entry.envKey && process.env[entry.envKey]);
}

/** Generate with explicit model, or walk the fallback chain from config. */
export async function generate(
  system: string,
  messages: ChatMessage[],
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const chain = opts.modelId ? [opts.modelId] : [registry.active, ...registry.fallbackChain];
  const tried = new Set<string>();
  let lastErr: unknown = null;
  for (const id of chain) {
    if (tried.has(id)) continue;
    tried.add(id);
    const entry = registry.models[id];
    if (!entry) continue;
    if (!isConfigured(id)) { lastErr = new Error(`${id} not configured`); continue; }
    try {
      const stream = await adapters[entry.adapter](entry, system, messages, opts);
      return { stream, modelId: id };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("no model available");
}

/** Collect a full (non-streaming) completion — for background/utility work. */
export async function generateText(
  system: string,
  messages: ChatMessage[],
  opts: GenerateOptions = {}
): Promise<{ text: string; modelId: string }> {
  const utility = (registry as unknown as { utility?: string }).utility;
  const chain = opts.modelId ? [opts.modelId] : [utility ?? registry.active, registry.active, ...registry.fallbackChain];
  let lastErr: unknown = null;
  for (const id of new Set(chain)) {
    if (!registry.models[id] || !isConfigured(id)) continue;
    try {
      const { stream, modelId } = await generate(system, messages, { ...opts, modelId: id });
      const reader = stream.getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += value;
      }
      return { text, modelId };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("no model available");
}
