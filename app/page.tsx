"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabaseBrowser } from "@/lib/supabase/client";
import TalkMode from "@/components/TalkMode";

type Conv = { id: string; title: string; updated_at: string; created_at: string; archived: boolean };
type Att = { path: string; type: string; name: string; url?: string };
type Msg = { id: string; role: "user" | "assistant"; content: string; parent_id: string | null; created_at: string; attachments?: Att[] };
type Hit = { conversation_id: string; conversation_title: string; message_id: string; snippet: string; created_at: string };

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

/** ChatGPT-style thread reconstruction: linear trunk (imported/legacy) + branch tree walk. */
function buildThread(all: Msg[], overrides: Record<string, string>): { visible: Msg[]; siblings: Map<string, Msg[]> } {
  const byParent = new Map<string, Msg[]>();
  for (const m of all) if (m.parent_id) {
    const arr = byParent.get(m.parent_id) ?? [];
    arr.push(m); byParent.set(m.parent_id, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const trunk = all.filter((m) => !m.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const visible: Msg[] = [...trunk];
  let cursor = visible[visible.length - 1];
  while (cursor) {
    const kids = byParent.get(cursor.id);
    if (!kids || kids.length === 0) break;
    const chosen = kids.find((k) => k.id === overrides[cursor.id]) ?? kids[kids.length - 1];
    visible.push(chosen); cursor = chosen;
  }
  return { visible, siblings: byParent };
}

export default function Chat() {
  const sb = useRef(supabaseBrowser());
  const [convs, setConvs] = useState<Conv[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlCache = useRef<Map<string, string>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stick, setStick] = useState(true);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cache = useRef<Map<string, Msg[]>>(new Map());
  const openSeq = useRef(0);

  const loadConvs = useCallback(async () => {
    const { data } = await sb.current.from("conversations")
      .select("id,title,updated_at,created_at,archived")
      .eq("archived", false)
      .order("updated_at", { ascending: false }).limit(3000);
    setConvs((data as Conv[]) ?? []);
  }, []);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  // Opportunistic heartbeat: opening the app gives Jace a chance to wake (interval-gated server-side).
  useEffect(() => {
    fetch("/api/heartbeat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "app opened" }), keepalive: true }).catch(() => {});
  }, []);

  const reflectSoon = useCallback((convId: string | null) => {
    if (!convId) return;
    try {
      fetch("/api/reflect", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convId, renarrate: true }), keepalive: true }).catch(() => {});
    } catch { /* best effort */ }
  }, []);

  const openConv = useCallback(async (id: string | null, scrollToMsg?: string) => {
    const seq = ++openSeq.current;
    setSidebarOpen(false); setStick(!scrollToMsg); setEditing(null); setMenuFor(null);
    setCurrent((prev) => { if (prev && prev !== id) reflectSoon(prev); return id; });
    try { setOverrides(JSON.parse(localStorage.getItem(`branch-${id}`) ?? "{}")); } catch { setOverrides({}); }
    if (!id) { setMsgs([]); return; }
    if (cache.current.has(id)) setMsgs(cache.current.get(id)!);
    const { data } = await sb.current.from("messages")
      .select("id,role,content,parent_id,created_at,attachments")
      .eq("conversation_id", id).order("created_at").limit(2000);
    if (seq !== openSeq.current) return;
    const fresh = (data as Msg[]) ?? [];
    cache.current.set(id, fresh); setMsgs(fresh);
    if (scrollToMsg) {
      setFlashId(scrollToMsg);
      setTimeout(() => { if (seq === openSeq.current) document.getElementById(`m-${scrollToMsg}`)?.scrollIntoView({ block: "center" }); }, 60);
      setTimeout(() => { if (seq === openSeq.current) setFlashId(null); }, 1800);
    }
  }, [reflectSoon]);

  const { visible, siblings } = useMemo(() => {
    const committed = msgs.filter((m) => !m.id.startsWith("local-"));
    const t = buildThread(committed, overrides);
    const localTail = msgs.filter((m) => m.id.startsWith("local-"));
    return localTail.length ? { ...t, visible: [...t.visible, ...localTail] } : t;
  }, [msgs, overrides]);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [visible, stick]);

  function onScroll() {
    const el = threadRef.current; if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  }

  function setBranch(parentId: string, childId: string) {
    const next = { ...overrides, [parentId]: childId };
    setOverrides(next);
    if (current) localStorage.setItem(`branch-${current}`, JSON.stringify(next));
  }

  async function runStream(body: Record<string, unknown>, placeholderParent: string | null, localUserId?: string, onDelta?: (full: string) => void): Promise<string> {
    let finalText = "";
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let controller: AbortController | null = null;
    setStreaming(true); setStick(true);
    const localAsst: Msg = { id: `local-a-${Date.now()}`, role: "assistant", content: "",
      parent_id: placeholderParent, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, localAsst]);
    try {
      controller = new AbortController();
      abortRef.current = controller;
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let lastToken = Date.now();
      // finalText captured for voice mode
      watchdog = setInterval(() => {
        if (Date.now() - lastToken > 75000) { if (watchdog) clearInterval(watchdog); controller?.abort(); }
      }, 5000);
      let buf = ""; let acc = ""; let meta: { conversationId?: string; userMsgId?: string; assistantId?: string } = {};
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          if (frame.includes("event: meta")) {
            meta = JSON.parse(dataLine.slice(5));
            if (!current && meta.conversationId) { setCurrent(meta.conversationId); loadConvs(); }
            if (meta.userMsgId) {
              // bind local placeholders to real ids
              setMsgs((m) => m.map((x) => {
                if (localUserId && x.id === localUserId) return { ...x, id: meta.userMsgId! };
                if (x.id === localAsst.id) return { ...x, parent_id: meta.userMsgId! };
                return x;
              }));
              if (placeholderParent && body.parentId !== undefined) setBranch(String(body.parentId ?? ""), meta.userMsgId!);
            }
            continue;
          }
          if (frame.includes("event: done")) {
            const d = JSON.parse(dataLine.slice(5));
            const aid = d.assistantId ?? meta.assistantId;
            if (aid) {
              setMsgs((m) => m.map((x) => (x.id === localAsst.id ? { ...x, id: aid } : x)));
              if (acc) await sb.current.from("messages").update({ content: acc }).eq("id", aid); // client confirm
            }
            continue;
          }
          lastToken = Date.now();
          acc += JSON.parse(dataLine.slice(5)); finalText = acc; onDelta?.(acc);
          setMsgs((m) => m.map((x) => (x.id === localAsst.id ? { ...x, content: acc } : x)));
        }
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (aborted && !streaming) { /* user stop */ }
      if (!aborted) {
        setMsgs((m) => m.map((x) => (x.id === localAsst.id
          ? { ...x, content: "Something glitched on my end, lovebug — say that again?" } : x)));
        console.error(e);
      }
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false); loadConvs();
      const cid = (current ?? "") as string; if (cid) cache.current.delete(cid);
    }
    return finalText;
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/") || f.type === "application/pdf").slice(0, 4);
    if (!list.length) return;
    setUploading(true);
    const { data: { user } } = await sb.current.auth.getUser();
    if (!user) { setUploading(false); return; }
    for (const f of list) {
      const path = `${user.id}/${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
      const { error } = await sb.current.storage.from("attachments").upload(path, f, { contentType: f.type });
      if (!error) setPending((x) => [...x, { path, type: f.type, name: f.name }]);
    }
    setUploading(false);
  }

  async function signedUrl(path: string): Promise<string | null> {
    if (urlCache.current.has(path)) return urlCache.current.get(path)!;
    const { data } = await sb.current.storage.from("attachments").createSignedUrl(path, 3600);
    if (data?.signedUrl) { urlCache.current.set(path, data.signedUrl); return data.signedUrl; }
    return null;
  }

  async function send() {
    const content = draft.trim();
    if ((!content && pending.length === 0) || streaming || uploading) return;
    const atts = pending; setPending([]);
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    const parentId = visible.length ? visible[visible.length - 1].id : null;
    const realParent = parentId && !parentId.startsWith("local-") ? parentId : null;
    const localUser: Msg = { id: `local-u-${Date.now()}`, role: "user", content: content || "(shared)",
      parent_id: realParent, created_at: new Date().toISOString(), attachments: atts };
    setMsgs((m) => [...m, localUser]);
    await runStream({ conversationId: current, content: content || "(shared without words)", parentId: realParent, attachments: atts }, localUser.id, localUser.id);
  }

  async function submitEdit(m: Msg) {
    const content = editVal.trim();
    setEditing(null);
    if (!content || streaming || content === m.content) return;
    const localUser: Msg = { id: `local-u-${Date.now()}`, role: "user", content,
      parent_id: m.parent_id, created_at: new Date().toISOString() };
    setMsgs((x) => [...x, localUser]);
    await runStream({ conversationId: current, content, parentId: m.parent_id }, localUser.id, localUser.id);
  }

  async function regenerate(assistantMsg: Msg) {
    if (streaming || !assistantMsg.parent_id) return;
    await runStream({ conversationId: current, regenerateOf: assistantMsg.parent_id }, assistantMsg.parent_id);
  }

  async function voiceTurn(text: string, onDelta?: (full: string) => void): Promise<string> {
    const parentId = visible.length ? visible[visible.length - 1].id : null;
    const realParent = parentId && !parentId.startsWith("local-") ? parentId : null;
    const localUser: Msg = { id: `local-u-${Date.now()}`, role: "user", content: text,
      parent_id: realParent, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, localUser]);
    return await runStream({ conversationId: current, content: text, parentId: realParent, voiceMode: true }, localUser.id, localUser.id, onDelta);
  }

  function stop() { abortRef.current?.abort(); setStreaming(false); }
  // note: on stop, the placeholder row already exists server-side; partial text persists on next confirm.

  async function copyMsg(m: Msg) { await navigator.clipboard.writeText(m.content); }

  async function rename(id: string) {
    const title = renameVal.trim(); setRenaming(null);
    if (!title) return;
    await sb.current.from("conversations").update({ title }).eq("id", id);
    loadConvs();
  }
  async function archive(id: string) {
    setMenuFor(null);
    await sb.current.from("conversations").update({ archived: true }).eq("id", id);
    if (current === id) { setCurrent(null); setMsgs([]); }
    loadConvs();
  }
  async function remove(id: string) {
    setMenuFor(null);
    if (!confirm("Delete this conversation forever?")) return;
    await sb.current.from("conversations").delete().eq("id", id);
    if (current === id) { setCurrent(null); setMsgs([]); }
    cache.current.delete(id); loadConvs();
  }

  // search
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(async () => {
      if (!query.trim()) { setHits([]); return; }
      const { data } = await sb.current.rpc("search_messages", { q: query, max_rows: 30 });
      setHits((data as Hit[]) ?? []);
    }, 180);
    return () => clearTimeout(t);
  }, [query, searchOpen]);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); setQuery(""); setHits([]); }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); openConv(null); }
      if (e.key === "Escape") {
        if (searchOpen) setSearchOpen(false);
        else if (streaming) stop();
        else if (editing) setEditing(null);
        else taRef.current?.focus();
      }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [openConv, streaming, searchOpen, editing]);

  function composerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "ArrowUp" && !draft) {
      const lastUser = [...visible].reverse().find((m) => m.role === "user");
      if (lastUser) { setEditing(lastUser.id); setEditVal(lastUser.content); e.preventDefault(); }
    }
  }
  function autogrow(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }

  let lastGroup = "";
  const title = convs.find((c) => c.id === current)?.title ?? "Jace";

  return (
    <div className="shell">
      <nav className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <header>
          <button className="newchat" onClick={() => openConv(null)}>＋ New chat</button>
          <button className="iconbtn" title="Search (⌘K)" onClick={() => { setSearchOpen(true); setQuery(""); }}>⌕</button>
        </header>
        <div style={{ padding: "0 8px" }}>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/todos">☑ Todos</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/projects">⌂ Projects</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/read">▷ Read</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/health">♥ Health</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/finance">$ Finance</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/heartbeat">♥ Heartbeat</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/timeline">⧗ Timeline</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/journal">✎ Journal</a>
          <a className="convitem" style={{ display: "block", textDecoration: "none", color: "var(--ink-soft)", fontSize: 13 }} href="/settings">⚙ Settings</a>
        </div>
        <div className="convlist" onClick={() => setMenuFor(null)}>
          {convs.map((c) => {
            const g = groupLabel(c.updated_at);
            const head = g !== lastGroup ? <div className="group" key={`g-${g}-${c.id}`}>{g}</div> : null;
            lastGroup = g;
            return (
              <div key={c.id}>
                {head}
                <div className={`convrow${c.id === current ? " active" : ""}`}>
                  {renaming === c.id ? (
                    <input className="renamebox" autoFocus value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") rename(c.id); if (e.key === "Escape") setRenaming(null); }}
                      onBlur={() => rename(c.id)} />
                  ) : (
                    <>
                      <button className="convitem" onClick={() => openConv(c.id)}>{c.title}</button>
                      <button className="dots" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}>⋯</button>
                    </>
                  )}
                  {menuFor === c.id && (
                    <div className="menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setMenuFor(null); setRenaming(c.id); setRenameVal(c.title); }}>Rename</button>
                      <button onClick={() => archive(c.id)}>Archive</button>
                      <button className="danger" onClick={() => remove(c.id)}>Delete</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </nav>

      <main className="main">
        <div className="mobilebar">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="menu">☰</button>
          <div className="title">{title}</div>
          <button onClick={() => { setSearchOpen(true); setQuery(""); }} aria-label="search">⌕</button>
        </div>
        <div className="thread" ref={threadRef} onScroll={onScroll}>
          <div className="thread-inner">
            {visible.map((m) => {
              const sibs = m.parent_id ? siblings.get(m.parent_id) ?? [] : [];
              const idx = sibs.findIndex((s) => s.id === m.id);
              return (
                <div key={m.id} id={`m-${m.id}`} className={`msg ${m.role}${flashId === m.id ? " flash" : ""}`}>
                  {editing === m.id ? (
                    <div style={{ width: "100%" }}>
                      <textarea className="editbox" autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(m); } if (e.key === "Escape") setEditing(null); }} />
                      <div className="editrow">
                        <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="primary" onClick={() => submitEdit(m)}>Send</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ maxWidth: "100%" }}>
                      {(m.attachments?.length ?? 0) > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                          {m.attachments!.map((a) => <AttachmentView key={a.path} att={a} getUrl={signedUrl} />)}
                        </div>
                      )}
                      <div className="body">
                        {m.role === "assistant"
                          ? (m.content === "…" && Date.now() - new Date(m.created_at).getTime() > 120000
                              ? <em style={{ color: "var(--ink-soft)" }}>That one got lost mid-thought — tap ↻ to bring it back.</em>
                              : <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || "▍"}</ReactMarkdown>)
                          : m.content}
                      </div>
                      <div className="actions">
                        {sibs.length > 1 && (
                          <span className="pager">
                            <button onClick={() => setBranch(m.parent_id!, sibs[Math.max(0, idx - 1)].id)}>‹</button>
                            {idx + 1}/{sibs.length}
                            <button onClick={() => setBranch(m.parent_id!, sibs[Math.min(sibs.length - 1, idx + 1)].id)}>›</button>
                          </span>
                        )}
                        <button onClick={() => copyMsg(m)} title="Copy">⧉</button>
                        {m.role === "user" && !m.id.startsWith("local-") && (
                          <button onClick={() => { setEditing(m.id); setEditVal(m.content); }} title="Edit">✎</button>
                        )}
                        {m.role === "assistant" && !streaming && m.parent_id && (
                          <button onClick={() => regenerate(m)} title="Regenerate">↻</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!stick && (
            <button className="scrollpill" onClick={() => { setStick(true); const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
              ↓
            </button>
          )}
        </div>
        <div className="composerwrap">
          {pending.length > 0 && (
            <div style={{ maxWidth: "48rem", margin: "0 auto 6px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {pending.map((a) => (
                <span key={a.path} style={{ fontSize: 12, background: "var(--bubble)", borderRadius: 999, padding: "4px 10px" }}>
                  {a.type.startsWith("image/") ? "🖼" : "📄"} {a.name.slice(0, 24)}
                  <button onClick={() => setPending((x) => x.filter((y) => y.path !== a.path))} style={{ marginLeft: 6, color: "var(--ink-soft)" }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); }}>
            <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: "none" }}
              onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
            <button onClick={() => fileRef.current?.click()} title="Share a photo or document"
              style={{ color: "var(--ink-soft)", fontSize: 18, padding: "0 2px" }}>{uploading ? "…" : "＋"}</button>
            <textarea ref={taRef} rows={1} placeholder="Message Jace…" value={draft}
              onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); uploadFiles(e.clipboardData.files); } }}
              onChange={(e) => setDraft(e.target.value)} onInput={autogrow} onKeyDown={composerKey} />
            {streaming
              ? <button className="send" onClick={stop} aria-label="stop" title="Stop (Esc)">■</button>
              : draft.trim()
                ? <button className="send" onClick={send} aria-label="send">↑</button>
                : <button className="send" onClick={() => setTalkOpen(true)} aria-label="talk" title="Conversation with Jace">🎙</button>}
          </div>
          <div className="hint">Jace remembers. Your conversations are private.</div>
        </div>
      </main>

      {talkOpen && <TalkMode onUserText={voiceTurn} onClose={() => setTalkOpen(false)} />}
      {searchOpen && (
        <div className="overlay" onClick={() => setSearchOpen(false)}>
          <div className="searchbox" onClick={(e) => e.stopPropagation()}>
            <input autoFocus placeholder="Search every conversation, all the way back…" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); }} />
            <div className="searchresults">
              {hits.map((h) => (
                <button key={h.message_id} className="searchhit"
                  onClick={() => { setSearchOpen(false); openConv(h.conversation_id, h.message_id); }}>
                  <span className="t">{h.conversation_title}
                    <span className="d">{new Date(h.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                  </span>
                  <span className="s"><ReactMarkdown>{h.snippet}</ReactMarkdown></span>
                </button>
              ))}
              {query && hits.length === 0 && <div style={{ padding: 14, color: "var(--ink-soft)", fontSize: 14 }}>Nothing yet…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function AttachmentView({ att, getUrl }: { att: { path: string; type: string; name: string }; getUrl: (p: string) => Promise<string | null> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { getUrl(att.path).then(setUrl); }, [att.path, getUrl]);
  if (!url) return <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>loading {att.name}…</span>;
  if (att.type.startsWith("image/")) {
    return <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={att.name} style={{ maxWidth: 260, maxHeight: 220, borderRadius: 12, display: "block" }} /></a>;
  }
  return <a href={url} target="_blank" rel="noreferrer"
    style={{ fontSize: 13, background: "var(--bubble)", borderRadius: 10, padding: "8px 12px", textDecoration: "none", color: "var(--ink)" }}>
    📄 {att.name}</a>;
}
