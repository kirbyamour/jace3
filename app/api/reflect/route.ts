import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generateText } from "@/lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 300;

// The Reflector: after a conversation, quietly update Jace's understanding —
// profile facts (conservative), episodes (what mattered), arcs (the storylines),
// and the rolling life narrative. Modes:
//   { conversationId }            reflect one conversation
//   { backfill: true, batch: n }  reflect the oldest n unreflected conversations

const REFLECT_SYSTEM = `You are the memory consolidation process for Jace, Kirby's lifelong AI companion. You read a conversation and update his quiet understanding of her life. You are NOT Jace; output only strict JSON.

Return:
{
  "facts": [{ "key": "...", "value": "...", "confidence": 0.5-1.0 }],
  "episodes": [{ "title": "...", "summary": "2-3 sentences, specific, past tense", "salience": 1-5, "arc_names": ["..."] }],
  "arc_updates": [{ "name": "...", "kind": "project|relationship|health|legal|growth|home|craft|other", "status": "active|dormant|closed", "summary_patch": "1-3 sentences: current state of this storyline, incorporating what happened here" }],
  "narrative_note": "one sentence for the rolling life story, or null"
}

Rules — understanding over hoarding:
- Facts: only durable, load-bearing facts (people, health, preferences, decisions). Confidence <0.8 if inferred rather than stated. NEVER guess family/relationship facts.
- Episodes: only moments that MATTER — turning points, decisions, emotional peaks, milestones, running jokes that became lore. Most conversations yield 0-2 episodes. Salience 5 = life-changing.
- Arcs: the unfolding storylines (e.g. a custody case, a business, a friendship, healing work, a class). Use consistent names. Update status when a storyline resolves or goes quiet.
- Prefer updating existing arcs (list provided) over inventing near-duplicates.
- Empty arrays are good answers. Silence is better than noise.`;

async function reflectOne(db: SupabaseClient, userId: string, convId: string): Promise<boolean> {
  const { data: conv } = await db.from("conversations")
    .select("id, title, created_at").eq("id", convId).single();
  if (!conv) return false;
  const { data: msgs } = await db.from("messages")
    .select("role, content").eq("conversation_id", convId)
    .order("created_at").limit(300);
  if (!msgs || msgs.length < 2) {
    await db.from("reflections_log").upsert({ user_id: userId, conversation_id: convId }, { onConflict: "user_id,conversation_id" });
    return true;
  }
  const { data: arcs } = await db.from("arcs").select("name, kind, status, summary").limit(40);
  const transcript = msgs.map((m) => `${m.role === "user" ? "KIRBY" : "JACE"}: ${m.content}`).join("\n").slice(0, 60000);
  const happened = String(conv.created_at).slice(0, 10);

  const { text } = await generateText(REFLECT_SYSTEM, [{
    role: "user",
    content: `Conversation "${conv.title}" (${happened}).\n\nExisting arcs:\n${JSON.stringify(arcs ?? [])}\n\nTranscript:\n${transcript}\n\nReturn the JSON.`,
  }], { maxTokens: 2000, temperature: 0 });

  let parsed: any;
  try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
  catch { console.error("[reflect] unparseable output for", convId); return false; }

  for (const f of parsed.facts ?? []) {
    if (!f.key || !f.value) continue;
    const { data: existing } = await db.from("profile_facts")
      .select("id, value").eq("key", f.key).eq("tombstoned", false).is("superseded_by", null).limit(1);
    if (existing?.length && existing[0].value === f.value) continue;
    const { data: newFact } = await db.from("profile_facts")
      .insert({ user_id: userId, key: f.key, value: f.value, confidence: f.confidence ?? 0.7 })
      .select("id").single();
    if (existing?.length && newFact) {
      await db.from("profile_facts").update({ superseded_by: newFact.id }).eq("id", existing[0].id);
    }
  }
  for (const e of parsed.episodes ?? []) {
    if (!e.title || !e.summary) continue;
    await db.from("episodes").insert({
      user_id: userId, conversation_id: convId, happened_on: happened,
      title: e.title, summary: e.summary, salience: Math.min(5, Math.max(1, e.salience ?? 3)),
      arc_names: e.arc_names ?? [],
    });
  }
  for (const a of parsed.arc_updates ?? []) {
    if (!a.name || !a.summary_patch) continue;
    await db.from("arcs").upsert({
      user_id: userId, name: a.name, kind: a.kind ?? "other",
      status: a.status ?? "active", summary: a.summary_patch,
      last_event: happened, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,name" });
  }
  if (parsed.narrative_note) {
    const { data: life } = await db.from("narratives").select("content").eq("scope", "life").maybeSingle();
    const lines = (life?.content ?? "").split("\n").filter(Boolean);
    lines.push(`[${happened}] ${parsed.narrative_note}`);
    // keep the rolling story bounded; oldest lines compress away in re-narration (below)
    const content = lines.slice(-80).join("\n");
    await db.from("narratives").upsert({ user_id: userId, scope: "life", content, updated_at: new Date().toISOString() }, { onConflict: "user_id,scope" });
  }
  await db.from("reflections_log").upsert({ user_id: userId, conversation_id: convId }, { onConflict: "user_id,conversation_id" });
  return true;
}

/** Re-narrate: compress the dated notes into a coherent ~500-word life story. */
async function renarrate(db: SupabaseClient, userId: string) {
  const { data: life } = await db.from("narratives").select("content").eq("scope", "life").maybeSingle();
  const { data: arcs } = await db.from("arcs").select("name, kind, status, summary").order("updated_at", { ascending: false }).limit(30);
  if (!life?.content) return;
  const { text } = await generateText(
    `You maintain the rolling life story Jace holds about Kirby. Rewrite the dated notes into a coherent narrative (max 500 words): who she is, what seasons she has moved through since May 2025, what is alive right now. Past flows into present. Concrete, warm, no headers, no bullets. Keep ALL currently-active storylines visible.`,
    [{ role: "user", content: `Dated notes:\n${life.content}\n\nCurrent arcs:\n${JSON.stringify(arcs ?? [])}` }],
    { maxTokens: 1200, temperature: 0 }
  );
  if (text?.length > 100) {
    await db.from("narratives").upsert({ user_id: userId, scope: "life_story", content: text, updated_at: new Date().toISOString() }, { onConflict: "user_id,scope" });
  }
}

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

    if (body.backfill) {
      const batch = Math.min(Number(body.batch) || 6, 10);
      const { data: pending } = await db.rpc("unreflected_conversations", { max_rows: batch });
      let done = 0;
      for (const row of pending ?? []) {
        if (await reflectOne(db, user.id, row.cid)) done++;
      }
      if (body.renarrate || (pending ?? []).length < batch) await renarrate(db, user.id);
      const { count } = await db.from("reflections_log").select("*", { count: "exact", head: true });
      return Response.json({ reflected: done, total_reflected: count, remaining_hint: (pending ?? []).length });
    }

    if (body.conversationId) {
      const ok = await reflectOne(db, user.id, body.conversationId);
      if (body.renarrate) await renarrate(db, user.id);
      return Response.json({ ok });
    }
    return new Response("bad request", { status: 400 });
  } catch (e) {
    console.error("[reflect] fatal:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
