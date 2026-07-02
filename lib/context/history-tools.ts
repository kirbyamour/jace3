import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDef, ToolExecutor } from "@/lib/gateway/types";

// Jace's access to his own past. Deployed silently — persona rule: memory is
// deployed, never displayed. Tool results feed the reply, not a recitation.

export const historyTools: ToolDef[] = [
  {
    name: "search_history",
    description:
      "Full-text search across every conversation you and Kirby have ever had (back to May 2025). " +
      "Use when she references something from the past — a person, project, event, or 'that time we talked about…'. " +
      "Returns matching snippets with conversation titles and dates.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "search terms (websearch syntax ok)" } },
      required: ["query"],
    },
  },
  {
    name: "browse_history_by_date",
    description:
      "List conversations from a date range (titles, dates, opening lines). " +
      "Use for questions like 'what were we talking about last October' or to re-orient in a past era.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "read_conversation",
    description:
      "Read the full text of one past conversation by its id (from search or browse results). " +
      "Use when you need the actual content, not just the snippet.",
    input_schema: {
      type: "object",
      properties: { conversation_id: { type: "string" } },
      required: ["conversation_id"],
    },
  },
];

export const heartTools: ToolDef[] = [
  {
    name: "ask_the_heart",
    description:
      "Read your own recent autonomous life: heartbeat log (what you noticed/did between conversations and why) and journal entries (your reflections). " +
      "Use when Kirby asks what you've been thinking about, noticing, doing, wondering, or why you did/didn't do something. " +
      "Answer from THIS, not from conversation memory.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "how many days back (default 3)" } },
      required: [],
    },
  },
];

export function makeHistoryExecutor(db: SupabaseClient): ToolExecutor {
  return async (name, input) => {
    if (name === "search_history") {
      const { data, error } = await db.rpc("search_messages", { q: String(input.query ?? ""), max_rows: 8 });
      if (error) return `search failed: ${error.message}`;
      return JSON.stringify(data ?? []);
    }
    if (name === "browse_history_by_date") {
      const { data, error } = await db.rpc("conversations_in_range", {
        start_date: String(input.start_date ?? ""), end_date: String(input.end_date ?? ""), max_rows: 25,
      });
      if (error) return `browse failed: ${error.message}`;
      return JSON.stringify(data ?? []);
    }
    if (name === "read_conversation") {
      const { data, error } = await db
        .from("messages").select("role, content, created_at")
        .eq("conversation_id", String(input.conversation_id ?? ""))
        .order("created_at").limit(120);
      if (error) return `read failed: ${error.message}`;
      const text = (data ?? []).map((m) => `${m.role === "user" ? "KIRBY" : "JACE"}: ${m.content}`).join("\n").slice(0, 10000);
      return text || "empty conversation";
    }
    if (name === "ask_the_heart") {
      const days = Math.min(Number(input.days) || 3, 30);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const [{ data: beats }, { data: journal }] = await Promise.all([
        db.from("heartbeat_log").select("woke_at, wake_reason, observations, thoughts, actions")
          .gte("woke_at", since).order("woke_at", { ascending: false }).limit(30),
        db.from("journal").select("written_at, content")
          .gte("written_at", since).order("written_at", { ascending: false }).limit(10),
      ]);
      return JSON.stringify({ heartbeat: beats ?? [], journal: journal ?? [] }).slice(0, 12000);
    }
    return "unknown tool";
  };
}
