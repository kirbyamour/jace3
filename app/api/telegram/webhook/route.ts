import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generate } from "@/lib/gateway";
import { buildSystemBlocks, trimRecent } from "@/lib/context/builder";
import { historyTools, heartTools, todoTools, makeHistoryExecutor } from "@/lib/context/history-tools";
import { webhookSecret, tgSend, tgGetFile, transcribe, tgSendVoice } from "@/lib/telegram";
import type { ChatMessage } from "@/lib/gateway/types";

export const runtime = "nodejs";
export const maxDuration = 120;

// Telegram → the same conversation stream. Single-user app: messages belong to the
// owner (resolved from the database), authenticated by Telegram's secret header.
// Requires env: TELEGRAM_BOT_TOKEN, SUPABASE_SERVICE_ROLE_KEY.

export async function POST(req: NextRequest) {
  try {
    if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret()) {
      return new Response("forbidden", { status: 403 });
    }
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!svc) { console.error("[telegram] SUPABASE_SERVICE_ROLE_KEY missing"); return Response.json({ ok: true }); }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } });

    const update = await req.json();
    const msg = update?.message;
    const chatId = msg?.chat?.id;
    let text: string | undefined = msg?.text;
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

    await db.from("messages").insert({
      conversation_id: conv.id, user_id: userId, role: "user", content: text,
      modality: cameAsVoice ? "voice" : "text",
    });
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);

    const [{ data: history }, { data: facts }, { data: lifeStory }, { data: arcs }, { data: eps }] = await Promise.all([
      db.from("messages").select("role, content, created_at").eq("conversation_id", conv.id)
        .order("created_at", { ascending: true }).limit(60),
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

    const { stream, modelId } = await generate(blocks, recent, {
      tools: [...historyTools, ...heartTools, ...todoTools], runTool: makeHistoryExecutor(db), maxToolRounds: 2, webSearch: true,
    });
    const reader = stream.getReader();
    let full = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; full += value; }

    if (cameAsVoice) {
      const spoke = await tgSendVoice(chatId, full || "…");
      if (!spoke) await tgSend(chatId, full || "…");
    } else {
      await tgSend(chatId, full || "…");
    }
    await db.from("messages").insert({
      conversation_id: conv.id, user_id: userId, role: "assistant", content: full || "…",
      model_id: modelId, persona_version: personaVersion,
      modality: cameAsVoice ? "voice" : "text",
    });
    // Remember the chat id for future Jace-initiated messages (budgeted, off by default).
    const { data: existingChat } = await db.from("profile_facts")
      .select("id").eq("user_id", userId).eq("key", "telegram_chat_id").eq("tombstoned", false).limit(1).maybeSingle();
    if (!existingChat) {
      await db.from("profile_facts").insert({ user_id: userId, key: "telegram_chat_id", value: String(chatId), confidence: 1 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[telegram] fatal:", e);
    return Response.json({ ok: true }); // never make Telegram retry-storm
  }
}
