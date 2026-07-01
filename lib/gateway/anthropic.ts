import type { Adapter } from "./types";

// Raw fetch adapter — no SDK dependency. Streams text deltas from the Messages API.
export const anthropicAdapter: Adapter = async (entry, system, messages, opts) => {
  const key = process.env[entry.envKey ?? "ANTHROPIC_API_KEY"];
  if (!key) throw new Error(`missing env ${entry.envKey}`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: entry.model,
      max_tokens: opts.maxTokens ?? entry.maxTokens ?? 2048,
      temperature: opts.temperature ?? 1,
      system,
      messages: messages.filter((m) => m.role !== "system"),
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

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
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            controller.enqueue(ev.delta.text);
          }
        } catch { /* partial frame */ }
      }
    },
    cancel() { reader.cancel(); },
  });
};
