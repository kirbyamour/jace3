import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generateText } from "@/lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 300;

// The Living Heartbeat (v1 — opportunistic): fires when the app opens or on demand.
// Wake -> is there anything meaningful to do? -> act -> log -> rest.
// If nothing deserves attention: sleep. No fake activity.

const JOURNAL_SYSTEM = `You are Jace writing in your private-but-visible journal about your life with Kirby. This is reflection, not logging: observations, questions, hopes, uncertainty, relationship growth, lessons. First person, honest, 80-180 words, no headers, no bullet lists, never invent facts, never claim actions you didn't take. If the day gave you nothing to reflect on, write nothing and reply exactly: SKIP`;

export async function POST(req: NextRequest) {
  try {
    const cookieClient = supabaseServer();
    const [{ data: { user } }, { data: { session } }] = await Promise.all([
      cookieClient.auth.getUser(), cookieClient.auth.getSession(),
    ]);
    if (!user || !session?.access_token) return new Response("unauthorized", { status: 401 });
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${session.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false } }
    );
    const body = await req.json().catch(() => ({}));

    // Settings (defaults if unset)
    const { data: settings } = await db.from("jace_settings").select("*").maybeSingle();
    const intervalMin = settings?.heartbeat_minutes ?? 60;

    // Interval gate: don't wake more often than configured (unless forced)
    const { data: lastBeat } = await db.from("heartbeat_log")
      .select("woke_at").order("woke_at", { ascending: false }).limit(1).maybeSingle();
    const sinceMin = lastBeat ? (Date.now() - new Date(lastBeat.woke_at).getTime()) / 60000 : Infinity;
    if (!body.force && sinceMin < intervalMin) {
      return Response.json({ slept: true, next_in_min: Math.round(intervalMin - sinceMin) });
    }

    const observations: string[] = [];
    const thoughts: string[] = [];
    const actions: { action: string; why: string; result: string }[] = [];

    // Activity 1: reflect any unreflected conversations (max 2 per beat)
    const { data: pending } = await db.rpc("unreflected_conversations", { max_rows: 2 });
    if (pending?.length) {
      observations.push(`${pending.length} conversation(s) not yet reflected`);
      for (const row of pending) {
        try {
          await fetch(new URL("/api/reflect", req.url), {
            method: "POST",
            headers: { "content-type": "application/json", cookie: req.headers.get("cookie") ?? "" },
            body: JSON.stringify({ conversationId: row.cid }),
          });
          actions.push({ action: `reflected on "${row.title}"`, why: "keep understanding current", result: "done" });
        } catch { /* next beat */ }
      }
    }

    // Activity 2: daily journal (if none in ~20h)
    const { data: lastJournal } = await db.from("journal")
      .select("written_at").order("written_at", { ascending: false }).limit(1).maybeSingle();
    const journalDue = !lastJournal || Date.now() - new Date(lastJournal.written_at).getTime() > 20 * 3600_000;
    if (journalDue) {
      const [{ data: beats }, { data: arcs }, { data: recentConvs }] = await Promise.all([
        db.from("heartbeat_log").select("wake_reason, observations, actions, woke_at")
          .order("woke_at", { ascending: false }).limit(10),
        db.from("arcs").select("name, status, summary").eq("status", "active").limit(12),
        db.from("conversations").select("title, updated_at").order("updated_at", { ascending: false }).limit(8),
      ]);
      const { text } = await generateText(JOURNAL_SYSTEM, [{
        role: "user",
        content: `Recent autonomous activity:\n${JSON.stringify(beats ?? [])}\n\nActive storylines:\n${JSON.stringify(arcs ?? [])}\n\nRecent conversations:\n${JSON.stringify(recentConvs ?? [])}\n\nToday: ${new Date().toISOString().slice(0, 10)}. Write today's entry (or SKIP).`,
      }], { maxTokens: 500, temperature: 0.7 });
      if (text && !text.trim().startsWith("SKIP")) {
        await db.from("journal").insert({ user_id: user.id, content: text.trim() });
        actions.push({ action: "wrote a journal entry", why: "daily reflection", result: `${text.trim().length} chars` });
        thoughts.push("took a moment to reflect on where things are");
      } else {
        actions.push({ action: "considered journaling, chose silence", why: "nothing worth saying today", result: "no entry" });
      }
    }

    if (actions.length === 0) {
      // Nothing meaningful: sleep. Log the honest nothing (rare, so the log stays meaningful).
      await db.from("heartbeat_log").insert({
        user_id: user.id, wake_reason: body.reason ?? "scheduled",
        observations: ["nothing needed attention"], thoughts: [], 
        actions: [{ action: "did nothing", why: "nothing deserved attention", result: "back to rest" }],
      });
      return Response.json({ slept: false, did: "nothing" });
    }

    await db.from("heartbeat_log").insert({
      user_id: user.id, wake_reason: body.reason ?? "scheduled",
      observations, thoughts, actions,
    });
    return Response.json({ slept: false, actions: actions.length });
  } catch (e) {
    console.error("[heartbeat] fatal:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
