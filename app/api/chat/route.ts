import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generate } from "@/lib/gateway";
import { buildSystemPrompt, trimRecent } from "@/lib/context/builder";
import type { ChatMessage } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    return await handleChat(req);
  } catch (e) {
    console.error("[jace-chat] fatal:", e);
    return new Response(JSON.stringify({ error: "chat_failed" }), { status: 500 });
  }
}

async function handleChat(req: NextRequest) {
  const cookieClient = supabaseServer();
  const [{ data: { user } }, { data: { session } }] = await Promise.all([
    cookieClient.auth.getUser(),
    cookieClient.auth.getSession(),
  ]);
  if (!user || !session?.access_token) return new Response("unauthorized", { status: 401 });

  // Token-pinned client: survives the whole stream without cookie/refresh machinery.
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { conversationId: cidIn, content } = await req.json();
  if (!content?.trim()) return new Response("empty", { status: 400 });

  let conversationId: string = cidIn;
  if (!conversationId) {
    const { data, error } = await db
      .from("conversations")
      .insert({ user_id: user.id, title: content.slice(0, 48) })
      .select("id").single();
    if (error) { console.error("[jace-chat] conv insert:", error); return new Response(error.message, { status: 500 }); }
    conversationId = data.id;
  }

  const { error: userInsErr } = await db.from("messages").insert({
    conversation_id: conversationId, user_id: user.id, role: "user", content,
  });
  if (userInsErr) { console.error("[jace-chat] user msg insert:", userInsErr); return new Response(userInsErr.message, { status: 500 }); }
  await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  const { data: history, error: histErr } = await db
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (histErr) console.error("[jace-chat] history:", histErr);

  const { data: facts } = await db
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
      } catch (e) {
        console.error("[jace-chat] stream error:", e);
      } finally {
        try {
          const { error } = await db.from("messages").insert({
            conversation_id: conversationId, user_id: user.id, role: "assistant",
            content: full || "…", model_id: modelId, persona_version: personaVersion,
          });
          if (error) console.error("[jace-chat] assistant insert FAILED:", error);
        } catch (e) {
          console.error("[jace-chat] assistant insert threw:", e);
        }
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(out, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
