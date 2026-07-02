import { NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { transcribe } from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 60;

// Conversation Mode's ears: audio utterance in, text out (ElevenLabs Scribe).
export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const mime = req.headers.get("content-type") ?? "audio/webm";
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 1500) return Response.json({ text: "" }); // too short to be speech
  if (buf.byteLength > 10_000_000) return new Response("too large", { status: 413 });
  let text = await transcribe(buf, mime);
  let engine = "scribe";
  if (!text?.trim() && process.env.OPENAI_API_KEY) {
    // second set of ears: OpenAI Whisper handles iOS m4a very reliably
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : "ogg";
    for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), `voice.${ext}`);
      form.append("model", model);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
      });
      if (!res.ok) { console.error("[stt-openai]", model, res.status, (await res.text()).slice(0, 150)); continue; }
      const data = await res.json();
      if (data.text?.trim()) { text = data.text; engine = model; break; }
    }
  }
  return Response.json({ text: text ?? "", engine });
}
