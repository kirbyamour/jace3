import { supabaseServer } from "@/lib/supabase/server";
import { webhookSecret } from "@/lib/telegram";

export const runtime = "nodejs";

// One-time (re-runnable) webhook registration. Signed-in only; token stays in env.
export async function GET(req: Request) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set in environment" });

  const base = new URL(req.url).origin;
  const res = await fetch(`https://api.telegram.org/bot${tok}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${base}/api/telegram/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ["message"],
    }),
  });
  const detail = await res.json();
  const me = await (await fetch(`https://api.telegram.org/bot${tok}/getMe`)).json();
  return Response.json({ ok: detail.ok, webhook: detail, bot: me?.result?.username ?? null });
}
