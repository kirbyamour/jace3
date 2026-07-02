"use client";
// Todos — TeuxDeux in spirit: a calm week, a someday shelf, and no shame anywhere.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Todo = { id: string; text: string; do_on: string | null; done: boolean;
  recurrence: string | null; position: number };

const dayISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export default function Todos() {
  const sb = supabaseBrowser();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [weekStart, setWeekStart] = useState(() => new Date());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const today = dayISO(new Date());

  const load = useCallback(async () => {
    const { data } = await sb.from("todos").select("id,text,do_on,done,recurrence,position")
      .order("position").limit(1000);
    const rows = (data as Todo[]) ?? [];
    // Roll forward: unfinished past tasks quietly move to today. No shame, just carried.
    const stale = rows.filter((t) => !t.done && t.do_on && t.do_on < today);
    if (stale.length) {
      await sb.from("todos").update({ do_on: today }).in("id", stale.map((t) => t.id));
      stale.forEach((t) => { t.do_on = today; });
    }
    setTodos(rows);
  }, [sb, today]);
  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  async function add(dayKey: string | null) {
    const key = dayKey ?? "someday";
    const text = (drafts[key] ?? "").trim();
    if (!text) return;
    setDrafts((d) => ({ ...d, [key]: "" }));
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from("todos")
      .insert({ user_id: user.id, text, do_on: dayKey }).select().single();
    if (data) setTodos((t) => [...t, data as Todo]);
  }

  async function toggle(t: Todo) {
    const done = !t.done;
    setTodos((x) => x.map((y) => (y.id === t.id ? { ...y, done } : y)));
    await sb.from("todos").update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", t.id);
    if (done && t.recurrence && t.do_on) {
      const base = new Date(t.do_on + "T12:00:00");
      const next = t.recurrence === "daily" ? addDays(base, 1)
        : t.recurrence === "weekly" ? addDays(base, 7)
        : t.recurrence === "weekdays" ? addDays(base, base.getDay() === 5 ? 3 : 1)
        : new Date(base.getFullYear(), base.getMonth() + 1, base.getDate());
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data } = await sb.from("todos").insert({
          user_id: user.id, text: t.text, do_on: dayISO(next), recurrence: t.recurrence,
        }).select().single();
        if (data) setTodos((x) => [...x, data as Todo]);
      }
    }
  }

  async function moveTo(id: string, dayKey: string | null) {
    setTodos((x) => x.map((y) => (y.id === id ? { ...y, do_on: dayKey } : y)));
    await sb.from("todos").update({ do_on: dayKey, position: Date.now() / 1000 }).eq("id", id);
  }

  async function remove(id: string) {
    setTodos((x) => x.filter((y) => y.id !== id));
    await sb.from("todos").delete().eq("id", id);
  }

  function column(title: string, dayKey: string | null, isToday = false) {
    const key = dayKey ?? "someday";
    const items = todos
      .filter((t) => (dayKey ? t.do_on === dayKey : t.do_on === null))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position);
    return (
      <div key={key}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => { if (dragId) { moveTo(dragId, dayKey); setDragId(null); } }}
        style={{ minWidth: 210, flex: 1, padding: "0 10px", borderRight: "1px solid var(--line)" }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em",
          color: isToday ? "var(--ink)" : "var(--ink-soft)", borderBottom: isToday ? "2px solid var(--ink)" : "none",
          paddingBottom: 6 }}>{title}</h3>
        {items.map((t) => (
          <div key={t.id} draggable onDragStart={() => setDragId(t.id)}
            style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", cursor: "grab", fontSize: 14.5 }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span style={{ flex: 1, textDecoration: t.done ? "line-through" : "none",
              color: t.done ? "var(--ink-soft)" : "var(--ink)", overflowWrap: "anywhere" }}>
              {t.text}{t.recurrence ? " ↻" : ""}
            </span>
            <button onClick={() => remove(t.id)} style={{ color: "var(--ink-soft)", fontSize: 12 }} title="delete">×</button>
          </div>
        ))}
        <input placeholder="+" value={drafts[key] ?? ""}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") add(dayKey); }}
          style={{ width: "100%", border: 0, outline: 0, background: "transparent",
            padding: "6px 0", fontSize: 14.5, color: "var(--ink)" }} />
      </div>
    );
  }

  return (
    <div style={{ padding: "18px 16px", height: "100dvh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
        <a href="/" style={{ color: "var(--ink-soft)", textDecoration: "none" }}>← Jace</a>
        <strong>Todos</strong>
        <span style={{ flex: 1 }} />
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
        <button onClick={() => setWeekStart(new Date())} style={{ fontSize: 13 }}>today</button>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", flex: 1, alignItems: "stretch" }}>
        {days.map((d) => column(
          d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
          dayISO(d), dayISO(d) === today))}
        {column("Someday", null)}
      </div>
      <p style={{ color: "var(--ink-soft)", fontSize: 12, textAlign: "center" }}>
        Unfinished days roll forward on their own. Drag between days. Jace can work this board from any conversation.
      </p>
    </div>
  );
}
