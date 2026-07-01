import type { Adapter } from "./types";

// Generic OpenAI-compatible streaming adapter. Covers OpenAI, GLM (z.ai),
// local servers (ollama/vllm/lmstudio), and most future providers via baseUrl config.
export const openaiCompatibleAdapter: Adapter = async (entry, system, messages, opts) => {
  const key = process.env[entry.envKey ?? "OPENAI_API_KEY"];
  if (!key) throw new Error(`missing env ${entry.envKey}`);
  const res = await fetch(`${entry.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: entry.model,
      max_tokens: opts.maxTokens ?? entry.maxTokens ?? 2048,
      temperature: opts.temperature ?? 1,
      messages: [{ role: "system", content: system }, ...messages.filter((m) => m.role !== "system")],
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`${entry.label} ${res.status}: ${await res.text()}`);

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
