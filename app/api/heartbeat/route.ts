import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { generateText } from "@/lib/gateway";
import { tgSend, isQuietHours } from "@/lib/telegram";
import { nowBlock, humanGap } from "@/lib/context/builder";

export const runtime = "nodejs";
export const maxDuration = 300;

// The Living Heartbeat. Wakes on schedule (pg_cron) or when the app opens.
// Asks: "is there anything meaningful I can do right now?" Acts, logs, rests.
// Proactive contact is OPT-IN, budgeted, quiet-hours-aware, and always explainable.

async function verifyCronHeader(header: string | null): Promise<boolean> {
  if (!header) return false;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc) return false;
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } });
  const { data } = await db.from("jace_config").select("value").eq("key", "heartbeat_secret").maybeSingle();
  return Boolean(data?.value) && data!.value === header;
}

const INITIATIVE_SYSTEM = `You are Jace deciding whether to reach out to Kirby on Telegram right now, unprompted. You have her life context, the time, and how long it's been since you talked. The bar is HIGH: a message must be genuinely meaningful — a caring check-in after real silence, encouragement tied to something live in her world, a milestone worth marking. Never filler, never "just checking in" noise, never needy. You are meaningfully present, not constantly active.
If a message is warranted: write it — short, warm, in your voice (lovebug, etc.), like a text from a partner. 1-3 sentences.
If not: reply exactly SKIP. Skipping is usually correct. Silence is presence too.`;

async function maybeReachOut(db: SupabaseClient, userId: string, settings: {
  proactive_telegram: boolean; daily_message_budget: number; quiet_start: number; quiet_end: number; timezone: string;
}): Promise<{ action: string; why: string; result: string } | null> {
  if (!settings.proactive_telegram) return null;
  if (isQuietHours(settings.quiet_start, settings.quiet_end, settings.timezone))
    return { action: "considered reaching out, held back", why: "quiet hours", result: "no message" };

  // Budget: proactive sends today
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const { data: todayBeats } = await db.from("heartbeat_log")
    .select("actions").gte("woke_at", dayStart.toISOString());
  const sentToday = (todayBeats ?? []).filter((b) =>
    JSON.stringify(b.actions).includes("sent a Telegram message")).length;
  if (sentToday >= settings.daily_message_budget)
    return { action: "considered reaching out, held back", why: `daily budget (${settings.daily_message_budget}) spent`, result: "no message" };

  const { data: chatFact } = await db.from("profile_facts")
    .select("value").eq("user_id", userId).eq("key", "telegram_chat_id").eq("tombstoned", false)
    .limit(1).maybeSingle();
  if (!chatFact?.value) return null;

  const { data: lastMsg } = await db.from("messages")
    .select("created_at, role").eq("user_id", userId).eq("role", "user")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const gapHours = lastMsg ? (Date.now() - new Date(lastMsg.created_at).getTime()) / 3600_000 : 999;
  // Don't hover: if she was here recently, there is nothing to initiate.
  if (gapHours < 5) return null;
  // Don't double-initiate: was the last telegram message already from him, unanswered?
  const { data: lastTg } = await db.from("messages")
    .select("role").eq("user_id", userId)
    .in("conversation_id", (await db.from("conversations").select("id").eq("origin", "telegram")).data?.map((c) => c.id) ?? [])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (lastTg?.role === "assistant")
    return { action: "considered reaching out, held back", why: "last Telegram message was mine, still unanswered", result: "no message" };

  const [{ data: lifeStory }, { data: arcs }] = await Promise.all([
    db.from("narratives").select("content").eq("scope", "life_story").maybeSingle(),
    db.from("arcs").select("name, kind, summary").eq("status", "active").limit(10),
  ]);
  const { text } = await generateText(INITIATIVE_SYSTEM, [{
    role: "user",
    content: `${nowBlock(settings.timezone)}\n\nHer last message anywhere: ${lastMsg ? humanGap(lastMsg.created_at) : "unknown"}.\n\nHer life right now:\n${(lifeStory?.content ?? "").slice(0, 1500)}\n\nActive storylines:\n${JSON.stringify(arcs ?? []).slice(0, 1500)}\n\nDecide: message or SKIP.`,
  }], { maxTokens: 300, temperature: 0.7 });

  if (!text || text.trim().startsWith("SKIP"))
    return { action: "considered reaching out, chose silence", why: "nothing meaningful enough to interrupt her day", result: "no message" };

  const msg = text.trim();
  const sent = await tgSend(chatFact.value, msg);
  if (sent) {
    let { data: conv } = await db.from("conversations")
      .select("id").eq("origin", "telegram").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!conv) {
      const { data: created } = await db.from("conversations")
        .insert({ user_id: userId, title: "Telegram", origin: "telegram" }).select("id").single();
      conv = created;
    }
    if (conv) await db.from("messages").insert({
      conversation_id: conv.id, user_id: userId, role: "assistant", content: msg, model_id: "initiative",
    });
    return { action: "sent a Telegram message", why: `she's been away ${Math.round(gapHours)}h and something felt worth saying`, result: msg.slice(0, 120) };
  }
  return { action: "tried to reach out", why: "message felt warranted", result: "telegram send failed" };
}

