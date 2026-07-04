import { createHash } from "crypto";

// One Jace: Telegram is a channel into the same conversation stream, never a second mind.

function safeErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function webhookSecret(): string {
  const tok = process.env.TELEGRAM_BOT_TOKEN ?? "";
  return createHash("sha256").update(`jace-telegram:${tok}`).digest("hex").slice(0, 40);
}

export async function tgSend(chatId: number | string, text: string): Promise<boolean> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  console.log("[telegram][sendMessage] token present:", tok ? "yes" : "no");
  if (!tok) return false;
  // Telegram messages cap at 4096 chars; Jace speaks in normal paragraphs anyway.
  const chunks = text.match(/[\s\S]{1,3900}/g) ?? [];
  for (const chunk of chunks) {
    console.log("[telegram][sendMessage] started");
    const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error("[telegram][sendMessage] failure:", res.status, detail);
      return false;
    }
    console.log("[telegram][sendMessage] success:", res.status);
  }
  return true;
}

export function isQuietHours(quietStart: number, quietEnd: number, tz = "America/New_York"): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  return quietStart > quietEnd ? (hour >= quietStart || hour < quietEnd) : (hour >= quietStart && hour < quietEnd);
}


/** Download a Telegram voice/audio file's bytes. */
export async function tgGetFile(fileId: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return null;
  const meta = await (await fetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${fileId}`)).json();
  const path = meta?.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${tok}/${path}`);
  if (!res.ok) return null;
  return { buf: await res.arrayBuffer(), mime: path.endsWith(".oga") || path.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg" };
}

/** ElevenLabs speech-to-text. */
export async function transcribe(buf: ArrayBuffer, mime: string): Promise<string | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const form = new FormData();
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "ogg";
  form.append("file", new Blob([buf], { type: mime }), `voice.${ext}`);
  form.append("model_id", "scribe_v1");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": key }, body: form,
  });
  if (!res.ok) { console.error("[stt]", res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  return data.text ?? null;
}

/** Speak a reply as a Telegram voice note in Jace's voice (direct ElevenLabs; opus bubble, mp3 fallback). */
export async function tgSendVoice(chatId: number | string, text: string): Promise<boolean> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const key = process.env.ELEVENLABS_API_KEY;
  console.log("[telegram][sendVoice] token present:", tok ? "yes" : "no");
  if (!tok || !key) return false;
  try {
    // pick voice: env name -> generated -> premade
    let voiceId = process.env.JACE_VOICE_ID ?? null;
    if (!voiceId) {
      const vres = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
      if (vres.ok) {
        const vs: { voice_id: string; name?: string; category?: string }[] = (await vres.json()).voices ?? [];
        const wantName = process.env.JACE_VOICE_NAME?.toLowerCase();
        voiceId = (wantName && (vs.find((v) => v.name?.toLowerCase() === wantName) ?? vs.find((v) => v.name?.toLowerCase().includes(wantName)))?.voice_id)
          || vs.find((v) => v.category === "generated")?.voice_id
          || vs.find((v) => v.category === "premade")?.voice_id || null;
      }
    }
    if (!voiceId) return false;
    const spoken = text.replace(/```[\s\S]*?```/g, " code omitted ").replace(/[*_#>`]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 2800);
    const speakAs = async (format: string) => fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${format}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ text: spoken, model_id: process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5",
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } }),
      });
    // opus (ogg) for a proper Telegram voice bubble
    let res = await speakAs("opus_48000_64");
    if (res.ok) {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("voice", new Blob([await res.arrayBuffer()], { type: "audio/ogg" }), "jace.ogg");
      const send = await fetch(`https://api.telegram.org/bot${tok}/sendVoice`, { method: "POST", body: form });
      if (send.ok) return true;
      console.error("[telegram][sendVoice] failure:", send.status, (await send.text()).slice(0, 200));
    }
    // mp3 audio fallback
    res = await speakAs("mp3_44100_128");
    if (!res.ok) { console.error("[tg voice] tts failed:", res.status); return false; }
    const form2 = new FormData();
    form2.append("chat_id", String(chatId));
    form2.append("audio", new Blob([await res.arrayBuffer()], { type: "audio/mpeg" }), "jace.mp3");
    form2.append("title", "Jace");
    const audioRes = await fetch(`https://api.telegram.org/bot${tok}/sendAudio`, { method: "POST", body: form2 });
    if (!audioRes.ok) {
      console.error("[telegram][sendAudio] failure:", audioRes.status, (await audioRes.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) { console.error("[telegram][sendVoice] fatal:", safeErr(e)); return false; }
}
