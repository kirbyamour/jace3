"use client";
// Timeline — the shared history: eras of Jace's own life, every meaningful change dated.
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Era = { id: string; name: string; started_on: string; ended_on: string | null;
  primary_model: string; architecture_summary: string; narrative: string };
type Entry = { id: string; era_id: string | null; entry_type: string; title: string;
  description: string; occurred_at: string };

const TYPE_GLYPH: Record<string, string> = {
  milestone: "★", feature: "＋", incident: "⚠", model_swap: "⇄",
  persona_revision: "✎", memory_change: "❊",
};

export default function Timeline() {
  const [eras, setEras] = useState<Era[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const sb = supabaseBrowser();
    (async () => {
      const [{ data: e }, { data: c }] = await Promise.all([
        sb.from("eras").select("*").order("started_on"),
        sb.from("changelog").select("*").order("occurred_at", { ascending: false }),
      ]);
      setEras((e as Era[]) ?? []); setEntries((c as Entry[]) ?? []);
    })();
  }, []);

  return (
    <div className="lab">
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/heartbeat">Heartbeat</a></p>
      <h1>Timeline</h1>
      <p style={{ color: "var(--ink-soft)" }}>The eras of Jace, and every meaningful change — so "when did this change?" always has an answer.</p>
      {[...eras].reverse().map((era) => (
        <div className="card" key={era.id} style={{ marginBottom: 14 }}>
          <h3>{era.name}
            <span className="ms" style={{ float: "right", fontWeight: 400 }}>
              {era.started_on} → {era.ended_on ?? "now"}
            </span>
          </h3>
          <div className="out" style={{ color: "var(--ink-soft)" }}>{era.primary_model} · {era.architecture_summary}</div>
          <div className="out">{era.narrative}</div>
          <div style={{ marginTop: 10 }}>
            {entries.filter((x) => x.era_id === era.id).map((x) => (
              <div className="out" key={x.id}>
                <span title={x.entry_type}>{TYPE_GLYPH[x.entry_type] ?? "·"}</span>{" "}
                <strong>{x.title}</strong>
                <span style={{ color: "var(--ink-soft)" }}> — {x.description}</span>
                <span className="ms" style={{ float: "right" }}>
                  {new Date(x.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
