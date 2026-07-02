import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { splitForSpeech } from "@/lib/reading/clean";

export const runtime = "nodejs";
export const maxDuration = 120;

// Reader voice: paragraph-at-a-time TTS with prefetch on the client and
// mp3 caching in Storage, so a re-listen (or resume) costs nothing.
// Provider: Speechify if SPEECHIFY_API_KEY is set (2.0's reader voice),
// otherwise ElevenLabs (Jace's own voice infrastructure).

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}

async function speechifyTTS(text: string, voiceOverride?: string): Promise<ArrayBuffer | null> {
  const key = process.env.SPEECHIFY_API_KEY;
  if (!key) return null;
  // Model names drift; try current names in order (same lesson as ElevenLabs).
  const models = [process.env.SPEECHIFY_MODEL, "simba-3.0", "simba-english", undefined].filter((m, i, a) => a.indexOf(m) === i);
  for (const model of models) {
    const res = await fetch("https://api.sws.speechify.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        input: text, voice_id: voiceOverride ?? process.env.SPEECHIFY_VOICE_ID ?? "henry",
        ...(model ? { model } : {}), audio_format: "mp3",
      }),
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.audio_data) return Buffer.from(data.audio_data, "base64").buffer;
  }
  return null;
}

const TTS_MODELS = [process.env.ELEVENLABS_MODEL, "eleven_turbo_v2_5", "eleven_multilingual_v2"].filter(Boolean) as string[];

async function pickReaderVoice(key: string): Promise<string | null> {
  if (process.env.JACE_READER_VOICE_ID) return process.env.JACE_READER_VOICE_ID;
  if (process.env.JACE_VOICE_ID) return process.env.JACE_VOICE_ID;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!res.ok) return null;
  const voices: { voice_id: string; category?: string }[] = (await res.json()).voices ?? [];
  const gen = voices.find((v) => v.category === "generated");
  const pro = voices.find((v) => v.category === "professional");
  const pre = voices.find((v) => v.category === "premade");
  return (gen ?? pro ?? pre ?? voices[0])?.voice_id ?? null;
}

async function elevenTTS(text: string): Promise<ArrayBuffer | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voice = await pickReaderVoice(key);
  if (!voice) return null;
  for (const model of TTS_MODELS) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_96`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.55, similarity_boost: 0.7 } }),
    });
    if (res.ok) return await res.arrayBuffer();
  }
  return null;
}

export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const key = process.env.SPEECHIFY_API_KEY;
  if (!key) return Response.json({ ok: true, provider: "elevenlabs", voices: [] });
  const res = await fetch("https://api.sws.speechify.com/v1/voices", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) return Response.json({ ok: false, error: `speechify ${res.status}` });
  const data = await res.json();
  const raw: { id?: string; display_name?: string; name?: string; gender?: string; locale?: string; tags?: string[]; models?: { name?: string }[] }[] =
    Array.isArray(data) ? data : data.voices ?? [];
  const voices = raw
    .filter((v) => !v.locale || v.locale.startsWith("en"))
    .map((v) => ({ id: v.id ?? v.name, name: v.display_name ?? v.name ?? v.id, gender: v.gender ?? "", tags: v.tags ?? [] }));
  return Response.json({ ok: true, provider: "speechify", active: process.env.SPEECHIFY_VOICE_ID ?? "henry", voices });
}

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { itemId, index, voice } = await req.json();
  const db = admin();

  const { data: item } = await db.from("reading_items").select("listen_text, raw_text, clean_mode").eq("id", itemId).single();
  const text = item?.listen_text ?? item?.raw_text;
  if (!text) return new Response("no text", { status: 404 });
  const paras = splitForSpeech(text);
  if (index < 0 || index >= paras.length) return new Response("out of range", { status: 400 });

  const provider = process.env.SPEECHIFY_API_KEY ? "sp" : "el";
  const voiceKey = provider === "sp" ? (voice ?? process.env.SPEECHIFY_VOICE_ID ?? "henry") : "jace";
  const cachePath = `audio/${itemId}/${provider}-${voiceKey}-${item?.clean_mode ?? "raw"}/${index}.mp3`;
  const cached = await db.storage.from("reading").download(cachePath);
  if (cached.data) {
    return new Response(await cached.data.arrayBuffer(), {
      headers: { "content-type": "audio/mpeg", "x-paragraphs": String(paras.length), "x-cache": "hit" },
    });
  }

  const audio = (await speechifyTTS(paras[index], voice)) ?? (await elevenTTS(paras[index]));
  if (!audio) return new Response("tts failed", { status: 502 });
  await db.storage.from("reading").upload(cachePath, Buffer.from(audio), { contentType: "audio/mpeg", upsert: true });
  return new Response(audio, {
    headers: { "content-type": "audio/mpeg", "x-paragraphs": String(paras.length), "x-cache": "miss" },
  });
}
