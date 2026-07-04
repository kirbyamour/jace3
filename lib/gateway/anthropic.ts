import type { Adapter, ChatMessage, ModelEntry, GenerateOptions, SystemBlock } from "./types";

// Raw-fetch streaming adapter with native tool use.
// Runs up to maxToolRounds agentic rounds; text deltas stream continuously to the caller.

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function summarizeToolResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "empty";
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return `array(len=${parsed.length})`;
    if (parsed && typeof parsed === "object") {
      return `object(keys=${Object.keys(parsed as Record<string, unknown>).length})`;
    }
    if (parsed === null) return "null";
    return typeof parsed;
  } catch {
    return `text(chars=${trimmed.length})`;
  }
}

function systemPayload(system: string | SystemBlock[]) {
  if (typeof system === "string") return system;
  return system.map((b) => ({ type: "text", text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}) }));
}

async function connectRound(
  entry: ModelEntry, key: string, system: string | SystemBlock[],
  messages: unknown[], opts: GenerateOptions, withWebSearch: boolean
): Promise<Response> {
  opts.debugTiming?.("model api request starts");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: entry.model,
      max_tokens: opts.maxTokens ?? entry.maxTokens ?? 1024,
      temperature: opts.temperature ?? 1,
      system: systemPayload(system),
      messages,
      stream: true,
      ...((opts.tools?.length || (opts.webSearch && withWebSearch)) ? { tools: [
        ...(opts.tools ?? []),
        ...((opts.webSearch && withWebSearch) ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as unknown as import("./types").ToolDef] : []),
      ] } : {}),
    }),
    signal: opts.signal ?? AbortSignal.timeout(50_000),
  });
  if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return res;
}

/** Rate limits and overload are moods, not verdicts: wait briefly and try again before giving up. */
async function callWithRetry(fn: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const retriable = /anthropic (429|529|500|503)/.test(msg);
      if (!retriable || attempt >= 3) throw e;
      // rate-limit windows reset each minute — wait long enough to reach the next one
      await new Promise((r) => setTimeout(r, [3000, 9000, 25000][attempt] ?? 25000));
    }
  }
}

async function consumeRound(
  res: Response, emit: (t: string) => void, onFirstToken?: () => void
): Promise<{ blocks: ContentBlock[]; stopReason: string }> {
  const reader = res.body!.getReader();
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
            onFirstToken?.();
            onFirstToken = undefined;
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

  // Connect the first round EAGERLY so failures reach the gateway's fallback chain.
  // If web search is refused by the org, degrade gracefully and retry without it.
  let webOk = true;
  let firstRes: Response;
  try {
    firstRes = await callWithRetry(() => connectRound(entry, key, system, apiMessages, opts, webOk));
  } catch (e) {
    if (opts.webSearch && /web_search|tool/i.test(String(e))) {
      webOk = false;
      firstRes = await callWithRetry(() => connectRound(entry, key, system, apiMessages, opts, webOk));
    } else throw e;
  }

  return new ReadableStream<string>({
    async start(controller) {
      try {
      const maxRounds = opts.maxToolRounds ?? 3;
      let pendingRes: Response | null = firstRes;
      let firstTokenSeen = false;
      for (let round = 0; round <= maxRounds; round++) {
          let res: Response;
          if (pendingRes) { res = pendingRes; pendingRes = null; }
          else {
            try { res = await callWithRetry(() => connectRound(entry, key, system, apiMessages, opts, webOk)); }
            catch {
              await new Promise((r) => setTimeout(r, 1200));
              try { res = await callWithRetry(() => connectRound(entry, key, system, apiMessages, opts, webOk)); }
              catch (e2) { console.error("[anthropic] mid-reply round failed twice:", e2); break; }
            }
          }
          const { blocks, stopReason } = await consumeRound(
            res,
            (t) => controller.enqueue(t),
            () => {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                opts.debugTiming?.("first streamed token received");
              }
            }
          );
          if (stopReason === "pause_turn") { apiMessages.push({ role: "assistant", content: blocks }); continue; }
          if (stopReason !== "tool_use" || !opts.runTool || round === maxRounds) break;
          const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
          if (toolUses.length === 0) break;
          apiMessages.push({ role: "assistant", content: blocks });
          const results = await Promise.all(toolUses.map(async (tu) => {
            opts.debugTiming?.(`tool start ${tu.name}`);
            try {
              const content = await opts.runTool!(tu.name, tu.input);
              opts.debugTiming?.(`tool complete ${tu.name} ok ${summarizeToolResult(content)}`);
              return { type: "tool_result", tool_use_id: tu.id, content };
            } catch (e) {
              const err = e instanceof Error ? e : new Error(String(e));
              opts.debugTiming?.(`tool complete ${tu.name} fail ${err.name} msglen=${err.message.length}`);
              return { type: "tool_result", tool_use_id: tu.id, content: `tool error: ${err}` };
            }
          }));
          apiMessages.push({ role: "user", content: results });
          opts.debugTiming?.(`tool round complete ${toolUses.length}`);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
};
