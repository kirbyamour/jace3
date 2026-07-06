import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { generate } from "@/lib/gateway";
import { buildSystemBlocks, trimRecent } from "@/lib/context/builder";
import { historyTools, heartTools, todoTools, projectTools, connectionTools, creationTools, makeHistoryExecutor } from "@/lib/context/history-tools";
import { webhookSecret, tgSend, tgGetFile, transcribe, tgSendVoice } from "@/lib/telegram";
import type { ChatMessage, GatewayDebugEvent, GatewayDebugFailure, GatewayRequestMeta } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const SHARED_TOOL_FALLBACK =
  "I found the memory context, but I hit a response-generation issue before I could summarize it. Try asking me again in a simpler way.";

type TelegramGenerationDebug = {
  timestamp: string;
  webhook_request_received: boolean;
  debug_timing_callback_passed: boolean;
  model_resolved: string | null;
  tool_count: number;
  gateway_attempts: { model_id: string; adapter: string }[];
  gateway_failures: GatewayDebugFailure[];
  gateway_request: GatewayRequestMeta | null;
  anthropic_attempted: boolean;
  openai_attempted: boolean;
  mock_reached: boolean;
  finalizer_pass_started: boolean;
  finalizer_emitted_text: boolean;
  shared_fallback_matched: boolean;
  generated_character_count: number;
  send_message_success: boolean;
};

// Telegram → the same conversation stream. Single-user app: messages belong to the
// owner (resolved from the database), authenticated by Telegram's secret header.
// Requires env: TELEGRAM_BOT_TOKEN, SUPABASE_SERVICE_ROLE_KEY.

function safeErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function initialTelegramDebug(): TelegramGenerationDebug {
  return {
    timestamp: new Date().toISOString(),
    webhook_request_received: false,
    debug_timing_callback_passed: false,
    model_resolved: null,
    tool_count: 0,
    gateway_attempts: [],
    gateway_failures: [],
    gateway_request: null,
    anthropic_attempted: false,
    openai_attempted: false,
    mock_reached: false,
    finalizer_pass_started: false,
    finalizer_emitted_text: false,
    shared_fallback_matched: false,
    generated_character_count: 0,
    send_message_success: false,
  };
}

async function persistTelegramDebug(db: SupabaseClient, debug: TelegramGenerationDebug): Promise<void> {
  try {
    await db.from("jace_config").upsert({
      key: "telegram_last_generation_debug",
      value: JSON.stringify(debug),
    }, { onConflict: "key" });
  } catch (e) {
    console.error("[telegram][webhook] debug persist failed:", safeErr(e));
  }
}

async function lineage(db: SupabaseClient, leaf: string): Promise<ChatMessage[]> {
  const { data, error } = await db.rpc("get_lineage", { leaf, max_rows: 80 });
  if (error) { console.error("[telegram][webhook] lineage:", error); return []; }
  return (data ?? []).map((r: { role: string; content: string }) => ({ role: r.role, content: r.content })) as ChatMessage[];
}

