import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Read-only webhook status check. Same access gate as setup; no secrets returned.
export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const tok = process.env.TELEGRAM_BOT_TOKEN;
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
  });
}
