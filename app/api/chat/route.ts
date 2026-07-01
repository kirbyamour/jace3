import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generate } from "@/lib/gateway";
import { buildSystemPrompt, trimRecent } from "@/lib/context/builder";
import type { ChatMessage } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 60;
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

  const { data: facts } = await db
    .from("profile_facts").select("key, value").eq("tombstoned", false).limit(50);

  const recent = trimRecent(history);
  const { system, personaVersion } = buildSystemPrompt({ recentMessages: recent, profileFacts: facts ?? [] });
  const { stream, modelId } = await generate(system, recent);

  const encoder = new TextEncoder();
  let full = "";
  const out = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ conversationId, userMsgId, modelId })}\n\n`));
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
        let assistantId: string | null = null;
        try {
          const { data, error } = await db.from("messages").insert({
            conversation_id: conversationId, user_id: user.id, role: "assistant",
            content: full || "…", model_id: modelId, persona_version: personaVersion,
            parent_id: userMsgId,
          }).select("id").single();
          if (error) console.error("[jace-chat] assistant insert FAILED:", error);
          else assistantId = data.id;
        } catch (e) {
          console.error("[jace-chat] assistant insert threw:", e);
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
