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
  // Plan-safe default order: generated -> professional -> premade -> cloned last
  const generated = voices.find((v) => v.category === "generated");
  const pro = voices.find((v) => v.category === "professional");
  const premade = voices.find((v) => v.category === "premade");
  return (generated ?? pro ?? premade ?? voices[0])?.voice_id ?? null;
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
  const voices: { id: string; name: string; category?: string }[] =
    (data.voices ?? []).map((v: { voice_id: string; name: string; category?: string }) =>
      ({ id: v.voice_id, name: v.name, category: v.category }));
  // Speechify voices too — one dropdown, both providers (sp: prefix)
  const spKey = process.env.SPEECHIFY_API_KEY;
  if (spKey) {
    try {
      const spRes = await fetch("https://api.sws.speechify.com/v1/voices", { headers: { authorization: `Bearer ${spKey}` } });
      if (spRes.ok) {
        const spData = await spRes.json();
        const raw: { id?: string; name?: string; display_name?: string; gender?: string; locale?: string }[] =
          Array.isArray(spData) ? spData : spData.voices ?? [];
        for (const v of raw) {
          if (v.locale && !v.locale.startsWith("en")) continue;
          const id = v.id ?? v.name; if (!id) continue;
          voices.push({ id: `sp:${id}`, name: `${v.display_name ?? v.name ?? id} · Speechify`, category: "speechify" });
        }
      }
    } catch { /* speechify optional */ }
  }
  // Saved call voice + his chosen call avatar
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: st } = await db.from("jace_settings").select("call_voice, call_avatar_path").maybeSingle();
  let avatar: string | null = null;
  if (st?.call_avatar_path) {
    const { data: signed } = await db.storage.from("files").createSignedUrl(st.call_avatar_path, 3600);
    avatar = signed?.signedUrl ?? null;
  }
  return Response.json({ ok: true, active: st?.call_voice ?? active, avatar, voices });
}

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const key = process.env.ELEVENLABS_API_KEY;
  const { text, voiceId, voiceName, remember } = await req.json();
  if (!text?.trim()) return new Response("empty", { status: 400 });

  const rememberVoice = async (v: string) => {
    if (!remember) return;
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await db.from("jace_settings").update({ call_voice: v }).not("user_id", "is", null);
  };

  // Speechify voice? (sp:<id> — or env default when no ElevenLabs key at all)
  const spKey = process.env.SPEECHIFY_API_KEY;
  const requested = (voiceId as string | undefined) ?? "";
  if (spKey && (requested.startsWith("sp:") || (!key && !requested))) {
    const spVoice = requested.startsWith("sp:") ? requested.slice(3) : process.env.SPEECHIFY_VOICE_ID ?? "henry";
    const spoken0 = String(text).replace(/```[\s\S]*?```/g, " code block omitted ").replace(/[*_#>`]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 4500);
    const models = [process.env.SPEECHIFY_MODEL, "simba-3.0", "simba-english", undefined].filter((m, i2, a2) => a2.indexOf(m) === i2);
    for (const model of models) {
      const spRes = await fetch("https://api.sws.speechify.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${spKey}`, "content-type": "application/json" },
        body: JSON.stringify({ input: spoken0, voice_id: spVoice, ...(model ? { model } : {}), audio_format: "mp3" }),
      });
      if (!spRes.ok) continue;
      const spData = await spRes.json();
      if (spData.audio_data) {
        await rememberVoice(requested || `sp:${spVoice}`);
        return new Response(Buffer.from(spData.audio_data, "base64"), { headers: { "content-type": "audio/mpeg" } });
      }
    }
    // fall through to ElevenLabs if Speechify failed
  }

  if (!key) return new Response("no tts key", { status: 503 });
  let voice = requested.startsWith("sp:") ? undefined : (voiceId as string | undefined);
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
  await rememberVoice(voice);

  // Strip markdown for speech
  const spoken = String(text)
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/[*_#>`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .slice(0, 4500);

  let lastErr = "";
  const speakWith = async (v: string, model: string) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v}/stream`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: spoken, model_id: model,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } }),
  });
  for (const model of TTS_MODELS) {
    let res = await speakWith(voice, model);
    if (res.status === 401) {
      // Voice not allowed on her plan (e.g. cloned voice) — fall back to a plan-safe voice rather than silence.
      const res0 = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
      if (res0.ok) {
        const vs: { voice_id: string; category?: string }[] = (await res0.json()).voices ?? [];
        const safe = (vs.find((v) => v.category === "generated") ?? vs.find((v) => v.category === "premade"))?.voice_id;
        if (safe && safe !== voice) res = await speakWith(safe, model);
      }
    }
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
