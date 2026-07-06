import { supabaseServer } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { getRegistry, isConfigured } from "@/lib/gateway";

export const runtime = "nodejs";

// Read-only webhook status check. Same access gate as setup; no secrets returned.
export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = svc ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc, { auth: { persistSession: false } }) : null;
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const reg = getRegistry();
  const anthropicKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY);
  const openaiKeyPresent = Boolean(process.env.OPENAI_API_KEY);
  const glmKeyPresent = Boolean(process.env.GLM_API_KEY);
  const gatewayDebug = {
    active_model: reg.active,
    utility_model: (reg as unknown as { utility?: string }).utility ?? null,
    active_model_configured: isConfigured(reg.active),
    claude_sonnet_configured: isConfigured("claude-sonnet"),
    claude_haiku_configured: isConfigured("claude-haiku"),
    gpt_fallback_configured: isConfigured("gpt-fallback"),
    mock_configured: isConfigured("mock"),
    anthropic_key_present: anthropicKeyPresent,
    openai_key_present: openaiKeyPresent,
    glm_key_present: glmKeyPresent,
    mock_forcing_envs: {
      AI_PROVIDER: Boolean(process.env.AI_PROVIDER),
      MODEL_PROVIDER: Boolean(process.env.MODEL_PROVIDER),
      LLM_PROVIDER: Boolean(process.env.LLM_PROVIDER),
      GATEWAY_PROVIDER: Boolean(process.env.GATEWAY_PROVIDER),
      USE_MOCK: Boolean(process.env.USE_MOCK),
      MODEL_ID: Boolean(process.env.MODEL_ID),
      DEFAULT_MODEL: Boolean(process.env.DEFAULT_MODEL),
      JACE_MODEL_ID: Boolean(process.env.JACE_MODEL_ID),
    },
  };
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
      gateway_debug: gatewayDebug,
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
    gateway_debug: gatewayDebug,
  });
}
