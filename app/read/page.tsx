"use client";
// ▷ Read — the listening library (M4.6). Speechify in spirit:
// drop in a study or a link, hit play, walk away. Paragraph-streamed audio
// with prefetch, speed control, resume, folders, clinical clean-up.
import { useCallback, useEffect, useRef, useState } from "react";

type Folder = { id: string; name: string; emoji: string | null };
type Item = {
  id: string; folder_id: string | null; title: string; author: string | null; source_kind: string;
  source_url: string | null; status: string; clean_mode: string | null;
  progress_seconds: number; duration_seconds: number | null; notes: string | null;
  added_at: string; has_text: boolean; has_file: boolean; words: number; cover_url: string | null;
};

type SpeechVoice = { id: string; name: string; gender: string; tags: string[] };

declare global { interface Window { pdfjsLib?: { GlobalWorkerOptions: { workerSrc: string }; getDocument: (o: { url: string }) => { promise: Promise<{ getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> } }> }> } }; } }

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
function loadPdfJs(): Promise<NonNullable<Window["pdfjsLib"]> | null> {
  return new Promise((resolve) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const sc = document.createElement("script");
    sc.src = PDFJS;
    sc.onload = () => { if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib ?? null); };
    sc.onerror = () => resolve(null);
    document.head.appendChild(sc);
  });
}

