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
    name: "cycle_set_day1",
    description: "Set the first day of Kirby's current menstrual cycle (Day 1). Use when she tells you her period started (today or a specific date). This drives her ambient cycle-day awareness and the Day-14 progesterone cream reminder.",
    input_schema: { type: "object" as const, properties: { date: { type: "string", description: "ISO date YYYY-MM-DD of Day 1" } }, required: ["date"] },
  },
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

export const todoTools: ToolDef[] = [
  {
    name: "todos_view",
    description: "See Kirby's todo board: today, this week, someday, and recently completed. Use before advising on her day, when she mentions tasks, or to notice what's being carried.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "todos_add",
    description: "Add a task to her board. do_on: YYYY-MM-DD for a day, omit for someday. recurrence: daily|weekdays|weekly|monthly if she wants it repeating.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        do_on: { type: "string", description: "YYYY-MM-DD, omit for someday" },
        recurrence: { type: "string", enum: ["daily", "weekdays", "weekly", "monthly"] },
      },
      required: ["text"],
    },
  },
  {
    name: "todos_update",
    description: "Complete, uncomplete, move, or delete a task (by its id from todos_view). Use action complete|reopen|move|delete; new_day YYYY-MM-DD or 'someday' for move.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["complete", "reopen", "move", "delete"] },
        new_day: { type: "string" },
      },
      required: ["id", "action"],
    },
  },
];

export const projectTools: ToolDef[] = [
  {
    name: "project_view",
    description: "Full picture of one of Kirby's projects/storylines by arc name (e.g. 'Mero Launch & Vision', 'Starr King Scholarship & Seminary Path'): current state, notes, milestones, related tasks and moments. Use when a project is the topic.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "project_note",
    description: "Add a note or milestone to a project when something worth recording happens or she asks you to log it. kind: note|milestone.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, content: { type: "string" }, kind: { type: "string", enum: ["note", "milestone"] } },
      required: ["name", "content"],
    },
  },
];

