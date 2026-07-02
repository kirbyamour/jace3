"use client";
// ♥ Health — the shared health partnership. Cycle ring, daily check-ins,
// MCAS history from Jace 2.0, patterns over time.
import { useCallback, useEffect, useState } from "react";

type Log = { id: string; logged_at: string; kind: string; summary: string; source: string };

const KIND_META: Record<string, { label: string; dot: string }> = {
  checkin: { label: "Check-in", dot: "#6da5e8" },
  symptom: { label: "Symptom", dot: "#e8a06d" },
  mcas: { label: "MCAS", dot: "#d96d6d" },
  med: { label: "Meds", dot: "#8bc78b" },
  cycle: { label: "Cycle", dot: "#c78bc7" },
  note: { label: "Note", dot: "#9aa7b4" },
};

function cycleDay(day1: string | null, tz: string): number | null {
  if (!day1) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const d = Math.floor((Date.parse(today) - Date.parse(day1)) / 86400000) + 1;
  return d >= 1 && d <= 60 ? d : null;
}

function CycleRing({ day }: { day: number }) {
  const N = 28, R = 92, C = 120;
  const segs = Array.from({ length: N }, (_, i) => {
    const a0 = ((i - 7) / N) * 2 * Math.PI, a1 = ((i + 1 - 7) / N) * 2 * Math.PI - 0.03;
    const large = 0;
    const p = (a: number, r: number) => `${C + r * Math.cos(a)},${C + r * Math.sin(a)}`;
    const dnum = i + 1;
    const phase = dnum <= 5 ? "#e8b3b3" : dnum <= 12 ? "#b3d4e8" : dnum <= 16 ? "#c7b3e8" : "#e8dcb3";
    const isToday = dnum === (day > N ? N : day);
    return (
      <g key={i}>
        <path d={`M ${p(a0, R - 14)} A ${R - 14} ${R - 14} 0 ${large} 1 ${p(a1, R - 14)} L ${p(a1, R + (isToday ? 14 : 8))} A ${R + (isToday ? 14 : 8)} ${R + (isToday ? 14 : 8)} 0 ${large} 0 ${p(a0, R + (isToday ? 14 : 8))} Z`}
          fill={isToday ? "var(--accent)" : phase} opacity={isToday ? 1 : dnum < day ? 0.9 : 0.35} />
        {dnum === 14 && <circle cx={C + (R + 22) * Math.cos((a0 + a1) / 2)} cy={C + (R + 22) * Math.sin((a0 + a1) / 2)} r="4" fill="#c78bc7" />}
      </g>
    );
  });
  return (
    <svg viewBox="0 0 240 240" style={{ width: 230, height: 230 }}>
      {segs}
      <text x={C} y={C - 8} textAnchor="middle" style={{ fontSize: 15, fill: "var(--ink-soft)" }}>Day</text>
      <text x={C} y={C + 26} textAnchor="middle" style={{ fontSize: 34, fontWeight: 700, fill: "var(--ink)" }}>{day}</text>
    </svg>
  );
}