const fmtMin = (s?: number | null) => {
  if (!s) return "";
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min listen` : `${m} min listen`;
};

export default function ReadPage() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | "all" | "done">("all");
  const [busy, setBusy] = useState<string | null>(null); // itemId being prepared
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");

  // ---- player state ----
  const [playing, setPlaying] = useState<Item | null>(null);
  const [paras, setParas] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [showText, setShowText] = useState(true);
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [voice, setVoice] = useState<string>("");
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<string, string>>(new Map()); // `${id}:${i}` -> objectURL
  const sessionRef = useRef(0);

  const load = useCallback(async () => {
    const r = await fetch("/api/read");
    if (r.ok) { const d = await r.json(); setFolders(d.folders); setItems(d.items); }
  }, []);
  const api = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch("/api/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { // reader voice options (Speechify) + remembered choice
    setVoice(localStorage.getItem("reader_voice") ?? "");
    fetch("/api/read/audio").then((r) => r.json()).then((d) => { if (d.ok && d.voices?.length) { setVoices(d.voices); if (!localStorage.getItem("reader_voice") && d.active) setVoice(d.active); } }).catch(() => {});
  }, []);
  const fixingRef = useRef(false);
  useEffect(() => { // real titles: rename filename-looking entries from their content (runs quietly, a few at a time)
    const suspects = items.some((i) => /\.(pdf|docx?|txt|epub)$/i.test(i.title) || (/[_-]/.test(i.title) && !/\s/.test(i.title)));
    if (!suspects || fixingRef.current) return;
    fixingRef.current = true;
    (async () => {
      for (let pass = 0; pass < 4; pass++) {
        const d = await api({ action: "fix_titles" });
        if (!d.ok || !d.fixed) break;
        await load();
        if (!d.more) break;
      }
      fixingRef.current = false;
    })();
  }, [items, api, load]);
  const coveringRef = useRef(false);
  useEffect(() => { // covers: render page 1 of PDFs in the browser, cache in storage
    const need = items.filter((i) => !i.cover_url && i.has_file).slice(0, 5);
    if (!need.length || coveringRef.current) return;
    coveringRef.current = true;
    (async () => {
      const pdfjs = await loadPdfJs();
      if (!pdfjs) { coveringRef.current = false; return; }
      for (const it of need) {
        try {
          const u = await api({ action: "file_url", id: it.id });
          if (!u.ok) continue;
          const doc = await pdfjs.getDocument({ url: u.url }).promise;
          const page = await doc.getPage(1);
          const vp0 = page.getViewport({ scale: 1 });
          const scale = 220 / vp0.width;
          const vp = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const b64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
          await api({ action: "set_cover", id: it.id, base64: b64 });
        } catch { /* cover is a nicety; never block the library */ }
      }
      coveringRef.current = false;
      load();
    })();
  }, [items, api, load]);


  // ---- audio pipeline: fetch paragraph i (with cache), returns object URL ----
  const fetchChunk = useCallback(async (itemId: string, i: number): Promise<string | null> => {
    const key = `${itemId}:${voice}:${i}`;
    const hit = cacheRef.current.get(key);
    if (hit) return hit;
    const r = await fetch("/api/read/audio", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, index: i, voice: voice || undefined }),
    });
    if (!r.ok) return null;
    const urlObj = URL.createObjectURL(await r.blob());
    cacheRef.current.set(key, urlObj);
    return urlObj;
  }, [voice]);

  const playFrom = useCallback(async (item: Item, startIdx: number, paraList: string[]) => {
    const session = ++sessionRef.current;
    // Lock-screen / control-center presence on the phone
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title, artist: "Jace reads", album: "Read & Listen",
        artwork: item.cover_url ? [{ src: item.cover_url, sizes: "220x290", type: "image/jpeg" }] : [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
      navigator.mediaSession.setActionHandler("play", () => { audioRef.current?.play(); setPaused(false); });
      navigator.mediaSession.setActionHandler("pause", () => { audioRef.current?.pause(); setPaused(true); });
      navigator.mediaSession.setActionHandler("previoustrack", () => playFrom(item, Math.max(0, (sessionRef.current, startIdx) - 1), paraList));
      navigator.mediaSession.setActionHandler("nexttrack", () => playFrom(item, Math.min(paraList.length - 1, startIdx + 1), paraList));
    }
    let a = audioRef.current;
    if (!a) { a = new Audio(); a.setAttribute("playsinline", "true"); audioRef.current = a; }
    a.playbackRate = rate;
    for (let i = startIdx; i < paraList.length; i++) {
      if (sessionRef.current !== session) return;
      setIdx(i);
      const src = await fetchChunk(item.id, i);
      if (sessionRef.current !== session) return;
      if (!src) { setError("Audio failed on paragraph " + (i + 1)); return; }
      fetchChunk(item.id, i + 1); // prefetch next while this one plays
      a.src = src; a.playbackRate = rate;
      try { await a.play(); } catch { return; } // interrupted
      await new Promise<void>((resolve) => {
        const done = () => { a!.removeEventListener("ended", done); resolve(); };
        a!.addEventListener("ended", done);
        const guard = setInterval(() => {
          if (sessionRef.current !== session) { clearInterval(guard); a!.removeEventListener("ended", done); resolve(); }
        }, 200);
        a!.addEventListener("ended", () => clearInterval(guard), { once: true });
      });
      if (sessionRef.current !== session) return;
      // persist resume point (paragraph granularity)
      api({ action: "update", id: item.id, progress_seconds: i + 1, status: "listening" });
    }
    if (sessionRef.current === session) {
      api({ action: "update", id: item.id, status: "done", progress_seconds: 0 });
      setPlaying(null); load();
    }
  }, [rate, fetchChunk, api, load]);

  const startListening = useCallback(async (item: Item, fromStart = false) => {
    setError(null);
    sessionRef.current++; audioRef.current?.pause();
    let d = await api({ action: "get_text", id: item.id });
    if (!d.ok || !d.paragraphs?.length) {
      // not prepared yet — clean it first (clinical if it smells like a study)
      setBusy(item.id);
      const prep = await api({ action: "prepare", id: item.id, mode: item.clean_mode ?? "standard" });
      setBusy(null);
      if (!prep.ok) { setError(prep.error ?? "couldn't prepare"); return; }
      d = await api({ action: "get_text", id: item.id });
      if (!d.ok) { setError("couldn't load text"); return; }
    }
    const list: string[] = d.paragraphs;
    setParas(list); setPlaying(item); setPaused(false);
    const resumeAt = fromStart ? 0 : Math.min(Math.floor(item.progress_seconds ?? 0), list.length - 1);
    playFrom(item, resumeAt, list);
  }, [api, playFrom]);

  const prepare = useCallback(async (item: Item, mode: "standard" | "clinical") => {
    setBusy(item.id); setError(null);
    const r = await api({ action: "prepare", id: item.id, mode });
    setBusy(null);
    if (!r.ok) setError(r.error ?? "clean-up failed");
    // invalidate cached audio for this item
    for (const k of Array.from(cacheRef.current.keys())) if (k.startsWith(item.id)) cacheRef.current.delete(k);
    load();
  }, [api, load]);

  const stop = useCallback(() => {
    sessionRef.current++; audioRef.current?.pause(); setPlaying(null); load();
  }, [load]);
  const togglePause = useCallback(() => {
    const a = audioRef.current; if (!a) return;
    if (a.paused) { a.play(); setPaused(false); } else { a.pause(); setPaused(true); }
  }, []);
  const skip = useCallback((delta: number) => {
    if (!playing) return;
    const target = Math.max(0, Math.min(paras.length - 1, idx + delta));
    playFrom(playing, target, paras);
  }, [playing, paras, idx, playFrom]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    if (playing && showText) paraRefs.current[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [idx, playing, showText]);

  // ---- add flows ----
  const addUrl = useCallback(async () => {
    if (!url.trim()) return;
    setBusy("add"); setError(null);
    const r = await api({ action: "add_url", url: url.trim(), folderId: activeFolder !== "all" && activeFolder !== "done" ? activeFolder : null });
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "couldn't add"); return; }
    setUrl(""); setAddOpen(false); load();
  }, [url, api, load, activeFolder]);

  const addFile = useCallback(async (f: File) => {
    setBusy("add"); setError(null);
    const b64 = btoa(new Uint8Array(await f.arrayBuffer()).reduce((s, b) => s + String.fromCharCode(b), ""));
    const r = await api({ action: "add_pdf", base64: b64, title: f.name.replace(/\.pdf$/i, ""), folderId: activeFolder !== "all" && activeFolder !== "done" ? activeFolder : null });
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "upload failed"); return; }
    setAddOpen(false); load();
  }, [api, load, activeFolder]);

  const visible = items.filter((i) =>
    activeFolder === "all" ? i.status !== "done"
    : activeFolder === "done" ? i.status === "done"
    : i.folder_id === activeFolder && i.status !== "done");

  return (
    <div className="lab" style={{ maxWidth: 860, paddingBottom: playing ? 210 : 40 }}>
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/todos">Todos</a> · <a href="/projects">Projects</a></p>
      <h1>▷ Read</h1>
      <p style={{ color: "var(--ink-soft)", marginTop: 2 }}>Drop in anything — he'll make it listenable.</p>

      {/* folders */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0" }}>
        {(["all", "done"] as const).map((k) => (
          <button key={k} onClick={() => setActiveFolder(k)} className="pill"
            style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid var(--line)", cursor: "pointer",
              background: activeFolder === k ? "var(--accent)" : "var(--pill-bg)",
              color: activeFolder === k ? "var(--bg)" : "var(--ink)" }}>
            {k === "all" ? "To listen" : "✓ Finished"}
          </button>
        ))}
        {folders.map((f) => (
          <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button onClick={() => setActiveFolder(f.id)}
              style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid var(--line)", cursor: "pointer",
                background: activeFolder === f.id ? "var(--accent)" : "var(--pill-bg)",
                color: activeFolder === f.id ? "var(--bg)" : "var(--ink)" }}>
              {f.emoji ? f.emoji + " " : ""}{f.name}
            </button>
            {activeFolder === f.id && (
              <>
                <button title="Rename folder" onClick={async () => { const n = prompt("Rename folder", f.name); if (n?.trim()) { await api({ action: "folder_rename", id: f.id, name: n.trim() }); load(); } }}
                  style={{ border: "none", background: "none", color: "var(--ink-soft)", cursor: "pointer", fontSize: 13 }}>✎</button>
                <button title="Delete folder (keeps its documents)" onClick={async () => { if (confirm(`Delete folder "${f.name}"? Its documents stay in your library.`)) { await api({ action: "folder_delete", id: f.id }); setActiveFolder("all"); load(); } }}
                  style={{ border: "none", background: "none", color: "var(--ink-soft)", cursor: "pointer", fontSize: 13 }}>✕</button>
              </>
            )}
          </span>
        ))}
        <button onClick={async () => { const n = prompt("Folder name"); if (n) { await api({ action: "folder_add", name: n }); load(); } }}
          style={{ padding: "6px 12px", borderRadius: 20, border: "1px dashed var(--line)", background: "none", color: "var(--ink-soft)", cursor: "pointer" }}>＋ folder</button>
      </div>

      {/* add */}
      <div className="card" style={{ padding: 14, marginBottom: 18 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f?.type === "application/pdf") addFile(f); }}>
        {!addOpen ? (
          <button onClick={() => setAddOpen(true)} style={{ background: "none", border: "none", color: "var(--ink)", fontSize: 15, cursor: "pointer" }}>
            ＋ Add something to listen to — a PDF, a link, or pasted text (or just drop a PDF here)
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a link to an article or PDF…"
                onKeyDown={(e) => e.key === "Enter" && addUrl()}
                style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--ink)", fontSize: 15 }} />
              <button onClick={addUrl} disabled={busy === "add"}
                style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>
                {busy === "add" ? "…" : "Add"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <label style={{ color: "var(--ink-soft)", fontSize: 14, cursor: "pointer" }}>
                or <u>choose a PDF</u>
                <input type="file" accept="application/pdf" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) addFile(f); }} />
              </label>
              <button onClick={() => setAddOpen(false)} style={{ background: "none", border: "none", color: "var(--ink-soft)", cursor: "pointer" }}>cancel</button>
            </div>
          </div>
        )}
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {/* one-time homecoming: pull the whole Jace 2.0 library over */}
      {items.length === 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 18 }}>
          <p style={{ margin: "0 0 10px" }}>Your Jace 2.0 reading library is ready to come home — folders, documents, clean-ups, and where you left off in each one.</p>
          <button disabled={busy === "migrate"}
            onClick={async () => {
              setBusy("migrate"); setError(null);
              const r = await fetch("/api/read/import", { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ exportUrl: "https://nwmakrswzpkwrgiitobl.supabase.co/functions/v1/export-library" }) });
              const d = await r.json(); setBusy(null);
              if (!d.ok) { setError(d.error ?? "import failed"); return; }
              setError(null); load();
              alert(`Home: ${d.items} items, ${d.folders} folders, ${d.files} files copied.` + (d.errors?.length ? ` (${d.errors.length} issues)` : ""));
            }}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>
            {busy === "migrate" ? "Bringing everything home… (a few minutes)" : "⬇ Bring my library home"}
          </button>
        </div>
      )}

      {/* follow-along transcript while listening */}
      {playing && showText && (
        <div style={{ margin: "6px 0 20px" }}>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>Tap any paragraph to jump there.</p>
          {paras.map((para, i) => (
            <p key={i} ref={(el) => { paraRefs.current[i] = el; }}
              onClick={() => { if (playing) playFrom(playing, i, paras); }}
              style={{ cursor: "pointer", lineHeight: 1.65, fontSize: 17, padding: "10px 14px", borderRadius: 12,
                background: i === idx ? "var(--bubble)" : "transparent",
                color: i === idx ? "var(--ink)" : i < idx ? "var(--ink-soft)" : "var(--ink)",
                opacity: i < idx ? 0.65 : 1, transition: "background .3s" }}>
              {para}
            </p>
          ))}
        </div>
      )}

      {/* items */}
      {!playing && visible.length === 0 && items.length > 0 && <p style={{ color: "var(--ink-soft)" }}>Nothing here yet.</p>}
      {(playing && showText ? [] : visible).map((it) => (
        <div key={it.id} className="card" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", marginBottom: 10 }}>
          {it.cover_url ? (
            <img src={it.cover_url} alt="" style={{ width: 46, height: 62, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)", flexShrink: 0 }} />
          ) : (
            <div style={{ width: 46, height: 62, borderRadius: 6, border: "1px solid var(--line)", background: "var(--bubble)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-soft)", fontSize: 20, flexShrink: 0 }}>
              {it.source_kind === "url" ? "🔗" : "📄"}
            </div>
          )}
          <button onClick={() => startListening(it)} disabled={busy === it.id}
            title={it.progress_seconds > 0 ? "Resume" : "Listen"}
            style={{ width: 44, height: 44, borderRadius: 22, border: "none", background: "var(--accent)", color: "var(--bg)", fontSize: 17, cursor: "pointer", flexShrink: 0 }}>
            {busy === it.id ? "…" : playing?.id === it.id ? "♪" : "▶"}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
            <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>
              {it.author ? `${it.author} · ` : ""}{fmtMin(it.duration_seconds) || it.source_kind.toUpperCase()}{it.words ? ` · ${it.words.toLocaleString()} words` : ""}
              {it.clean_mode ? ` · cleaned (${it.clean_mode})` : it.has_text ? " · raw text" : ""}
              {it.progress_seconds > 0 && it.status !== "done" ? " · in progress" : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
            <select value={it.folder_id ?? ""} title="Move to folder"
              onChange={async (e) => { await api({ action: "update", id: it.id, folder_id: e.target.value || null }); load(); }}
              style={{ padding: "6px 6px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", fontSize: 13, maxWidth: 110 }}>
              <option value="">No folder</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.emoji ? f.emoji + " " : ""}{f.name}</option>)}
            </select>
            <button onClick={async () => { const n = prompt("Rename", it.title); if (n?.trim()) { await api({ action: "update", id: it.id, title: n.trim() }); load(); } }}
              title="Rename" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer", fontSize: 13 }}>✎</button>
            <button onClick={() => prepare(it, "standard")} disabled={busy === it.id} title="Clean up for listening"
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer", fontSize: 13 }}>✨</button>
            <button onClick={() => prepare(it, "clinical")} disabled={busy === it.id} title="Clinical clean-up (studies: p-values, CIs spoken)"
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer", fontSize: 13 }}>🔬</button>
            <button onClick={async () => { if (confirm("Remove from library?")) { await api({ action: "delete", id: it.id }); load(); } }}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--danger)", cursor: "pointer", fontSize: 13 }}>✕</button>
          </div>
        </div>
      ))}

      {/* player bar */}
      {playing && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "var(--sidebar)", borderTop: "1px solid var(--line)", padding: "14px 18px calc(14px + env(safe-area-inset-bottom))", zIndex: 50 }}>
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{playing.title}</strong>
              <span style={{ color: "var(--ink-soft)", fontSize: 13, flexShrink: 0 }}>{idx + 1} / {paras.length}</span>
            </div>
            {!showText && (
              <div style={{ color: "var(--ink-soft)", fontSize: 13, margin: "6px 0 10px", maxHeight: 38, overflow: "hidden" }}>
                {paras[idx]?.slice(0, 140)}…
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => skip(-1)} style={{ width: 42, height: 42, borderRadius: 21, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer" }}>⏮</button>
              <button onClick={togglePause} style={{ width: 54, height: 54, borderRadius: 27, border: "none", background: "var(--accent)", color: "var(--bg)", fontSize: 20, cursor: "pointer" }}>{paused ? "▶" : "⏸"}</button>
              <button onClick={() => skip(1)} style={{ width: 42, height: 42, borderRadius: 21, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", cursor: "pointer" }}>⏭</button>
              <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <button key={r} onClick={() => setRate(r)}
                    style={{ padding: "6px 9px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                      border: "1px solid var(--line)",
                      background: rate === r ? "var(--accent)" : "var(--pill-bg)",
                      color: rate === r ? "var(--bg)" : "var(--ink)" }}>{r}×</button>
                ))}
              </div>
              {voices.length > 0 && (
                <select value={voice} title="Reading voice"
                  onChange={(e) => { setVoice(e.target.value); localStorage.setItem("reader_voice", e.target.value);
                    if (playing) { const cur = idx; const item = playing; const list = paras; setTimeout(() => playFrom(item, cur, list), 50); } }}
                  style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", fontSize: 13, maxWidth: 130 }}>
                  {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.gender ? ` (${v.gender[0]})` : ""}</option>)}
                </select>
              )}
              <button onClick={() => setShowText(!showText)} title="Follow along with the text"
                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", cursor: "pointer", fontSize: 13,
                  background: showText ? "var(--accent)" : "var(--pill-bg)", color: showText ? "var(--bg)" : "var(--ink)" }}>text</button>
              <button onClick={stop} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink-soft)", cursor: "pointer", fontSize: 13 }}>close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
