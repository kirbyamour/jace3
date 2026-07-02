// Jace reaches her devices: web push to every subscribed browser/phone.
import { createClient } from "@supabase/supabase-js";

const VAPID_PUBLIC = "BKnH4ghav4QpBQ0qw0mk5qYQvWO7osfBUa_fTBNUMQCrVROfXROqMuyqEpN2w5r_7mJXX-QGYTXq4rrZbpW_EMQ";

export async function sendPushAll(payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) return 0;
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails("mailto:hi@kirbyamour.com", VAPID_PUBLIC, priv);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: subs } = await db.from("push_subscriptions").select("endpoint, sub");
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(s.sub as never, JSON.stringify(payload));
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    }
  }
  return sent;
}