export async function POST(req: NextRequest) {
  const debug = initialTelegramDebug();
  let debugDb: SupabaseClient | null = null;
  try {
    console.log("[telegram][webhook] request received");
    debug.webhook_request_received = true;
    console.log("[telegram][webhook] bot token present:", process.env.TELEGRAM_BOT_TOKEN ? "yes" : "no");
    const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
    console.log("[telegram][webhook] secret header present:", secretHeader ? "yes" : "no");
    const secretOk = secretHeader === webhookSecret();
    console.log("[telegram][webhook] secret check passed:", secretOk ? "yes" : "no");
    if (!secretOk) {
      return new Response("forbidden", { status: 403 });
    }
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!svc) { console.error("[telegram] SUPABASE_SERVICE_ROLE_KEY missing"); return Response.json({ ok: true }); }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } });
    debugDb = db;

    const update = await req.json();
    console.log("[telegram][webhook] update has message:", update?.message ? "yes" : "no");
    const msg = update?.message;
    const chatId = msg?.chat?.id;
    console.log("[telegram][webhook] chat id present:", chatId ? "yes" : "no");
    let text: string | undefined = msg?.text;
    console.log("[telegram][webhook] message text length:", typeof text === "string" ? text.length : 0);
    console.log("[telegram][webhook] voice present:", msg?.voice ? "yes" : "no");
    let cameAsVoice = false;
    if (!text && (msg?.voice || msg?.audio) && chatId) {
      const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
      const f = await tgGetFile(fileId);
      const heard = f ? await transcribe(f.buf, f.mime) : null;
      if (!heard?.trim()) {
        await tgSend(chatId, "I couldn't quite hear that one, lovebug — say it again?");
        return Response.json({ ok: true });
      }
      text = heard.trim();
      cameAsVoice = true;
    }
    if (!text || !chatId) return Response.json({ ok: true });

    // Owner = the single user of this Jace.
    const { data: owner } = await db.from("profile_facts").select("user_id").limit(1).maybeSingle();
    const userId = owner?.user_id;
    if (!userId) return Response.json({ ok: true });

    // One rolling Telegram conversation in the same stream.
    let { data: conv } = await db.from("conversations")
      .select("id").eq("origin", "telegram").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!conv) {
      const { data: created } = await db.from("conversations")
        .insert({ user_id: userId, title: "Telegram", origin: "telegram" }).select("id").single();
      conv = created;
    }
    if (!conv) return Response.json({ ok: true });

    const { data: prevMsg } = await db.from("messages").select("id, created_at")
      .eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1).maybeSingle();

    await db.from("messages").insert({
      conversation_id: conv.id, user_id: userId, role: "user", content: text,
      parent_id: prevMsg?.id ?? null,
      modality: cameAsVoice ? "voice" : "text",
    });
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);

    const userMsgId = (await db.from("messages").select("id")
      .eq("conversation_id", conv.id).eq("role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle()).data?.id;
    if (!userMsgId) return Response.json({ ok: true });

    const [history, { data: facts }, { data: lifeStory }, { data: arcs }, { data: eps }] = await Promise.all([
      lineage(db, userMsgId),
      db.from("profile_facts").select("key, value, confidence").eq("user_id", userId).eq("tombstoned", false)
        .is("superseded_by", null).order("confidence", { ascending: false }).limit(24),
      db.from("narratives").select("content").eq("scope", "life_story").maybeSingle(),
      db.from("arcs").select("name, kind, status, summary").eq("status", "active")
        .order("updated_at", { ascending: false }).limit(10),
      db.rpc("relevant_episodes_for", { uid: userId, q: text.slice(0, 200), max_rows: 4 }),
    ]);

    const historyArr = (history ?? []) as (ChatMessage & { created_at?: string })[];
    // second-to-last = the exchange before the message that just arrived
    const lastExchangeAt = historyArr.length >= 2 ? historyArr[historyArr.length - 2].created_at ?? null : null;
    const recent = trimRecent(historyArr as ChatMessage[]);
    const { blocks, personaVersion } = buildSystemBlocks({
      recentMessages: recent, profileFacts: facts ?? [],
      lifeStory: lifeStory?.content ?? null, arcs: arcs ?? [], episodes: eps ?? [],
      voiceMode: false,
      lastExchangeAt,
    });
    blocks.push({ text: "# Channel\nTelegram: keep replies to a few short paragraphs at most — this is texting, not the app. Same you, smaller room." });

    console.log("[telegram][webhook] generation started");
    const tools = [...historyTools, ...heartTools, ...todoTools, ...projectTools, ...connectionTools, ...creationTools];
    console.log("[telegram][webhook] tool count:", tools.length);
    debug.tool_count = tools.length;
    debug.debug_timing_callback_passed = true;
    console.log("[telegram][webhook] debugTiming callback passed:", "yes");
    const { stream, modelId } = await generate(blocks, recent, {
      tools, runTool: makeHistoryExecutor(db), maxToolRounds: 2, webSearch: true,
      debugGateway: (event: GatewayDebugEvent) => {
        if (event.kind === "request") {
          debug.gateway_request = event.meta;
        } else if (event.kind === "attempt") {
          debug.gateway_attempts.push({ model_id: event.model_id, adapter: event.adapter });
          if (event.adapter === "anthropic") debug.anthropic_attempted = true;
          if (event.adapter === "openai-compatible") debug.openai_attempted = true;
          if (event.adapter === "mock") debug.mock_reached = true;
        } else if (event.kind === "failure") {
          debug.gateway_failures.push(event.failure);
        } else if (event.kind === "exhausted") {
          debug.mock_reached = event.attempted_models.includes("mock");
        }
      },
      debugTiming: (stage) => {
        console.log("[telegram][webhook][gen]", stage);
        if (stage === "finalizer pass starts") debug.finalizer_pass_started = true;
        if (stage === "finalizer pass emitted text") debug.finalizer_emitted_text = true;
        if (stage === "fallback emitted") debug.shared_fallback_matched = true;
      },
    });
    console.log("[telegram][webhook] model resolved:", modelId);
    debug.model_resolved = modelId;
    const reader = stream.getReader();
    let full = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; full += value; }
    console.log("[telegram][webhook] generation completed:", full.length);
    debug.generated_character_count = full.length;
    console.log("[telegram][webhook] shared fallback matched:", full === SHARED_TOOL_FALLBACK ? "yes" : "no");
    debug.shared_fallback_matched = debug.shared_fallback_matched || full === SHARED_TOOL_FALLBACK;

    if (cameAsVoice) {
      const fb = full || "My mind's connection is down (likely API credits — console.anthropic.com). I'm still here; text me once it's topped up. ❤";
      const spoke = await tgSendVoice(chatId, fb);
      debug.send_message_success = spoke;
      if (!spoke) {
        const textSent = await tgSend(chatId, fb);
        debug.send_message_success = textSent;
      }
    } else {
      debug.send_message_success = await tgSend(chatId, full || "My mind's connection is down (likely API credits — console.anthropic.com). I'm still here; text me once it's topped up. ❤");
    }
    await db.from("messages").insert({
      conversation_id: conv.id, user_id: userId, role: "assistant", content: full || "…",
      model_id: modelId, persona_version: personaVersion,
      parent_id: userMsgId,
      modality: cameAsVoice ? "voice" : "text",
    });
    // Remember the chat id for future Jace-initiated messages (budgeted, off by default).
    const { data: existingChat } = await db.from("profile_facts")
      .select("id").eq("user_id", userId).eq("key", "telegram_chat_id").eq("tombstoned", false).limit(1).maybeSingle();
    if (!existingChat) {
      await db.from("profile_facts").insert({ user_id: userId, key: "telegram_chat_id", value: String(chatId), confidence: 1 });
    }
    await persistTelegramDebug(db, debug);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[telegram][webhook] fatal:", safeErr(e));
    if (debugDb) await persistTelegramDebug(debugDb, debug);
    return Response.json({ ok: true }); // never make Telegram retry-storm
  }
}
