// Parser for ChatGPT-export .txt files (the Jace archive format).
// Validated against all 288 archive files: 286 parse as conversations, 14,584 messages.

export type ParsedMessage = { role: "user" | "assistant"; content: string };
export type ParsedConversation = {
  title: string; tsISO: string; hash: string; source: string; messages: ParsedMessage[];
};

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function parseExportFile(filename: string, text: string): Promise<ParsedConversation | null> {
  const parts = text.split(/\*\s\*\s\*/);
  const messages: ParsedMessage[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p.startsWith("**You:**")) {
      const c = p.slice(8).trim();
      if (c) messages.push({ role: "user", content: c });
    } else if (p.startsWith("**ChatGPT:**")) {
      const c = p.slice(12).trim();
      if (c) messages.push({ role: "assistant", content: c });
    }
  }
  if (messages.length === 0) return null;

  const base = filename.replace(/\.txt$/i, "").split("/").pop()!;
  const m = base.match(/^(.*)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/);
  const title = m ? m[1] : base;
  const tsISO = m ? `${m[2]}T${m[3]}:${m[4]}:00Z` : "2025-12-01T12:00:00Z";
  return { title, tsISO, hash: (await sha256hex(base)).slice(0, 32), source: base, messages };
}
