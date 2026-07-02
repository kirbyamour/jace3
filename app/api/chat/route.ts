import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generate } from "@/lib/gateway";
import { buildSystemBlocks, trimRecent } from "@/lib/context/builder";
import { historyTools, heartTools, makeHistoryExecutor } from "@/lib/context/history-tools";
import type { ChatMessage } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    return await handleChat(req);
  } catch (e) {
    console.error("[jace-chat] fatal:", e);
    return new Response(JSON.stringify({ error: "chat_failed" }), { status: 500 });
  }
}

async function lineage(db: SupabaseClient, leaf: string): Promise<ChatMessage[]> {
  const { data, error } = await db.rpc("get_lineage", { leaf, max_rows: 80 });
  if (error) { console.error("[jace-chat] lineage:", error); return []; }
  return (data ?? []).map((r: { role: string; content: string }) => ({ role: r.role, content: r.content })) as ChatMessage[];
}

async function handleChat(req: NextRequest) {
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

  const body = await req.json();
  const { conversationId: cidIn, content, parentId, regenerateOf } = body as {
    conversationId?: string; content?: string; parentId?: string | null; regenerateOf?: string;
  };

  let conversationId = cidIn as string;
  let userMsgId: string | null = null;
  let history: ChatMessage[] = [];

  if (regenerateOf) {
    // Regenerate: new assistant sibling under the same user message. No user insert.
    if (!conversationId) return new Response("missing conversation", { status: 400 });
    userMsgId = regenerateOf;
    history = await lineage(db, regenerateOf);
  } else {
    if (!content?.trim()) return new Response("empty", { status: 400 });
    if (!conversationId) {
      const { data, error } = await db
        .from("conversations")
        .insert({ user_id: user.id, title: content.slice(0, 48) })
        .select("id").single();
      if (error) { console.error("[jace-chat] conv insert:", error); return new Response(error.message, { status: 500 }); }
      conversationId = data.id;
    }
    const { data: userRow, error: userInsErr } = await db.from("messages").insert({
      conversation_id: conversationId, user_id: user.id, role: "user", content,
      parent_id: parentId ?? null,
    }).select("id").single();
    if (userInsErr) { console.error("[jace-chat] user insert:", userInsErr); return new Response(userInsErr.message, { status: 500 }); }
    userMsgId = userRow.id;
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    history = await lineage(db, userMsgId!);
    if (history.length === 0) history = [{ role: "user", content }];
  }

  const lastUserText = (regenerateOf ? history.filter((h) => h.role === "user").pop()?.content : content) ?? "";
  const [{ data: facts }, { data: lifeStory }, { data: arcs }, { data: eps }] = await Promise.all([
    db.from("profile_facts").select("key, value, confidence").eq("tombstoned", false).is("superseded_by", null).order("confidence", { ascending: false }).order("created_at", { ascending: false }).limit(24),
    db.from("narratives").select("content").eq("scope", "life_story").maybeSingle(),
    db.from("arcs").select("name, kind, status, summary").order("updated_at", { ascending: false }).limit(20),
    db.rpc("relevant_episodes", { q: lastUserText.slice(0, 200), max_rows: 4 }),
  ]);

  const recent = trimRecent(history);
  const { blocks: system, personaVersion } = buildSystemBlocks({
    recentMessages: recent, profileFacts: facts ?? [],
    lifeStory: lifeStory?.content ?? null, arcs: arcs ?? [], episodes: eps ?? [],
  });
  const { stream, modelId } = await generate(system, recent, {
    tools: [...historyTools, ...heartTools], runTool: makeHistoryExecutor(db), maxToolRounds: 2, webSearch: true,
  });

  // Persist the assistant row BEFORE streaming (pre-stream writes are reliable);
  // final content lands via end-of-stream update AND a client-side confirm.
  const { data: asstRow, error: asstErr } = await db.from("messages").insert({
    conversation_id: conversationId, user_id: user.id, role: "assistant",
    content: "…", model_id: modelId, persona_version: personaVersion, parent_id: userMsgId,
  }).select("id").single();
  if (asstErr) console.error("[jace-chat] placeholder insert:", asstErr);
  const assistantId: string | null = asstRow?.id ?? null;

  const encoder = new TextEncoder();
  let full = "";
  const out = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ conversationId, userMsgId, modelId, assistantId })}\n\n`));
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        }
      } catch (e) {
        console.error("[jace-chat] stream error:", e);
      } finally {
        if (assistantId && full) {
          try {
            const { error } = await db.from("messages").update({ content: full }).eq("id", assistantId);
            if (error) console.error("[jace-chat] final update FAILED:", error);
          } catch (e) { console.error("[jace-chat] final update threw:", e); }
        }
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ assistantId })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(out, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
