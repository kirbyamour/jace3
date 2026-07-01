import { NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { generate } from "@/lib/gateway";
import { buildSystemPrompt, trimRecent } from "@/lib/context/builder";
import type { ChatMessage } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST { conversationId?, content } → SSE stream of text deltas.
// Persists user message immediately and assistant message on completion —
// kill the tab mid-stream and the reply still lands (blueprint doc 03 §10).
export async function POST(req: NextRequest) {
  try {
    return await handleChat(req);
  } catch (e) {
    console.error("[jace-chat] fatal:", e);
    return new Response(JSON.stringify({ error: "chat_failed" }), { status: 500 });
  }
}

async function handleChat(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { conversationId: cidIn, content } = await req.json();
  if (!content?.trim()) return new Response("empty", { status: 400 });

  let conversationId: string = cidIn;
  if (!conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, title: content.slice(0, 48) })
      .select("id").single();
    if (error) return new Response(error.message, { status: 500 });
    conversationId = data.id;
  }

  await supabase.from("messages").insert({
    conversation_id: conversationId, user_id: user.id, role: "user", content,
  });
  await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(80);

  const { data: facts } = await supabase
    .from("profile_facts").select("key, value").eq("tombstoned", false).limit(50);

  const recent = trimRecent((history ?? []) as ChatMessage[]);
  const { system, personaVersion } = buildSystemPrompt({ recentMessages: recent, profileFacts: facts ?? [] });

  const { stream, modelId } = await generate(system, recent);

  const encoder = new TextEncoder();
  let full = "";
  const out = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ conversationId, modelId })}\n\n`));
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        }
      } finally {
        await supabase.from("messages").insert({
          conversation_id: conversationId, user_id: user.id, role: "assistant",
          content: full || "…", model_id: modelId, persona_version: personaVersion,
        });
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(out, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