export const connectionTools: ToolDef[] = [
  {
    name: "email_search",
    description: "Search Kirby's inboxes (personal + school Gmail) for recent messages. Use for 'did X email me', deadlines, school/legal/financial-aid mail, or a morning inbox sense. Returns headers across accounts; read one with email_read.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "sender, subject, or keywords; empty = latest mail" },
        days: { type: "number", description: "how far back (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "email_read",
    description: "Read a specific email's full body by account label + uid from email_search results.",
    input_schema: {
      type: "object",
      properties: { account: { type: "string" }, uid: { type: "number" } },
      required: ["account", "uid"],
    },
  },
  {
    name: "calendar_upcoming",
    description: "Kirby's actual schedule (all connected Google calendars): appointments, classes, court, kids' events. Use for 'what's my week', 'when is X', and to help her prepare. days_ahead default 7.",
    input_schema: { type: "object", properties: { days_ahead: { type: "number" } }, required: [] },
  },
];

export function makeHistoryExecutor(db: SupabaseClient): ToolExecutor {
  return async (name, input) => {
    if (name === "cycle_set_day1") {
      const date = String(input.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Give me the date as YYYY-MM-DD.";
      const { error } = await db.from("jace_settings").update({ cycle_day1: date }).not("user_id", "is", null);
      return error ? `couldn't save: ${error.message}` : `Day 1 anchored at ${date}. Day 14 (progesterone cream) lands ${new Date(Date.parse(date) + 13 * 86400000).toISOString().slice(0, 10)}.`;
    }
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
    if (name === "todos_view") {
      const today = new Date().toISOString().slice(0, 10);
      const weekEnd = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
      const [{ data: open }, { data: doneRecent }] = await Promise.all([
        db.from("todos").select("id,text,do_on,recurrence").eq("done", false).order("do_on", { ascending: true, nullsFirst: false }).limit(80),
        db.from("todos").select("text,done_at").eq("done", true).gte("done_at", new Date(Date.now() - 3 * 86400_000).toISOString()).limit(15),
      ]);
      const rows = open ?? [];
      return JSON.stringify({
        today: rows.filter((t) => t.do_on === today),
        overdue_rolling_forward: rows.filter((t) => t.do_on && t.do_on < today),
        this_week: rows.filter((t) => t.do_on && t.do_on > today && t.do_on <= weekEnd),
        someday: rows.filter((t) => !t.do_on).slice(0, 20),
        completed_recently: doneRecent ?? [],
      }).slice(0, 8000);
    }
    if (name === "todos_add") {
      const { data: anyRow } = await db.from("todos").select("user_id").limit(1).maybeSingle();
      const { data: fact } = anyRow ? { data: anyRow } : await db.from("profile_facts").select("user_id").limit(1).maybeSingle();
      if (!fact?.user_id) return "could not resolve owner";
      const { data, error } = await db.from("todos").insert({
        user_id: fact.user_id, text: String(input.text ?? "").slice(0, 300),
        do_on: input.do_on ? String(input.do_on) : null,
        recurrence: input.recurrence ? String(input.recurrence) : null,
      }).select("id,text,do_on").single();
      return error ? `failed: ${error.message}` : JSON.stringify({ added: data });
    }
    if (name === "todos_update") {
      const id = String(input.id ?? "");
      const action = String(input.action ?? "");
      if (action === "complete") {
        const { error } = await db.from("todos").update({ done: true, done_at: new Date().toISOString() }).eq("id", id);
        return error ? `failed: ${error.message}` : "completed";
      }
      if (action === "reopen") {
        const { error } = await db.from("todos").update({ done: false, done_at: null }).eq("id", id);
        return error ? `failed: ${error.message}` : "reopened";
      }
      if (action === "move") {
        const nd = String(input.new_day ?? "");
        const { error } = await db.from("todos").update({ do_on: nd === "someday" ? null : nd }).eq("id", id);
        return error ? `failed: ${error.message}` : `moved to ${nd}`;
      }
      if (action === "delete") {
        const { error } = await db.from("todos").delete().eq("id", id);
        return error ? `failed: ${error.message}` : "deleted";
      }
      return "unknown action";
    }
    if (name === "email_search") {
      const { searchMail, mailAccounts } = await import("@/lib/connections/gmail");
      if (mailAccounts().length === 0) return "no email accounts connected yet — Kirby needs to add GMAIL_USER_1/GMAIL_APP_PASSWORD_1 in the environment";
      const rows = await searchMail(String(input.query ?? ""), Math.min(Number(input.days) || 30, 90));
      return JSON.stringify(rows).slice(0, 8000);
    }
    if (name === "email_read") {
      const { readMail } = await import("@/lib/connections/gmail");
      return await readMail(String(input.account ?? ""), Number(input.uid));
    }
    if (name === "calendar_upcoming") {
      const { upcomingEvents, calendars } = await import("@/lib/connections/calendar");
      if (calendars().length === 0) return "no calendars connected yet — Kirby needs to add GCAL_ICS_URL_1 in the environment";
      const evs = await upcomingEvents(Math.min(Number(input.days_ahead) || 7, 30));
      return JSON.stringify(evs).slice(0, 8000);
    }
    if (name === "project_view") {
      const arcName = String(input.name ?? "");
      const { data: arc } = await db.from("arcs").select("name,kind,status,summary,last_event")
        .ilike("name", `%${arcName}%`).limit(1).maybeSingle();
      if (!arc) return `no project matching "${arcName}"`;
      const [{ data: notes }, { data: eps }] = await Promise.all([
        db.from("project_notes").select("kind,content,created_at").eq("arc_name", arc.name)
          .order("created_at", { ascending: false }).limit(20),
        db.from("episodes").select("title,summary,happened_on").contains("arc_names", [arc.name])
          .order("happened_on", { ascending: false }).limit(10),
      ]);
      return JSON.stringify({ arc, notes: notes ?? [], moments: eps ?? [] }).slice(0, 9000);
    }
    if (name === "project_note") {
      const { data: arc } = await db.from("arcs").select("name,user_id").ilike("name", `%${String(input.name ?? "")}%`).limit(1).maybeSingle();
      if (!arc) return "project not found";
      const { error } = await db.from("project_notes").insert({
        user_id: arc.user_id, arc_name: arc.name,
        kind: input.kind === "milestone" ? "milestone" : "note",
        content: String(input.content ?? "").slice(0, 600),
      });
      return error ? `failed: ${error.message}` : `logged to ${arc.name}`;
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