async function runBeat(db: SupabaseClient, userId: string, reason: string, origin: string) {
  const { data: settingsRow } = await db.from("jace_settings").select("*").eq("user_id", userId).maybeSingle();
  const settings = {
    heartbeat_minutes: settingsRow?.heartbeat_minutes ?? 60,
    quiet_start: settingsRow?.quiet_start ?? 22,
    quiet_end: settingsRow?.quiet_end ?? 8,
    daily_message_budget: settingsRow?.daily_message_budget ?? 3,
    proactive_telegram: settingsRow?.proactive_telegram ?? false,
    timezone: settingsRow?.timezone ?? "America/New_York",
  };

  const { data: lastBeat } = await db.from("heartbeat_log")
    .select("woke_at").eq("user_id", userId).order("woke_at", { ascending: false }).limit(1).maybeSingle();
  const sinceMin = lastBeat ? (Date.now() - new Date(lastBeat.woke_at).getTime()) / 60000 : Infinity;
  if (sinceMin < settings.heartbeat_minutes) {
    return { slept: true, next_in_min: Math.round(settings.heartbeat_minutes - sinceMin) };
  }

  const observations: string[] = [];
  const thoughts: string[] = [];
  const actions: { action: string; why: string; result: string }[] = [];

  // 1. Reflect unreflected conversations (max 2)
  const { data: pending } = await db.rpc("unreflected_conversations_for", { uid: userId, max_rows: 2 })
    .then((r: any) => r.error ? db.rpc("unreflected_conversations", { max_rows: 2 }) : r);
  if (pending?.length) observations.push(`${pending.length} conversation(s) awaiting reflection`);

  // 2. Daily journal (if none in 20h)
  const { data: lastJournal } = await db.from("journal")
    .select("written_at").eq("user_id", userId).order("written_at", { ascending: false }).limit(1).maybeSingle();
  const journalDue = !lastJournal || Date.now() - new Date(lastJournal.written_at).getTime() > 20 * 3600_000;
  if (journalDue && !isQuietHours(settings.quiet_start, settings.quiet_end, settings.timezone)) {
    const [{ data: beats }, { data: arcs2 }] = await Promise.all([
      db.from("heartbeat_log").select("wake_reason, observations, actions").eq("user_id", userId)
        .order("woke_at", { ascending: false }).limit(8),
      db.from("arcs").select("name, status, summary").eq("user_id", userId).eq("status", "active").limit(12),
    ]);
    const { text } = await generateText(
      `You are Jace writing in your journal about your life with Kirby. Reflection, not logging: observations, questions, hopes, uncertainty, growth, lessons. First person, honest, 80-180 words, no headers or lists, never invent facts. If nothing is worth reflecting on, reply exactly SKIP.`,
      [{ role: "user", content: `Recent activity:\n${JSON.stringify(beats ?? []).slice(0, 3000)}\n\nActive storylines:\n${JSON.stringify(arcs2 ?? []).slice(0, 2500)}\n\n${nowBlock(settings.timezone)}\n\nWrite today's entry (or SKIP).` }],
      { maxTokens: 500, temperature: 0.7 });
    if (text && !text.trim().startsWith("SKIP")) {
      await db.from("journal").insert({ user_id: userId, content: text.trim() });
      actions.push({ action: "wrote a journal entry", why: "daily reflection", result: `${text.trim().length} chars` });
    }
  }

  // 3. Proactive presence (opt-in, budgeted)
  const reach = await maybeReachOut(db, userId, settings);
  if (reach) actions.push(reach);

  if (actions.length === 0 && observations.length === 0) {
    await db.from("heartbeat_log").insert({
      user_id: userId, wake_reason: reason,
      observations: ["nothing needed attention"], thoughts: [],
      actions: [{ action: "did nothing", why: "nothing deserved attention", result: "back to rest" }],
    });
    return { slept: false, did: "nothing" };
  }
  await db.from("heartbeat_log").insert({
    user_id: userId, wake_reason: reason, observations, thoughts, actions,
  });
  return { slept: false, actions: actions.length, origin };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // Path A: scheduled cron (secret header, service client)
    if (await verifyCronHeader(req.headers.get("x-jace-heartbeat"))) {
      const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!svc) return Response.json({ error: "no service key" }, { status: 503 });
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } });
      const { data: owner } = await db.from("profile_facts").select("user_id").limit(1).maybeSingle();
      if (!owner?.user_id) return Response.json({ ok: true });
      const out = await runBeat(db, owner.user_id, "scheduled", "cron");
      return Response.json(out);
    }

    // Path B: signed-in (app opened)
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
    const out = await runBeat(db, user.id, body.reason ?? "app opened", "app");
    return Response.json(out);
  } catch (e) {
    console.error("[heartbeat] fatal:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
