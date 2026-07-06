import type { Adapter } from "./types";
import { contentToText } from "./types";

// Generic OpenAI-compatible streaming adapter. Covers OpenAI, GLM (z.ai),
// local servers (ollama/vllm/lmstudio), and most future providers via baseUrl config.
export const openaiCompatibleAdapter: Adapter = async (entry, system, messages, opts) => {
  const systemText = typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
  const key = process.env[entry.envKey ?? "OPENAI_API_KEY"];
  if (!key) throw new Error(`missing env ${entry.envKey}`);
  const useCompletionTokens = /api\.openai\.com/i.test(entry.baseUrl ?? "") || /^gpt-5/i.test(entry.model);
  const res = await fetch(`${entry.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: entry.model,
      ...(useCompletionTokens
        ? { max_completion_tokens: opts.maxTokens ?? entry.maxTokens ?? 2048 }
        : { max_tokens: opts.maxTokens ?? entry.maxTokens ?? 2048 }),
      temperature: opts.temperature ?? 1,
      messages: [{ role: "system", content: systemText }, ...messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: contentToText(m.content) }))],
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const { summary, code, type } = await safeProviderErrorSummary(res);
    const err = new Error(`${entry.label} ${res.status}: ${summary}`);
    (err as { code?: string; providerType?: string; status?: number }).code = code ?? undefined;
    (err as { providerType?: string }).providerType = type ?? undefined;
    (err as { status?: number }).status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return new ReadableStream<string>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          const delta = ev.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) controller.enqueue(delta);
        } catch { /* partial frame */ }
      }
    },
    cancel() { reader.cancel(); },
  });
};

async function safeProviderErrorSummary(res: Response): Promise<{ summary: string; code: string | null; type: string | null }> {
  const text = await res.clone().text().catch(() => "");
  const trimmed = text.trim();
  let code: string | null = null;
  let type: string | null = null;
  let summary = trimmed.split(/\r?\n/, 1)[0].slice(0, 180);
  try {
    const parsed = JSON.parse(trimmed);
    const err = parsed?.error ?? parsed;
    type = typeof err?.type === "string" ? err.type : null;
    code = typeof err?.code === "string" ? err.code : null;
    const msg = typeof err?.message === "string" ? err.message : null;
    if (msg) summary = msg;
  } catch {
    // fall back to plain text
  }
  summary = summary
    .replace(/`[^`]{1,80}`/g, "`[redacted]`")
    .replace(/"[^"]{1,80}"/g, '"[redacted]"')
    .replace(/\b[A-Za-z0-9+/=]{24,}\b/g, "[redacted]")
    .slice(0, 180);
  return { summary: summary || `HTTP ${res.status}`, code, type };
}
