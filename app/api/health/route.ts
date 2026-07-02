import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}

export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const db = admin();
  const [{ data: settings }, { data: logs }] = await Promise.all([
    db.from("jace_settings").select("cycle_day1, timezone").maybeSingle(),
    db.from("health_logs").select("*").order("logged_at", { ascending: false }).limit(400),
  ]);
  return Response.json({ cycle_day1: settings?.cycle_day1 ?? null, timezone: settings?.timezone ?? "America/New_York", logs: logs ?? [] });
}

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const db = admin();
  const body = await req.json();

  if (body.action === "log") {
    const { error } = await db.from("health_logs").insert({
      kind: body.kind ?? "note", summary: String(body.summary ?? "").slice(0, 2000),
      data: body.data ?? null, source: "manual",
      logged_at: body.logged_at ?? new Date().toISOString(),
    });
    return Response.json({ ok: !error, error: error?.message });
  }
  if (body.action === "delete") {
    await db.from("health_logs").delete().eq("id", body.id);
    return Response.json({ ok: true });
  }
  if (body.action === "set_day1") {
    await db.from("jace_settings").update({ cycle_day1: body.date }).not("user_id", "is", null);
    return Response.json({ ok: true });
  }

  if (body.action === "import") { // pull health/MCAS rows from a Jace 2.0 export URL
    const res = await fetch(String(body.exportUrl));
    if (!res.ok) return Response.json({ ok: false, error: `export fetch ${res.status}` });
    const dump = await res.json();
    const report = { imported: 0, skipped: 0, tables: [] as string[] };
    const healthish = /mcas|health|symptom|medication|supplement|cycle|period|migraine|weight|glp/i;
    for (const [table, rows] of Object.entries(dump)) {
      if (!Array.isArray(rows) || !rows.length || !healthish.test(table)) continue;
      report.tables.push(`${table} (${rows.length})`);
      for (const row of rows as Record<string, unknown>[]) {
        const legacy = `${table}:${row.id ?? JSON.stringify(row).slice(0, 40)}`;
        const { data: exists } = await db.from("health_logs").select("id").eq("legacy_id", legacy).maybeSingle();
        if (exists) { report.skipped++; continue; }
        const when = (row.logged_at ?? row.created_at ?? row.date ?? row.recorded_at ?? new Date().toISOString()) as string;
        const summary = String(row.summary ?? row.note ?? row.notes ?? row.symptom ?? row.description ?? row.name ?? table)
          .slice(0, 2000);
        const kind = /mcas/i.test(table) ? "mcas" : /symptom/i.test(table) ? "symptom" : /med|supplement/i.test(table) ? "med" : /cycle|period/i.test(table) ? "cycle" : "note";
        const { error } = await db.from("health_logs").insert({
          kind, summary, data: row, source: "jace2", legacy_id: legacy, logged_at: when,
        });
        if (!error) report.imported++;
      }
    }
    return Response.json({ ok: true, ...report });
  }
  return Response.json({ ok: false, error: "unknown action" });
}
