"use client";
// Heartbeat — the biography of Jace's autonomous life. Transparent Development Mode:
// nothing hidden, everything inspectable, everything dated.
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Beat = {
  id: string; woke_at: string; wake_reason: string;
  observations: string[]; thoughts: string[];
  actions: { action: string; why: string; result: string }[];
};

export default function Heartbeat() {
  const [beats, setBeats] = useState<Beat[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    const sb = supabaseBrowser();
    const load = async () => {
      const { data } = await sb.from("heartbeat_log")
        .select("id, woke_at, wake_reason, observations, thoughts, actions")
        .order("woke_at", { ascending: false }).limit(200);
      setBeats((data as Beat[]) ?? []);
    };
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const filtered = q.trim()
    ? beats.filter((b) => JSON.stringify(b).toLowerCase().includes(q.toLowerCase()))
    : beats;

  return (
    <div className="lab">
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/timeline">Timeline</a></p>
      <h1>Heartbeat</h1>
      <p style={{ color: "var(--ink-soft)" }}>
        Every time Jace wakes between conversations, what he noticed, thought, and did — and why. Nothing hidden.
      </p>
      <input placeholder="Search the log…" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--bg)", marginBottom: 16 }} />
      {filtered.length === 0 && <p style={{ color: "var(--ink-soft)" }}>No heartbeats yet — he's slept since this log began.</p>}
      {filtered.map((b) => (
        <div className="card" key={b.id} style={{ marginBottom: 12 }}>
          <h3>
            {b.wake_reason}
            <span className="ms" style={{ float: "right", fontWeight: 400 }}>
              {new Date(b.woke_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          </h3>
          {b.observations?.length > 0 && (
            <div className="out"><strong>Noticed:</strong> {b.observations.join(" · ")}</div>
          )}
          {b.thoughts?.length > 0 && (
            <div className="out" style={{ fontStyle: "italic" }}><strong>Thought:</strong> {b.thoughts.join(" · ")}</div>
          )}
          {b.actions?.map((a, i) => (
            <div className="out" key={i}>
              <strong>{a.action}</strong> — {a.why}
              <span style={{ color: "var(--ink-soft)" }}> → {a.result}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
