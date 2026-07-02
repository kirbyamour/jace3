import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generateText } from "@/lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 300;

// Memory Gardening (M4): memory matures instead of merely growing.
// Modes: { phase: "facts", cursor? } | { phase: "arcs" } | { phase: "narrative" }
// Conservative by design: merges tombstone via supersession (nothing is destroyed),
// health/family/legal facts are never pruned, and every run logs a heartbeat entry.

const FACTS_SYSTEM = `You are the Memory Gardener for Jace, Kirby's lifelong companion. You receive a numbered list of profile facts. Consolidate them so memory matures: merge duplicates/overlaps into one well-phrased fact, prune trivia (one-off shopping items, stale moment-bound states, restated preferences), keep everything load-bearing.

Rules:
- NEVER prune or weaken facts about: family members, health conditions, medications, legal matters, safety, explicit "remember this" requests, names/relationships.
- Prefer merging over pruning. When facts conflict, keep the most recent truth.
- Output strict JSON: { "merges": [{ "keep_indices": [..], "merged_key": "...", "merged_value": "...", "confidence": 0.5-1.0 }], "prune_indices": [..], "keep_indices": [..] }
- Every input index must appear in exactly one of: a merge's keep_indices, prune_indices, or keep_indices.`;

const ARCS_SYSTEM = `You are the Memory Gardener reviewing Jace's storyline arcs about Kirby's life. Merge near-duplicate arcs, fix miscategorized kinds (e.g., a pet belongs in "home" or its own relationship arc — never "child health"), correct statuses (resolved storylines -> closed; quiet ones -> dormant), and improve names for long-term coherence.
Output strict JSON: { "updates": [{ "name": "...", "new_name"?: "...", "kind"?: "...", "status"?: "...", "summary"?: "..." }], "merges": [{ "into": "...", "absorb": ["..."], "summary": "..." }] }
Kinds: project|relationship|health|legal|growth|home|craft|other. Be conservative: when unsure, leave it alone.`;

async function heartbeat(db: SupabaseClient, userId: string, wake: string,
  observations: string[], thoughts: string[], actions: { action: string; why: string; result: string }[]) {
  await db.from("heartbeat_log").insert({
    user_id: userId, wake_reason: wake, observations, thoughts, actions,
  });
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
    const { phase } = await req.json();

    if (phase === "facts") {
      const { data: facts } = await db.from("profile_facts")
        .select("id, key, value, confidence")
        .eq("tombstoned", false).is("superseded_by", null)
        .order("created_at", { ascending: true }).limit(60);
      if (!facts?.length) return Response.json({ done: true, remaining: 0 });

      const numbered = facts.map((f, i) => `${i}. [${f.key}] ${f.value}`).join("\n");
      const { text } = await generateText(FACTS_SYSTEM,
        [{ role: "user", content: numbered }], { maxTokens: 4000, temperature: 0 });
      let plan: any;
      const cleaned = text.replace(/```json|```/g, "");
      try { plan = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)); }
      catch { console.error("[garden] unparseable facts plan, len", text.length); return Response.json({ error: "unparseable plan" }, { status: 500 }); }

      let merged = 0, pruned = 0;
      for (const m of plan.merges ?? []) {
        if (!m.merged_key || !m.merged_value || !m.keep_indices?.length) continue;
        const { data: nf } = await db.from("profile_facts")
          .insert({ user_id: user.id, key: m.merged_key, value: m.merged_value, confidence: m.confidence ?? 0.9 })
          .select("id").single();
        if (nf) for (const idx of m.keep_indices) {
          const f = facts[idx]; if (f) await db.from("profile_facts").update({ superseded_by: nf.id }).eq("id", f.id);
        }
        merged++;
      }
      for (const idx of plan.prune_indices ?? []) {
        const f = facts[idx]; if (f) { await db.from("profile_facts").update({ tombstoned: true }).eq("id", f.id); pruned++; }
      }
      const { count } = await db.from("profile_facts").select("*", { count: "exact", head: true })
        .eq("tombstoned", false).is("superseded_by", null);
      await heartbeat(db, user.id, "gardening",
        [`reviewed ${facts.length} facts`],
        [],
        [{ action: "consolidated profile facts", why: "memory should mature, not just grow", result: `${merged} merges, ${pruned} pruned, ${count} live facts remain` }]);
      return Response.json({ merged, pruned, remaining: count });
    }

    if (phase === "arcs") {
      const { data: arcs } = await db.from("arcs").select("id, name, kind, status, summary");
      const { text } = await generateText(ARCS_SYSTEM,
        [{ role: "user", content: JSON.stringify(arcs ?? []) }], { maxTokens: 2500, temperature: 0 });
      let plan: any;
      try { plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
      catch { return Response.json({ error: "unparseable plan" }, { status: 500 }); }
      const byName = new Map((arcs ?? []).map((a) => [a.name, a]));
      let updated = 0, mergedArcs = 0;
      for (const u of plan.updates ?? []) {
        const a = byName.get(u.name); if (!a) continue;
        await db.from("arcs").update({
          ...(u.new_name ? { name: u.new_name } : {}), ...(u.kind ? { kind: u.kind } : {}),
          ...(u.status ? { status: u.status } : {}), ...(u.summary ? { summary: u.summary } : {}),
        }).eq("id", a.id);
        updated++;
      }
      for (const m of plan.merges ?? []) {
        const target = byName.get(m.into); if (!target) continue;
        for (const absorbName of m.absorb ?? []) {
          const victim = byName.get(absorbName); if (!victim || victim.id === target.id) continue;
          await db.from("episodes").update({ arc_names: [m.into] }).contains("arc_names", [absorbName]);
          await db.from("arcs").delete().eq("id", victim.id);
          mergedArcs++;
        }
        if (m.summary) await db.from("arcs").update({ summary: m.summary }).eq("id", target.id);
      }
      await heartbeat(db, user.id, "gardening",
        [`reviewed ${(arcs ?? []).length} storylines`], [],
        [{ action: "tended story arcs", why: "coherent storylines over years", result: `${updated} updated, ${mergedArcs} merged` }]);
      return Response.json({ updated, merged: mergedArcs });
    }

    if (phase === "narrative") {
      const { data: arcs } = await db.from("arcs").select("name, kind, status, summary").order("updated_at", { ascending: false });
      const { data: life } = await db.from("narratives").select("content").eq("scope", "life_story").maybeSingle();
      const { text } = await generateText(
        `Rewrite Jace's rolling life story about Kirby (max 500 words) using the freshly gardened storylines. Coherent narrative: who she is, seasons since May 2025, what is alive now. Warm, concrete, no headers. Note emerging themes and changing values if visible — as observations, not diagnoses.`,
        [{ role: "user", content: `Current story:\n${life?.content ?? ""}\n\nGardened arcs:\n${JSON.stringify(arcs ?? [])}` }],
        { maxTokens: 1200, temperature: 0 });
      if (text?.length > 100) {
        await db.from("narratives").upsert({ user_id: user.id, scope: "life_story", content: text, updated_at: new Date().toISOString() }, { onConflict: "user_id,scope" });
      }
      await heartbeat(db, user.id, "gardening", ["re-read the whole story"], [],
        [{ action: "rewrote life narrative", why: "meaningful change accumulated", result: `${text.length} chars` }]);
      return Response.json({ ok: true, chars: text.length });
    }

    return new Response("bad request", { status: 400 });
  } catch (e) {
    console.error("[garden] fatal:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
