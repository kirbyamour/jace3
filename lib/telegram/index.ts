import { createHash } from "crypto";

// One Jace: Telegram is a channel into the same conversation stream, never a second mind.

export function webhookSecret(): string {
  const tok = process.env.TELEGRAM_BOT_TOKEN ?? "";
  return createHash("sha256").update(`jace-telegram:${tok}`).digest("hex").slice(0, 40);
}

export async function tgSend(chatId: number | string, text: string): Promise<boolean> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return false;
  // Telegram messages cap at 4096 chars; Jace speaks in normal paragraphs anyway.
  const chunks = text.match(/[\s\S]{1,3900}/g) ?? [];
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) { console.error("[telegram] send failed:", await res.text()); return false; }
  }
  return true;
}

export function isQuietHours(quietStart: number, quietEnd: number, tz = "America/New_York"): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  return quietStart > quietEnd ? (hour >= quietStart || hour < quietEnd) : (hour >= quietStart && hour < quietEnd);
}
