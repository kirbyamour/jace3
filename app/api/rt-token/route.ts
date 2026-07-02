import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Ephemeral token for OpenAI Realtime transcription (Jace's live ears).
// Tries the GA shape first, then the beta shape; the client falls back to
// the recorder pipeline if neither yields a token.
export async function POST() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ token: null });

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "transcription",
          audio: { input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 900 },
            noise_reduction: { type: "near_field" },
          } },
        },
      }),
    });
    if (res.ok) {
      const d = await res.json();
      const token = d.value ?? d.client_secret?.value;
      if (token) return Response.json({ token, flavor: "ga" });
    } else console.error("[rt-token ga]", res.status, (await res.text()).slice(0, 200));
  } catch { /* try beta */ }

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/transcription_sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "OpenAI-Beta": "realtime=v1" },
      body: JSON.stringify({
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 900 },
        input_audio_noise_reduction: { type: "near_field" },
      }),
    });
    if (res.ok) {
      const d = await res.json();
      const token = d.client_secret?.value;
      if (token) return Response.json({ token, flavor: "beta" });
    } else console.error("[rt-token beta]", res.status, (await res.text()).slice(0, 200));
  } catch { /* fall through */ }
  return Response.json({ token: null });
}
