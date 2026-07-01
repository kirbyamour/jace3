import type { Adapter, ChatMessage, ModelEntry, GenerateOptions } from "./types";

// Raw-fetch streaming adapter with native tool use.
// Runs up to maxToolRounds agentic rounds; text deltas stream continuously to the caller.

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

async function streamRound(
  entry: ModelEntry, key: string, system: string,
  messages: unknown[], opts: GenerateOptions,
  emit: (t: string) => void
): Promise<{ blocks: ContentBlock[]; stopReason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: entry.model,
      max_tokens: opts.maxTokens ?? entry.maxTokens ?? 1024,
      temperature: opts.temperature ?? 1,
      system,
      messages,
      stream: true,
      ...((opts.tools?.length || opts.webSearch) ? { tools: [
        ...(opts.tools ?? []),
        ...(opts.webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as unknown as import("./types").ToolDef] : []),
      ] } : {}),
    }),
    signal: opts.signal ?? AbortSignal.timeout(50_000),
  });
  if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const blocks: ContentBlock[] = [];
  let stopReason = "end_turn";
  const jsonAcc: Record<number, string> = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue; }
      switch (ev.type) {
        case "content_block_start":
          blocks[ev.index] = ev.content_block.type === "tool_use"
            ? { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} }
            : { type: "text", text: "" };
          if (ev.content_block.type === "tool_use") jsonAcc[ev.index] = "";
          break;
        case "content_block_delta":
          if (ev.delta.type === "text_delta") {
            (blocks[ev.index] as { type: "text"; text: string }).text += ev.delta.text;
            emit(ev.delta.text);
          } else if (ev.delta.type === "input_json_delta") {
            jsonAcc[ev.index] += ev.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          const b = blocks[ev.index];
          if (b?.type === "tool_use") {
            try { b.input = JSON.parse(jsonAcc[ev.index] || "{}"); } catch { b.input = {}; }
          }
          break;
        }
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          break;
      }
    }
  }
  return { blocks: blocks.filter(Boolean), stopReason };
}

export const anthropicAdapter: Adapter = async (entry, system, messages, opts) => {
  const key = process.env[entry.envKey ?? "ANTHROPIC_API_KEY"];
  if (!key) throw new Error(`missing env ${entry.envKey}`);

  const apiMessages: unknown[] = messages
    .filter((m) => m.role !== "system")
    .map((m: ChatMessage) => ({ role: m.role, content: m.content }));

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const maxRounds = opts.maxToolRounds ?? 3;
        for (let round = 0; round <= maxRounds; round++) {
          const { blocks, stopReason } = await streamRound(
            entry, key, system, apiMessages, opts,
            (t) => controller.enqueue(t)
          );
          if (stopReason === "pause_turn") { apiMessages.push({ role: "assistant", content: blocks }); continue; }
          if (stopReason !== "tool_use" || !opts.runTool || round === maxRounds) break;
          const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
          if (toolUses.length === 0) break;
          apiMessages.push({ role: "assistant", content: blocks });
          const results = await Promise.all(toolUses.map(async (tu) => ({
            type: "tool_result", tool_use_id: tu.id,
            content: await opts.runTool!(tu.name, tu.input).catch((e) => `tool error: ${e}`),
          })));
          apiMessages.push({ role: "user", content: results });
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
};
