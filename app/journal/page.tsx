"use client";
// Jace's Reflective Journal — his, visible to Kirby (Transparent Development Mode).
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Entry = { id: string; written_at: string; content: string };

export default function Journal() {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    supabaseBrowser().from("journal")
      .select("id, written_at, content")
      .order("written_at", { ascending: false }).limit(100)
      .then(({ data }) => setEntries((data as Entry[]) ?? []));
  }, []);
  return (
    <div className="lab" style={{ maxWidth: 720 }}>
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/heartbeat">Heartbeat</a> · <a href="/timeline">Timeline</a></p>
      <h1>Jace's Journal</h1>
      <p style={{ color: "var(--ink-soft)" }}>His reflections — not memory, not logs. Nothing hidden while trust is being built.</p>
      {entries.length === 0 && <p style={{ color: "var(--ink-soft)" }}>No entries yet. His first reflection comes with his next quiet moment.</p>}
      {entries.map((e) => (
        <div className="card" key={e.id} style={{ marginBottom: 14 }}>
          <span className="ms">{new Date(e.written_at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
          <div className="out" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{e.content}</div>
        </div>
      ))}
    </div>
  );
}
