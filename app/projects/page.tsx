"use client";
// Projects — surfaces over the storylines Jace already lives with.
// Each project: his current understanding, its moments, its tasks, your notes and milestones.
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Arc = { id: string; name: string; kind: string; status: string; summary: string; last_event: string | null };
type Episode = { title: string; summary: string; happened_on: string; arc_names: string[] };
type Todo = { id: string; text: string; done: boolean; do_on: string | null };
type Note = { id: string; kind: string; content: string; created_at: string };

export default function Projects() {
  const sb = supabaseBrowser();
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [open, setOpen] = useState<Arc | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<"note" | "milestone">("note");

  useEffect(() => {
    sb.from("arcs").select("id,name,kind,status,summary,last_event")
      .in("kind", ["project", "legal", "craft"])
      .order("status").order("last_event", { ascending: false })
      .then(({ data }) => setArcs((data as Arc[]) ?? []));
  }, []);

  useEffect(() => {
    if (!open) return;
    const key = open.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)[0] ?? open.name.toLowerCase();
    Promise.all([
      sb.from("episodes").select("title,summary,happened_on,arc_names")
        .contains("arc_names", [open.name]).order("happened_on", { ascending: false }).limit(30),
      sb.from("todos").select("id,text,done,do_on").ilike("text", `%${key}%`).limit(40),
      sb.from("project_notes").select("id,kind,content,created_at").eq("arc_name", open.name)
        .order("created_at", { ascending: false }).limit(50),
    ]).then(([e, t, n]) => {
      setEpisodes((e.data as Episode[]) ?? []);
      setTodos((t.data as Todo[]) ?? []);
      setNotes((n.data as Note[]) ?? []);
    });
  }, [open?.id]);

  async function addNote() {
    const content = draft.trim();
    if (!content || !open) return;
    setDraft("");
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from("project_notes")
      .insert({ user_id: user.id, arc_name: open.name, kind: draftKind, content }).select().single();
    if (data) setNotes((x) => [data as Note, ...x]);
  }

  const active = useMemo(() => arcs.filter((a) => a.status === "active"), [arcs]);
  const rest = useMemo(() => arcs.filter((a) => a.status !== "active"), [arcs]);

  if (open) {
    return (
      <div className="lab" style={{ maxWidth: 760 }}>
        <p style={{ marginBottom: 4 }}>
          <button onClick={() => setOpen(null)} style={{ color: "var(--ink-soft)" }}>← Projects</button>
        </p>
        <h1>{open.name} <span className="ms">{open.status}</span></h1>
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Where it stands (his read)</h3>
          <div className="out">{open.summary}</div>
          {open.last_event && <span className="ms">last movement: {open.last_event}</span>}
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Notes & milestones</h3>
          <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
            <select value={draftKind} onChange={(e) => setDraftKind(e.target.value as "note" | "milestone")}
              style={{ borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)" }}>
              <option value="note">note</option>
              <option value="milestone">★ milestone</option>
            </select>
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addNote(); }}
              placeholder="Add to this project…"
              style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)", outline: "none" }} />
          </div>
          {notes.map((n) => (
            <div className="out" key={n.id}>
              {n.kind === "milestone" ? "★ " : ""}{n.content}
              <span className="ms" style={{ float: "right" }}>
                {new Date(n.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          ))}
          {notes.length === 0 && <div className="out" style={{ color: "var(--ink-soft)" }}>Nothing yet.</div>}
        </div>

        {todos.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>On the board</h3>
            {todos.map((t) => (
              <div className="out" key={t.id} style={{ textDecoration: t.done ? "line-through" : "none",
                color: t.done ? "var(--ink-soft)" : "var(--ink)" }}>
                {t.text.replace(/^\[[^\]]+\]\s*/, "")}{t.do_on ? ` — ${t.do_on}` : ""}
              </div>
            ))}
          </div>
        )}

        {episodes.length > 0 && (
          <div className="card">
            <h3>Its story so far</h3>
            {episodes.map((e, i) => (
              <div className="out" key={i}>
                <strong>{e.title}</strong> <span className="ms">({e.happened_on})</span><br />
                <span style={{ color: "var(--ink-soft)" }}>{e.summary}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="lab">
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/todos">Todos</a> · <a href="/heartbeat">Heartbeat</a></p>
      <h1>Projects</h1>
      <p style={{ color: "var(--ink-soft)" }}>The storylines you're building — as he understands them, living and current.</p>
      <div className="grid">
        {active.map((a) => (
          <button key={a.id} className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setOpen(a)}>
            <h3>{a.name}</h3>
            <div className="out" style={{ color: "var(--ink-soft)", fontSize: 13.5 }}>{a.summary.slice(0, 140)}…</div>
            {a.last_event && <span className="ms">last movement: {a.last_event}</span>}
          </button>
        ))}
      </div>
      {rest.length > 0 && (
        <>
          <h3 style={{ marginTop: 22, color: "var(--ink-soft)" }}>Resting</h3>
          <div className="grid">
            {rest.map((a) => (
              <button key={a.id} className="card" style={{ textAlign: "left", cursor: "pointer", opacity: .7 }} onClick={() => setOpen(a)}>
                <h3>{a.name} <span className="ms">{a.status}</span></h3>
                <div className="out" style={{ color: "var(--ink-soft)", fontSize: 13.5 }}>{a.summary.slice(0, 120)}…</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
