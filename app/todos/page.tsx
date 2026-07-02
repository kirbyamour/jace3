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
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [recFor, setRecFor] = useState<string | null>(null);
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

  async function retagAndMove(id: string, listName: string | null) {
    const t = todos.find((x) => x.id === id);
    if (!t) return;
    const bare = t.text.replace(/^\[[^\]]{1,40}\]\s*/, "");
    const text = listName ? `[${listName}] ${bare}` : bare;
    setTodos((x) => x.map((y) => (y.id === id ? { ...y, text, do_on: null } : y)));
    await sb.from("todos").update({ text, do_on: null, position: Date.now() / 1000 }).eq("id", id);
  }

  async function moveTo(id: string, dayKey: string | null) {
    setTodos((x) => x.map((y) => (y.id === id ? { ...y, do_on: dayKey } : y)));
    await sb.from("todos").update({ do_on: dayKey, position: Date.now() / 1000 }).eq("id", id);
  }

  async function saveEdit(id: string) {
    const text = editVal.trim();
    setEditing(null);
    if (!text) return;
    setTodos((x) => x.map((y) => (y.id === id ? { ...y, text } : y)));
    await sb.from("todos").update({ text }).eq("id", id);
  }

  async function setRecurrence(id: string, recurrence: string | null) {
    setRecFor(null);
    setTodos((x) => x.map((y) => (y.id === id ? { ...y, recurrence } : y)));
    await sb.from("todos").update({ recurrence }).eq("id", id);
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
        style={{ minWidth: 210, flex: 1, padding: "0 10px", borderRight: "1px solid var(--line)", overflowY: "auto" }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em",
          color: isToday ? "var(--ink)" : "var(--ink-soft)", borderBottom: isToday ? "2px solid var(--ink)" : "none",
          paddingBottom: 6 }}>{title}</h3>
        {items.map((t) => (
          <div key={t.id} draggable={editing !== t.id} onDragStart={() => setDragId(t.id)}
            style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", cursor: "grab", fontSize: 14.5, position: "relative" }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            {editing === t.id ? (
              <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(t.id); if (e.key === "Escape") setEditing(null); }}
                onBlur={() => saveEdit(t.id)}
                style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "2px 6px",
                  background: "var(--bg)", fontSize: 14.5, outline: "none" }} />
            ) : (
              <span onDoubleClick={() => { setEditing(t.id); setEditVal(t.text); }}
                title="double-click to edit"
                style={{ flex: 1, textDecoration: t.done ? "line-through" : "none",
                  color: t.done ? "var(--ink-soft)" : "var(--ink)", overflowWrap: "anywhere" }}>
                {t.text}
              </span>
            )}
            <button onClick={() => setRecFor(recFor === t.id ? null : t.id)}
              style={{ color: t.recurrence ? "var(--ink)" : "var(--ink-soft)", fontSize: 12 }}
              title={t.recurrence ? `repeats ${t.recurrence}` : "set repeat"}>↻</button>
            <button onClick={() => remove(t.id)} style={{ color: "var(--ink-soft)", fontSize: 12 }} title="delete">×</button>
            {recFor === t.id && (
              <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 30, background: "var(--bg)",
                border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.15)", padding: 4, minWidth: 130 }}>
                {[["", "no repeat"], ["daily", "every day"], ["weekdays", "weekdays"], ["weekly", "every week"], ["monthly", "every month"]].map(([val, label]) => (
                  <button key={val} onClick={() => setRecurrence(t.id, val || null)}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
                      borderRadius: 6, fontSize: 13.5,
                      fontWeight: (t.recurrence ?? "") === val ? 700 : 400 }}>{label}</button>
                ))}
              </div>
            )}
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

  function focusesColumn() {
    const items = todos.filter((t) => t.do_on === null && t.text.startsWith("[Focuses]"))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position);
    return (
      <div style={{ minWidth: 210, maxWidth: 240, flexShrink: 0, padding: "0 10px",
        borderRight: "2px solid var(--line)", background: "var(--sidebar)", borderRadius: 10 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => { if (dragId) { retagAndMove(dragId, "Focuses"); setDragId(null); } }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em",
          fontWeight: 700, paddingBottom: 6, paddingTop: 2 }}>◎ Focuses</h3>
        {items.map((t) => (
          <div key={t.id} draggable onDragStart={() => setDragId(t.id)}
            style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", cursor: "grab", fontSize: 14 }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            {editing === t.id ? (
              <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(t.id); if (e.key === "Escape") setEditing(null); }}
                onBlur={() => saveEdit(t.id)}
                style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "2px 6px", background: "var(--bg)", fontSize: 14, outline: "none" }} />
            ) : (
              <span onDoubleClick={() => { setEditing(t.id); setEditVal(t.text); }}
                style={{ flex: 1, textDecoration: t.done ? "line-through" : "none",
                  color: t.done ? "var(--ink-soft)" : "var(--ink)", overflowWrap: "anywhere" }}>
                {t.text.replace(/^\[Focuses\]\s*/, "")}
              </span>
            )}
            <button onClick={() => remove(t.id)} style={{ color: "var(--ink-soft)", fontSize: 12 }}>×</button>
          </div>
        ))}
        <input placeholder="+" value={drafts["focuses"] ?? ""}
          onChange={(e) => setDrafts((d) => ({ ...d, focuses: e.target.value }))}
          onKeyDown={async (e) => {
            if (e.key !== "Enter") return;
            const text = (drafts["focuses"] ?? "").trim();
            if (!text) return;
            setDrafts((d) => ({ ...d, focuses: "" }));
            const { data: { user } } = await sb.auth.getUser();
            if (!user) return;
            const { data } = await sb.from("todos").insert({ user_id: user.id, text: "[Focuses] " + text, do_on: null }).select().single();
            if (data) setTodos((x) => [...x, data as Todo]);
          }}
          style={{ width: "100%", border: 0, outline: 0, background: "transparent", padding: "6px 0", fontSize: 14, color: "var(--ink)" }} />
      </div>
    );
  }

  function somedayBand() {
    const somedayItems = todos.filter((t) => t.do_on === null && !t.text.startsWith("[Focuses]"));
    const groups = new Map<string, Todo[]>();
    for (const t of somedayItems) {
      const m = t.text.match(/^\[([^\]]{1,40})\]\s*/);
      const key = m ? m[1] : "Someday";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    const names = [...groups.keys()].sort((a, b) => (a === "Someday" ? -1 : b === "Someday" ? 1 : a.localeCompare(b)));
    const strip = (s: string) => s.replace(/^\[[^\]]{1,40}\]\s*/, "");
    return (
      <div style={{ display: "flex", overflowX: "auto", alignItems: "flex-start", paddingBottom: 24, WebkitOverflowScrolling: "touch" as never, touchAction: "pan-x pan-y" }}>
        {names.map((name) => (
          <div key={name} style={{ minWidth: 220, maxWidth: 260, padding: "0 12px", borderRight: "1px solid var(--line)", flexShrink: 0, maxHeight: "72dvh", overflowY: "auto", WebkitOverflowScrolling: "touch" as never }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragId) { retagAndMove(dragId, name === "Someday" ? null : name); setDragId(null); } }}>
            <h3 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700, paddingBottom: 4 }}>
              {name} <span style={{ color: "var(--ink-soft)", fontWeight: 400, fontSize: 12 }}>{groups.get(name)!.length}</span>
            </h3>
            {groups.get(name)!.sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position).map((t) => (
              <div key={t.id} draggable onDragStart={() => setDragId(t.id)}
                style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", cursor: "grab", fontSize: 14, borderBottom: "1px solid var(--line)" }}>
                <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
                {editing === t.id ? (
                  <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(t.id); if (e.key === "Escape") setEditing(null); }}
                    onBlur={() => saveEdit(t.id)}
                    style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "2px 6px", background: "var(--bg)", fontSize: 14, outline: "none" }} />
                ) : (
                  <span onDoubleClick={() => { setEditing(t.id); setEditVal(t.text); }}
                    style={{ flex: 1, textDecoration: t.done ? "line-through" : "none",
                      color: t.done ? "var(--ink-soft)" : "var(--ink)", overflowWrap: "anywhere" }}>
                    {strip(t.text)}
                  </span>
                )}
                <button onClick={() => remove(t.id)} style={{ color: "var(--ink-soft)", fontSize: 12 }}>×</button>
              </div>
            ))}
            <input placeholder="+" value={drafts["sd-" + name] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, ["sd-" + name]: e.target.value }))}
              onKeyDown={async (e) => {
                if (e.key !== "Enter") return;
                const text = (drafts["sd-" + name] ?? "").trim();
                if (!text) return;
                setDrafts((d) => ({ ...d, ["sd-" + name]: "" }));
                const { data: { user } } = await sb.auth.getUser();
                if (!user) return;
                const full = name === "Someday" ? text : "[" + name + "] " + text;
                const { data } = await sb.from("todos").insert({ user_id: user.id, text: full, do_on: null }).select().single();
                if (data) setTodos((x) => [...x, data as Todo]);
              }}
              style={{ width: "100%", border: 0, outline: 0, background: "transparent", padding: "6px 0", fontSize: 14, color: "var(--ink)" }} />
          </div>
        ))}
        <div style={{ minWidth: 200, padding: "0 12px" }}>
          <input placeholder='+ new list ("[Name] first task")' value={drafts["someday"] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, someday: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") add(null); }}
            style={{ width: "100%", border: "1px dashed var(--line)", borderRadius: 8, padding: "8px 10px", background: "transparent", fontSize: 13, color: "var(--ink-soft)", outline: "none" }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "18px 16px", minHeight: "100dvh" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
        <a href="/" style={{ color: "var(--ink-soft)", textDecoration: "none" }}>← Jace</a>
        <strong>Todos</strong>
        <span style={{ flex: 1 }} />
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
        <button onClick={() => setWeekStart(new Date())} style={{ fontSize: 13 }}>today</button>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", minHeight: "58dvh", maxHeight: "80dvh", alignItems: "stretch", WebkitOverflowScrolling: "touch" as never, touchAction: "pan-x pan-y" }}>
        {focusesColumn()}
        {days.map((d) => column(
          d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
          dayISO(d), dayISO(d) === today))}
      </div>
      <div style={{ borderTop: "2px solid var(--line)", marginTop: 8, paddingTop: 12 }}>
        {somedayBand()}
      </div>
      <p style={{ color: "var(--ink-soft)", fontSize: 12, textAlign: "center" }}>
        Unfinished days roll forward on their own. Drag between days. Jace can work this board from any conversation.
      </p>
    </div>
  );
}
