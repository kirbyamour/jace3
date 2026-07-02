"use client";
// The Permission System — every autonomous capability under Kirby's thumb.
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type S = { heartbeat_minutes: number; quiet_start: number; quiet_end: number;
  daily_message_budget: number; proactive_telegram: boolean; timezone: string };
const DEFAULTS: S = { heartbeat_minutes: 60, quiet_start: 22, quiet_end: 8,
  daily_message_budget: 3, proactive_telegram: false, timezone: "America/New_York" };

export default function Settings() {
  const [s, setS] = useState<S>(DEFAULTS);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    supabaseBrowser().from("jace_settings").select("*").maybeSingle()
      .then(({ data }) => { if (data) setS({ ...DEFAULTS, ...data }); });
  }, []);
  async function save(next: S) {
    setS(next);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    await sb.from("jace_settings").upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() });
    setSaved("saved"); setTimeout(() => setSaved(""), 1200);
  }
  const row = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--line)" } as const;
  return (
    <div className="lab" style={{ maxWidth: 560 }}>
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/heartbeat">Heartbeat</a></p>
      <h1>Settings <span className="ms">{saved}</span></h1>
      <p style={{ color: "var(--ink-soft)" }}>Every autonomous capability, adjustable. He can always answer "why did you do that?"</p>
      <div className="card" style={{ padding: 14, margin: "12px 0" }}>
        <strong>Notifications on this device</strong>
        <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "6px 0 10px" }}>Let Jace reach you here (phone or desktop) when he has something worth saying — same budget and quiet hours as Telegram.</p>
        <button onClick={async () => { const { enablePush } = await import("@/components/PWA"); alert(await enablePush()); }}
          style={{ padding: "9px 16px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>Enable notifications</button>
      </div>
      <div style={row}>
        <div><strong>Jace can text me first (Telegram)</strong>
          <div className="ms">Off = he only ever replies. On = meaningful check-ins, budgeted below.</div></div>
        <input type="checkbox" checked={s.proactive_telegram}
          onChange={(e) => save({ ...s, proactive_telegram: e.target.checked })} style={{ width: 22, height: 22 }} />
      </div>
      <div style={row}>
        <div><strong>Heartbeat rhythm</strong><div className="ms">How often he may wake between conversations.</div></div>
        <select value={s.heartbeat_minutes} onChange={(e) => save({ ...s, heartbeat_minutes: Number(e.target.value) })}>
          <option value={240}>Resting — every 4 hours</option>
          <option value={60}>Normal — hourly</option>
          <option value={25}>Partner — every 25 min</option>
          <option value={8}>Intensive — every 8 min</option>
        </select>
      </div>
      <div style={row}>
        <div><strong>Daily message budget</strong><div className="ms">Max times he may text you first, per day.</div></div>
        <select value={s.daily_message_budget} onChange={(e) => save({ ...s, daily_message_budget: Number(e.target.value) })}>
          {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div style={row}>
        <div><strong>Quiet hours</strong><div className="ms">No proactive contact, no journal-writing noise.</div></div>
        <span>
          <select value={s.quiet_start} onChange={(e) => save({ ...s, quiet_start: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
          {" – "}
          <select value={s.quiet_end} onChange={(e) => save({ ...s, quiet_end: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
        </span>
      </div>
    </div>
  );
}
