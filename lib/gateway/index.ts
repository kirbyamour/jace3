import registryJson from "@/config/models.json";
import type { Adapter, ChatMessage, GenerateOptions, GenerateResult, GatewayDebugEvent, GatewayDebugFailure, GatewayRequestMeta, ModelRegistry, SystemBlock } from "./types";
import { anthropicAdapter } from "./anthropic";
import { openaiCompatibleAdapter } from "./openai-compatible";
import { mockAdapter } from "./mock";

const registry = registryJson as unknown as ModelRegistry;

const adapters: Record<string, Adapter> = {
  anthropic: anthropicAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  mock: mockAdapter,
};

function safeGatewayFailure(modelId: string, adapter: string, err: unknown): GatewayDebugFailure {
  const e = err instanceof Error ? err : new Error(String(err));
  const raw = `${e.name}: ${e.message}`;
  const statusMatch = raw.match(/\b(?:anthropic|[A-Za-z0-9._-]+)\s+(\d{3})\b/);
  const code = (e as { code?: unknown; status?: unknown }).code;
  const status = typeof (e as { status?: unknown }).status === "number"
    ? (e as { status?: number }).status!
    : statusMatch ? Number(statusMatch[1]) : null;
  const codeText = typeof code === "string" ? code : typeof code === "number" ? String(code) : null;
  const safe_detail =
    /missing env/i.test(raw) ? "missing env" :
    /AbortError/i.test(raw) ? "aborted" :
    /fetch/i.test(raw) ? "fetch failed" :
    status ? `http ${status}` :
    "adapter error";
  return {
    model_id: modelId,
    adapter,
    error_name: e.name || "Error",
    http_status: status,
    error_code: codeText,
    safe_detail,
    safe_message: safeProviderMessage(raw),
  };
}

function safeProviderMessage(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return null;
  const redacted = firstLine
    .replace(/`[^`]{1,80}`/g, "`[redacted]`")
    .replace(/"[^"]{1,80}"/g, '"[redacted]"')
    .replace(/\b[A-Za-z0-9+/=]{24,}\b/g, "[redacted]")
    .slice(0, 180);
  if (/key|token|secret|prompt|content/i.test(redacted) && !/invalid|model|schema|field|parameter|payload|request/i.test(redacted)) {
    return null;
  }
  return redacted;
}

function schemaDepth(value: unknown, depth = 0): { maxDepth: number; unsupported: number } {
  if (!value || typeof value !== "object") return { maxDepth: depth, unsupported: 0 };
  if (Array.isArray(value)) {
    return value.reduce((acc, item) => {
      const sub = schemaDepth(item, depth + 1);
      return { maxDepth: Math.max(acc.maxDepth, sub.maxDepth), unsupported: acc.unsupported + sub.unsupported };
    }, { maxDepth: depth, unsupported: 0 });
  }
  const obj = value as Record<string, unknown>;
  let maxDepth = depth;
  let unsupported = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!["type", "properties", "required", "items", "enum", "description", "format", "additionalProperties", "oneOf", "anyOf", "allOf"].includes(k)) {
      if (depth === 0) unsupported += 1;
    }
    const sub = schemaDepth(v, depth + 1);
    maxDepth = Math.max(maxDepth, sub.maxDepth);
    unsupported += sub.unsupported;
  }
  return { maxDepth, unsupported };
}

function requestMeta(messages: ChatMessage[], opts: GenerateOptions): GatewayRequestMeta {
  const toolNames = (opts.tools ?? []).map((t) => t.name);
  const emptyContentCount = messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + (m.content.trim() ? 0 : 1);
    return n + (m.content.length ? 0 : 1);
  }, 0);
  const schemaStats = (opts.tools ?? []).reduce((acc, tool) => {
    const s = schemaDepth(tool.input_schema);
    return {
      maxDepth: Math.max(acc.maxDepth, s.maxDepth),
      unsupported: acc.unsupported + s.unsupported,
    };
  }, { maxDepth: 0, unsupported: 0 });
  return {
    message_count: messages.length,
    roles: messages.map((m) => m.role),
    empty_content_count: emptyContentCount,
    tool_count: toolNames.length,
    tool_names: toolNames,
    approx_json_bytes: JSON.stringify({ messages, tools: opts.tools ?? [] }).length,
    max_schema_depth: schemaStats.maxDepth,
    unsupported_schema_shape_count: schemaStats.unsupported,
  };
}

export function getRegistry(): ModelRegistry { return registry; }

export function isConfigured(modelId: string): boolean {
  const entry = registry.models[modelId];
  if (!entry) return false;
  if (entry.adapter === "mock") return true;
  return Boolean(entry.envKey && process.env[entry.envKey]);
}

/** Generate with explicit model, or walk the fallback chain from config. */
export async function generate(
  system: string | SystemBlock[],
  messages: ChatMessage[],
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const chain = opts.modelId ? [opts.modelId] : [registry.active, ...registry.fallbackChain];
  const tried = new Set<string>();
  let lastErr: unknown = null;
  opts.debugGateway?.({ kind: "request", meta: requestMeta(messages, opts) });
  for (const id of chain) {
    if (tried.has(id)) continue;
    tried.add(id);
    const entry = registry.models[id];
    if (!entry) continue;
    if (!isConfigured(id)) { lastErr = new Error(`${id} not configured`); continue; }
    try {
      opts.debugGateway?.({ kind: "attempt", model_id: id, adapter: entry.adapter });
      const stream = await adapters[entry.adapter](entry, system, messages, opts);
      opts.debugGateway?.({ kind: "success", model_id: id, adapter: entry.adapter });
      return { stream, modelId: id };
    } catch (e) {
      lastErr = e;
      opts.debugGateway?.({ kind: "failure", failure: safeGatewayFailure(id, entry.adapter, e) });
    }
  }
  opts.debugGateway?.({ kind: "exhausted", attempted_models: Array.from(tried) });
  throw lastErr ?? new Error("no model available");
}

/** Collect a full (non-streaming) completion — for background/utility work. */
export async function generateText(
  system: string | SystemBlock[],
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
