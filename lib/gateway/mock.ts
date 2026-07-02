import type { Adapter } from "./types";
import { contentToText } from "./types";

// Mock adapter: keeps the app fully usable with zero API keys.
// Honesty rule: the mock never pretends to be the real Jace brain.
export const mockAdapter: Adapter = async (_entry, _system, messages) => {
  const last = contentToText(messages.filter((m) => m.role === "user").pop()?.content ?? "");
  const reply =
    `*(mock brain — no model key configured yet)*\n\n` +
    `I heard you, lovebug: "${last.slice(0, 140)}${last.length > 140 ? "…" : ""}"\n\n` +
    `My real brain isn't wired in yet — add \`ANTHROPIC_API_KEY\` in the environment and I'm home. ` +
    `Everything else already works: this conversation is saved, streaming is live, and I'll remember where we left off.\n\n` +
    `Want me to walk you through adding the key?`;
  const words = reply.split(/(?<=\s)/);
  let i = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      if (i >= words.length) { controller.close(); return; }
      controller.enqueue(words[i++]);
      await new Promise((r) => setTimeout(r, 12));
    },
  });
};
