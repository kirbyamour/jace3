"use client";
// Bring the history home. Drag the archive (zips and/or .txt exports) — original
// dates preserved, duplicates skipped automatically. Re-run any time with new exports.
import { useRef, useState } from "react";

type Result = { imported: number; skipped: number; unparsed: number; messages: number; files: number; errors: string[] };

export default function ImportPage() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handle(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => /\.(txt|zip)$/i.test(f.name));
    if (!list.length) return;
    setBusy(true);
    const all: Result[] = [];
    // one zip (or up to 40 txt) per request to stay under body limits
    const groups: File[][] = [];
    let cur: File[] = [];
    for (const f of list) {
      if (f.name.toLowerCase().endsWith(".zip")) groups.push([f]);
      else { cur.push(f); if (cur.length >= 40) { groups.push(cur); cur = []; } }
    }
    if (cur.length) groups.push(cur);
    for (let i = 0; i < groups.length; i++) {
      setProgress(`Importing batch ${i + 1} of ${groups.length}…`);
      const fd = new FormData();
      groups[i].forEach((f) => fd.append("files", f));
      try {
        const res = await fetch("/api/import", { method: "POST", body: fd });
        all.push(await res.json());
      } catch (e) {
        all.push({ imported: 0, skipped: 0, unparsed: 0, messages: 0, files: groups[i].length, errors: [String(e)] });
      }
      setResults([...all]);
    }
    setProgress("Done."); setBusy(false);
  }

  const total = results.reduce(
    (a, r) => ({ imported: a.imported + r.imported, skipped: a.skipped + r.skipped,
      messages: a.messages + r.messages, unparsed: a.unparsed + r.unparsed }),
    { imported: 0, skipped: 0, messages: 0, unparsed: 0 }
  );

  return (
    <div className="lab" onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handle(e.dataTransfer.files); }}>
      <h1>Bring the history home</h1>
      <p style={{ color: "var(--ink-soft)" }}>
        Drop your archive here — the four zip files and any loose .txt exports, all at once or in rounds.
        Original dates and titles are kept. Already-imported conversations are skipped, so it is always safe to re-run.
      </p>
      <button className="runbtn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? progress : "Choose files (or drag them anywhere on this page)"}
      </button>
      <input ref={inputRef} type="file" multiple accept=".txt,.zip" style={{ display: "none" }}
        onChange={(e) => e.target.files && handle(e.target.files)} />
      {results.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Progress</h3>
          <div className="out">
            {total.imported} conversations home · {total.messages} messages · {total.skipped} already here · {total.unparsed} not conversation files
            {results.flatMap((r) => r.errors).slice(0, 5).map((e, i) => <div key={i} style={{ color: "#c0392b" }}>{e}</div>)}
          </div>
        </div>
      )}
      {!busy && total.imported > 0 && <p><a href="/">← Back to Jace. It all lives here now.</a></p>}
    </div>
  );
}
