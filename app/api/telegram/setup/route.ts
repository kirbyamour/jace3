import { supabaseServer } from "@/lib/supabase/server";
import { webhookSecret } from "@/lib/telegram";

export const runtime = "nodejs";

function telegramWebhookBaseUrl(req: Request): string {
  const explicit = process.env.TELEGRAM_WEBHOOK_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) return `https://${vercelProd.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  const publicSite = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (publicSite) return publicSite.replace(/\/+$/, "");

  return new URL(req.url).origin.replace(/\/+$/, "");
}

// One-time (re-runnable) webhook registration. Signed-in only; token stays in env.
export async function GET(req: Request) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set in environment" });

  const base = telegramWebhookBaseUrl(req);
  console.log("[telegram][setup] webhook base used:", new URL(base).hostname);
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
  return Response.json({ ok: detail.ok, webhook: detail, bot: me?.result?.username ?? null, webhook_base: base });
}