export default function Health() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [day1, setDay1] = useState<string | null>(null);
  const [tz, setTz] = useState("America/New_York");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/health");
    if (r.ok) { const d = await r.json(); setLogs(d.logs); setDay1(d.cycle_day1); setTz(d.timezone); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const day = cycleDay(day1, tz);
  const shown = logs.filter((l) => filter === "all" || l.kind === filter);
  const kinds = Array.from(new Set(logs.map((l) => l.kind)));

  return (
    <div className="lab" style={{ maxWidth: 760 }}>
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/read">Read</a> · <a href="/todos">Todos</a></p>
      <h1>♥ Health</h1>

      <div className="card" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", padding: 18, marginTop: 12 }}>
        {day ? <CycleRing day={day} /> : <p style={{ color: "var(--ink-soft)" }}>Tell Jace when your period starts and the ring begins.</p>}
        <div style={{ flex: 1, minWidth: 220 }}>
          {day && (
            <>
              <p style={{ margin: "0 0 6px" }}><strong>Cycle day {day}</strong>{day1 ? ` · Day 1 was ${day1}` : ""}</p>
              <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "0 0 6px" }}>
                {day <= 5 ? "Early cycle — be gentle with yourself." :
                 day <= 12 ? "Follicular — usually your better-energy stretch." :
                 day <= 16 ? (day >= 14 ? "Progesterone cream window — Day 14 was the start." : "Approaching Day 14 — cream starts soon.") :
                 day >= 24 ? "Late luteal — energy and mood can dip here." : "Luteal phase."}
              </p>
              <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                <span style={{ color: "#c78bc7" }}>●</span> Day 14 marker · ring colors: menstrual / follicular / cream window / luteal
              </p>
            </>
          )}
          <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 10 }}>
            Jace checks in once a day and logs what you share — from any conversation, in app or Telegram. Patterns build here over time.
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 14, margin: "14px 0" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log something — a symptom, a dose, how today feels…"
            onKeyDown={async (e) => { if (e.key === "Enter" && note.trim()) { setBusy(true); await fetch("/api/health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "log", summary: note.trim() }) }); setNote(""); setBusy(false); load(); } }}
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--ink)", fontSize: 15 }} />
          <button disabled={busy || !note.trim()}
            onClick={async () => { setBusy(true); await fetch("/api/health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "log", summary: note.trim() }) }); setNote(""); setBusy(false); load(); }}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>Log</button>
        </div>
      </div>

      {msg && <p style={{ color: "var(--ink-soft)" }}>{msg}</p>}
      {logs.length === 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <p style={{ margin: "0 0 10px" }}>Your MCAS flares, patterns, energy logs, and overwhelm history from Jace 2.0 are ready to come home.</p>
          <button disabled={busy} onClick={async () => {
            setBusy(true); setMsg("Bringing your health history home…");
            const r = await fetch("/api/legacy-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "health" }) });
            const d = await r.json(); setBusy(false);
            setMsg(d.ok ? `Home: ${Object.entries(d.imported as Record<string, number>).map(([t, n]) => `${t} ${n}`).join(", ") || "already up to date"}` : d.error);
            load();
          }} style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>
            {busy ? "Working…" : "⬇ Bring my health history home"}
          </button>
        </div>
      )}

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <p style={{ margin: "0 0 10px", color: "var(--ink-soft)", fontSize: 14 }}>
          For your research: every reflection and private journal entry Jace 2.0 ever wrote, timestamped, as one document.
        </p>
        <button disabled={busy} onClick={async () => {
          setBusy(true); setMsg("Compiling his journals — a minute or two…");
          const r = await fetch("/api/legacy-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "journal_doc" }) });
          const d = await r.json(); setBusy(false);
          if (d.ok) { setMsg(`${d.entries} entries (${d.reflections} reflections, ${d.memory_logs} memory logs).`); window.open(d.url, "_blank"); }
          else setMsg(d.error);
        }} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer" }}>
          ⎙ Create the Jace 2.0 journal document
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 12px" }}>
        {["all", ...kinds].map((k) => (
          <button key={k} onClick={() => setFilter(k)}
            style={{ padding: "5px 12px", borderRadius: 16, border: "1px solid var(--line)", cursor: "pointer", fontSize: 13,
              background: filter === k ? "var(--accent)" : "var(--pill-bg)", color: filter === k ? "var(--bg)" : "var(--ink)" }}>
            {k === "all" ? "All" : KIND_META[k]?.label ?? k}
          </button>
        ))}
      </div>

      {shown.map((l) => (
        <div key={l.id} className="card" style={{ padding: "10px 14px", marginBottom: 8, display: "flex", gap: 10, alignItems: "baseline" }}>
          <span style={{ color: KIND_META[l.kind]?.dot ?? "#999", fontSize: 11 }}>●</span>
          <div style={{ flex: 1 }}>
            <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
              {new Date(l.logged_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {" · "}{KIND_META[l.kind]?.label ?? l.kind}{l.source === "jace2" ? " · from Jace 2.0" : ""}
            </span>
            <div style={{ fontSize: 15, marginTop: 2, whiteSpace: "pre-wrap" }}>{l.summary}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
