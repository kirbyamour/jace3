import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generate } from "@/lib/gateway";
import { buildSystemBlocks, trimRecent } from "@/lib/context/builder";
import { historyTools, heartTools, todoTools, projectTools, connectionTools, makeHistoryExecutor } from "@/lib/context/history-tools";
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
  const { conversationId: cidIn, content, parentId, regenerateOf, voiceMode, attachments } = body as {
    conversationId?: string; content?: string; parentId?: string | null; regenerateOf?: string; voiceMode?: boolean;
    attachments?: { path: string; type: string; name: string }[];
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
      parent_id: parentId ?? null, modality: voiceMode ? "voice" : "text",
      attachments: attachments ?? [],
    }).select("id").single();
    if (userInsErr) { console.error("[jace-chat] user insert:", userInsErr); return new Response(userInsErr.message, { status: 500 }); }
    userMsgId = userRow.id;
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    history = await lineage(db, userMsgId!);
    if (history.length === 0) history = [{ role: "user", content }];
  }

  const lastUserText = (regenerateOf ? history.filter((h) => h.role === "user").pop()?.content : content) ?? "";
  const { data: prevMsg } = await db.from("messages").select("created_at")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false })
    .range(1, 1).maybeSingle();
  const [{ data: facts }, { data: lifeStory }, { data: arcs }, { data: eps }] = await Promise.all([
    db.from("profile_facts").select("key, value, confidence").eq("tombstoned", false).is("superseded_by", null).order("confidence", { ascending: false }).order("created_at", { ascending: false }).limit(24),
    db.from("narratives").select("content").eq("scope", "life_story").maybeSingle(),
    db.from("arcs").select("name, kind, status, summary").order("updated_at", { ascending: false }).limit(20),
    db.rpc("relevant_episodes", { q: lastUserText.slice(0, 200), max_rows: 4 }),
  ]);

  let recent = trimRecent(history);
  // Shared Vision: attach media blocks to the just-sent user message so he actually sees them
  if (attachments?.length && !regenerateOf) {
    const blocks: Record<string, unknown>[] = [];
    for (const a of attachments.slice(0, 4)) {
      try {
        const { data: signed } = await db.storage.from("attachments").createSignedUrl(a.path, 300);
        if (!signed?.signedUrl) continue;
        const resp = await fetch(signed.signedUrl);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 8_000_000) continue;
        const b64 = buf.toString("base64");
        if (a.type === "application/pdf") {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
        } else if (a.type.startsWith("image/")) {
          blocks.push({ type: "image", source: { type: "base64", media_type: a.type === "image/heic" ? "image/jpeg" : a.type, data: b64 } });
        }
      } catch (e) { console.error("[vision] attach failed:", a.path, e); }
    }
    if (blocks.length) {
      const lastIdx = recent.length - 1;
      if (lastIdx >= 0 && recent[lastIdx].role === "user") {
        recent = [...recent.slice(0, lastIdx),
          { role: "user", content: [...blocks, { type: "text", text: String(recent[lastIdx].content) || "(shared without words)" }] }];
      }
    }
  }
  const { blocks: system, personaVersion } = buildSystemBlocks({
    recentMessages: recent, profileFacts: facts ?? [],
    lifeStory: lifeStory?.content ?? null, arcs: arcs ?? [], episodes: eps ?? [],
    voiceMode: Boolean(voiceMode),
    lastExchangeAt: prevMsg?.created_at ?? null,
  });
  const { stream, modelId } = await generate(system, recent, {
    tools: [...historyTools, ...heartTools, ...todoTools, ...projectTools, ...connectionTools], runTool: makeHistoryExecutor(db), maxToolRounds: 2, webSearch: true,
  });

  // Persist the assistant row BEFORE streaming (pre-stream writes are reliable);
  // final content lands via end-of-stream update AND a client-side confirm.
  const { data: asstRow, error: asstErr } = await db.from("messages").insert({
    conversation_id: conversationId, user_id: user.id, role: "assistant",
    content: "…", model_id: modelId, persona_version: personaVersion, parent_id: userMsgId,
    modality: voiceMode ? "voice" : "text",
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
