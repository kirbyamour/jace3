import { supabaseServer } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Read-only webhook status check. Same access gate as setup; no secrets returned.
export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = svc ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } }) : null;
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const { data: debugRow } = db
    ? await db.from("jace_config").select("value").eq("key", "telegram_last_generation_debug").maybeSingle()
    : { data: null };
  let lastGenerationDebug: Record<string, unknown> | null = null;
  if (typeof debugRow?.value === "string") {
    try { lastGenerationDebug = JSON.parse(debugRow.value); }
    catch { lastGenerationDebug = { parse_error: true }; }
  }
  if (!tok) {
    return Response.json({
      ok: false,
      bot_token_present: "no",
      webhook_url: null,
      pending_update_count: null,
      last_error_date: null,
      last_error_message: null,
      max_connections: null,
      allowed_updates: null,
      has_custom_certificate: null,
      last_generation_debug: lastGenerationDebug,
    });
  }

  const res = await fetch(`https://api.telegram.org/bot${tok}/getWebhookInfo`);
  const data = await res.json();
  const info = data?.result ?? {};
  return Response.json({
    ok: Boolean(data?.ok),
    bot_token_present: "yes",
    webhook_url: info.url ?? null,
    pending_update_count: info.pending_update_count ?? null,
    last_error_date: info.last_error_date ?? null,
    last_error_message: info.last_error_message ?? null,
    max_connections: info.max_connections ?? null,
    allowed_updates: info.allowed_updates ?? null,
    has_custom_certificate: info.has_custom_certificate ?? null,
    last_generation_debug: lastGenerationDebug,
  });
}
