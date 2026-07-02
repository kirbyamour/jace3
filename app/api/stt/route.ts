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
  const text = await transcribe(buf, mime);
  return Response.json({ text: text ?? "" });
}
