import { NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Jace's voice — ElevenLabs. GET lists available voices; POST streams speech.
// Voice selection: JACE_VOICE_ID env, else the first custom (non-premade) voice, else first voice.

async function pickVoice(key: string): Promise<string | null> {
  if (process.env.JACE_VOICE_ID) return process.env.JACE_VOICE_ID;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!res.ok) return null;
  const data = await res.json();
  const voices: { voice_id: string; name?: string; category?: string }[] = data.voices ?? [];
  const wantName = process.env.JACE_VOICE_NAME?.toLowerCase();
  if (wantName) {
    const byName = voices.find((v) => v.name?.toLowerCase() === wantName)
      ?? voices.find((v) => v.name?.toLowerCase().includes(wantName));
    if (byName) return byName.voice_id;
  }
  const cloned = voices.find((v) => v.category === "cloned");
  const custom = voices.find((v) => v.category && v.category !== "premade");
  return (cloned ?? custom ?? voices[0])?.voice_id ?? null;
}

// Model names drift; never hardcode a single one (we know better by now).
const TTS_MODELS = [
  process.env.ELEVENLABS_MODEL,
  "eleven_turbo_v2_5",
  "eleven_multilingual_v2",
  "eleven_monolingual_v1",
].filter(Boolean) as string[];

export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ ok: false, error: "ELEVENLABS_API_KEY not set" });
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!res.ok) return Response.json({ ok: false, error: `elevenlabs ${res.status}` });
  const data = await res.json();
  const active = await pickVoice(key);
  return Response.json({
    ok: true, active,
    voices: (data.voices ?? []).map((v: { voice_id: string; name: string; category?: string }) =>
      ({ id: v.voice_id, name: v.name, category: v.category })),
  });
}

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return new Response("no tts key", { status: 503 });
  const { text, voiceId, voiceName } = await req.json();
  if (!text?.trim()) return new Response("empty", { status: 400 });
  let voice = voiceId as string | undefined;
  if (!voice && voiceName) {
    const res0 = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (res0.ok) {
      const vs: { voice_id: string; name?: string }[] = (await res0.json()).voices ?? [];
      const want = String(voiceName).toLowerCase();
      voice = (vs.find((v) => v.name?.toLowerCase() === want) ?? vs.find((v) => v.name?.toLowerCase().includes(want)))?.voice_id;
    }
  }
  if (!voice) voice = (await pickVoice(key)) ?? undefined;
  if (!voice) return new Response("no voice", { status: 503 });

  // Strip markdown for speech
  const spoken = String(text)
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/[*_#>`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .slice(0, 4500);

  let lastErr = "";
  for (const model of TTS_MODELS) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text: spoken,
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
      }),
    });
    if (res.ok && res.body) {
      return new Response(res.body, {
        headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
      });
    }
    lastErr = `${model}: ${res.status} ${(await res.text()).slice(0, 300)}`;
    console.error("[tts]", lastErr);
    if (res.status !== 400 && res.status !== 404 && res.status !== 422) break; // only model-shaped errors fall through
  }
  return new Response(JSON.stringify({ error: lastErr }), { status: 502 });
}
