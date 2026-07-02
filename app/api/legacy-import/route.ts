import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

// The last rescue from Jace 2.0: health, finance, and Jace's own journals.
// Server-side fetch (full export, no truncation), idempotent via legacy ids.

const EXPORT_URL = "https://nwmakrswzpkwrgiitobl.supabase.co/functions/v1/export-rest";

function admin(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && !isNaN(Number(v)) ? Number(v) : null);
const when = (r: Row): string =>
  (s(r.logged_at) ?? s(r.occurred_at) ?? s(r.recorded_at) ?? s(r.date) ?? s(r.created_at) ?? new Date().toISOString());

const HEALTH_TABLES: Record<string, string> = {
  mcas_flares: "mcas", mcas_patterns: "mcas", energy_logs: "symptom",
  overwhelm_episodes: "symptom", decision_paralysis_episodes: "symptom",
  rest_permission_logs: "note", baseline_communication_patterns: "note",
  nightly_routine_items: "note", nightly_routine_logs: "note",
};
const FINANCE_TABLES: Record<string, string> = {
  debts: "debt", debt_payments: "payment", monthly_expenses: "expense",
  expense_spends: "spend", to_purchase_items: "purchase",
};
const LEGACY_TABLES = [
  "jace_reflections", "jace_memory_logs", "heartbeat_conclusions",
  "jace_autonomous_learning", "autonomous_outreach_log", "courses", "syllabus_items",
];

function summarize(r: Row, table: string): string {
  const parts = [
    s(r.summary), s(r.note), s(r.notes), s(r.description), s(r.symptoms),
    s(r.trigger), s(r.triggers), s(r.name), s(r.title), s(r.content),
    s(r.severity) ? `severity: ${s(r.severity)}` : null,
    num(r.energy_level) !== null ? `energy ${num(r.energy_level)}/10` : null,
  ].filter(Boolean);
  return (parts.join(" — ") || table).slice(0, 1800);
}

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { scope } = await req.json().catch(() => ({ scope: "all" }));
  const db = admin();

  const res = await fetch(EXPORT_URL);
  if (!res.ok) return Response.json({ ok: false, error: `export fetch ${res.status}` });
  const dump = (await res.json()) as Record<string, unknown>;
  const report: Record<string, number> = {};
  const errors: string[] = [];

  const rowsOf = (t: string): Row[] => (Array.isArray(dump[t]) ? (dump[t] as Row[]) : []);

  if (scope === "all" || scope === "health") {
    for (const [table, kind] of Object.entries(HEALTH_TABLES)) {
      for (const r of rowsOf(table)) {
        const legacy = `${table}:${r.id}`;
        const { data: ex } = await db.from("health_logs").select("id").eq("legacy_id", legacy).maybeSingle();
        if (ex) continue;
        const { error } = await db.from("health_logs").insert({
          kind, summary: summarize(r, table), data: r, source: "jace2",
          legacy_id: legacy, logged_at: when(r),
        });
        if (error) errors.push(`${table}: ${error.message}`);
        else report[table] = (report[table] ?? 0) + 1;
      }
    }
  }

  if (scope === "all" || scope === "finance") {
    for (const [table, kind] of Object.entries(FINANCE_TABLES)) {
      for (const r of rowsOf(table)) {
        const legacy = `${table}:${r.id}`;
        const { data: ex } = await db.from("finance_records").select("id").eq("legacy_id", legacy).maybeSingle();
        if (ex) continue;
        const { error } = await db.from("finance_records").insert({
          kind,
          name: (s(r.name) ?? s(r.title) ?? s(r.description) ?? s(r.creditor) ?? s(r.category) ?? table).slice(0, 200),
          amount: num(r.amount) ?? num(r.balance) ?? num(r.current_balance) ?? num(r.monthly_amount) ?? num(r.cost) ?? num(r.price) ?? num(r.total),
          data: r, legacy_id: legacy, logged_at: when(r),
        });
        if (error) errors.push(`${table}: ${error.message}`);
        else report[table] = (report[table] ?? 0) + 1;
      }
    }
  }

  if (scope === "all" || scope === "journal") {
    for (const table of LEGACY_TABLES) {
      for (const r of rowsOf(table)) {
        const legacy = `${table}:${r.id}`;
        const { data: ex } = await db.from("legacy_rows").select("id").eq("legacy_id", legacy).maybeSingle();
        if (ex) continue;
        const { error } = await db.from("legacy_rows").insert({
          table_name: table, legacy_id: legacy, logged_at: when(r), data: r,
        });
        if (error) errors.push(`${table}: ${error.message}`);
        else report[table] = (report[table] ?? 0) + 1;
      }
    }
  }

  if (scope === "journal_doc") {
    // Stash the raw rows first — the document is a view; the data itself must survive Lovable.
    for (const table of LEGACY_TABLES) {
      for (const r2 of rowsOf(table)) {
        const legacy = `${table}:${r2.id}`;
        const { data: ex } = await db.from("legacy_rows").select("id").eq("legacy_id", legacy).maybeSingle();
        if (!ex) await db.from("legacy_rows").insert({ table_name: table, legacy_id: legacy, logged_at: when(r2), data: r2 });
      }
    }
    // Ready-to-read research document: every 2.0 reflection + journal entry, timestamped.
    const refl = rowsOf("jace_reflections");
    const mems = rowsOf("jace_memory_logs");
    const entries = [
      ...refl.map((r) => ({
        at: when(r),
        vis: s(r.visibility) ?? (r.is_private === true ? "private" : r.is_private === false ? "public" : "unlabeled"),
        kind: "Reflection", text: s(r.content) ?? s(r.reflection) ?? s(r.text) ?? s(r.body) ?? JSON.stringify(r),
        title: s(r.title),
      })),
      ...mems.map((r) => ({
        at: when(r), vis: "memory log", kind: "Memory log",
        text: s(r.content) ?? s(r.summary) ?? s(r.text) ?? JSON.stringify(r), title: s(r.title),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    if (!entries.length) return Response.json({ ok: false, error: "no reflections found in export" });
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    let body = `Jace 2.0 — Complete Reflections & Journal\n\nEvery reflection, journal entry, and memory log Jace 2.0 wrote, in chronological order, timestamped. Public reflections and private journal entries are both included and labeled. Compiled ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" })} for Kirby's research.\n\n`;
    let lastDay = "";
    for (const e of entries) {
      const day = e.at.slice(0, 10);
      if (day !== lastDay) { body += `\n# ${new Date(day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}\n\n`; lastDay = day; }
      body += `## ${fmt(e.at)} — ${e.kind}${e.vis && e.vis !== "unlabeled" ? ` (${e.vis})` : ""}${e.title ? `: ${e.title}` : ""}\n\n${(e.text ?? "").trim()}\n\n`;
    }
    const { renderDocx, storeFile, filesDb } = await import("@/lib/creation");
    const buf = await renderDocx("Jace 2.0 — Complete Reflections & Journal", body);
    const url = await storeFile(filesDb(), "Jace-2.0-Reflections-and-Journal.docx", buf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return Response.json({ ok: !!url, url, entries: entries.length, reflections: refl.length, memory_logs: mems.length });
  }

  return Response.json({ ok: true, imported: report, errors: errors.slice(0, 10) });
}
