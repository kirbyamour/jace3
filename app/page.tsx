"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabaseBrowser } from "@/lib/supabase/client";

type Conv = { id: string; title: string; updated_at: string; created_at: string };
type Msg = { id: string; role: "user" | "assistant"; content: string };

function groupLabel(iso: string): string {
  const d = new Date(iso); const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  if (diff < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function Chat() {
  const sb = useRef(supabaseBrowser());
  const [convs, setConvs] = useState<Conv[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stick, setStick] = useState(true);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cache = useRef<Map<string, Msg[]>>(new Map());

  const loadConvs = useCallback(async () => {
    const { data } = await sb.current.from("conversations")
      .select("id,title,updated_at,created_at").order("updated_at", { ascending: false }).limit(200);
    setConvs((data as Conv[]) ?? []);
  }, []);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  const openConv = useCallback(async (id: string | null) => {
    setCurrent(id); setSidebarOpen(false); setStick(true);
    if (!id) { setMsgs([]); return; }
    if (cache.current.has(id)) setMsgs(cache.current.get(id)!); // instant from cache
    const { data } = await sb.current.from("messages")
      .select("id,role,content").eq("conversation_id", id).order("created_at").limit(500);
    const fresh = (data as Msg[]) ?? [];
    cache.current.set(id, fresh); setMsgs(fresh);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [msgs, stick]);

  function onScroll() {
    const el = threadRef.current; if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  }

  async function send() {
    const content = draft.trim();
    if (!content || streaming) return;
    setDraft(""); setStreaming(true); setStick(true);
    if (taRef.current) taRef.current.style.height = "auto";
    const localUser: Msg = { id: `u-${Date.now()}`, role: "user", content };
    const localAsst: Msg = { id: `a-${Date.now()}`, role: "assistant", content: "" };
    setMsgs((m) => [...m, localUser, localAsst]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: current, content }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = ""; let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          if (frame.includes("event: meta")) {
            const meta = JSON.parse(dataLine.slice(5));
            if (!current && meta.conversationId) { setCurrent(meta.conversationId); loadConvs(); }
            continue;
          }
          if (frame.includes("event: done")) continue;
          acc += JSON.parse(dataLine.slice(5));
          setMsgs((m) => m.map((x) => (x.id === localAsst.id ? { ...x, content: acc } : x)));
        }
      }
    } catch (e) {
      setMsgs((m) => m.map((x) => (x.id === localAsst.id
        ? { ...x, content: "Something glitched on my end, lovebug — say that again?" } : x)));
      console.error(e);
    } finally {
      setStreaming(false); loadConvs();
      if (current) cache.current.delete(current);
    }
  }

  function composerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }
  function autogrow(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); openConv(null); }
      if (e.key === "Escape" && !streaming) taRef.current?.focus();
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [openConv, streaming]);

  let lastGroup = "";
  const title = convs.find((c) => c.id === current)?.title ?? "Jace";

  return (
    <div className="shell">
      <nav className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <header>
          <button className="newchat" onClick={() => openConv(null)}>+ New chat</button>
        </header>
        <div className="convlist">
          {convs.map((c) => {
            const g = groupLabel(c.updated_at);
            const head = g !== lastGroup ? <div className="group" key={`g-${g}`}>{g}</div> : null;
            lastGroup = g;
            return (
              <div key={c.id}>
                {head}
                <button className={`convitem${c.id === current ? " active" : ""}`} onClick={() => openConv(c.id)}>
                  {c.title}
                </button>
              </div>
            );
          })}
        </div>
      </nav>

      <main className="main">
        <div className="mobilebar">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="menu">☰</button>
          <div className="title">{title}</div>
        </div>
        <div className="thread" ref={threadRef} onScroll={onScroll}>
          <div className="thread-inner">
            {msgs.length === 0 && <div className="newpulse">…</div>}
            {msgs.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="body">
                  {m.role === "assistant"
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || "▍"}</ReactMarkdown>
                    : m.content}
                </div>
              </div>
            ))}
          </div>
          {!stick && (
            <button className="scrollpill" onClick={() => { setStick(true); const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
              ↓ new message
            </button>
          )}
        </div>
        <div className="composerwrap">
          <div className="composer">
            <textarea ref={taRef} rows={1} placeholder="Message Jace…" value={draft}
              onChange={(e) => setDraft(e.target.value)} onInput={autogrow} onKeyDown={composerKey} />
            <button className="send" onClick={send} disabled={!draft.trim() || streaming} aria-label="send">↑</button>
          </div>
          <div className="hint">Jace remembers. Your conversations are private.</div>
        </div>
      </main>
    </div>
  );
}
