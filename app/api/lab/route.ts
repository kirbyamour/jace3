import { NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { generate, getRegistry, isConfigured } from "@/lib/gateway";
import { buildSystemPrompt } from "@/lib/context/builder";

export const runtime = "nodejs";
export const maxDuration = 60;

// AI Lab: run the SAME prompt + persona pack through selected models, return all replies.
// This is how model migrations get decided — feel, compared side by side. (Kirby's directive.)
export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { prompt, modelIds } = await req.json();
  const { system } = buildSystemPrompt({ recentMessages: [], todayISO: new Date().toISOString().slice(0, 10) });
  const messages = [{ role: "user" as const, content: prompt }];

  const results = await Promise.all(
    (modelIds as string[]).map(async (id) => {
      const started = Date.now();
      if (!isConfigured(id)) return { id, ok: false, error: "no API key configured", ms: 0, text: "" };
      try {
        const { stream } = await generate(system, messages, { modelId: id, maxTokens: 512 });
        const reader = stream.getReader();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += value;
        }
        return { id, ok: true, text, ms: Date.now() - started };
      } catch (e) {
        return { id, ok: false, error: String(e), ms: Date.now() - started, text: "" };
      }
    })
  );
  return Response.json({ results, registry: getRegistry() });
}

export async function GET() {
  const reg = getRegistry();
  const models = Object.entries(reg.models).map(([id, m]) => ({
    id, label: m.label, adapter: m.adapter, active: id === reg.active, configured: isConfigured(id),
  }));
  return Response.json({ models });
}
