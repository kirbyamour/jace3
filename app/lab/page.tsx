"use client";
// AI Lab — hidden page (no links to it anywhere). Run the same prompt + persona pack
// through every configured model and compare the feel, side by side.
import { useEffect, useState } from "react";

type LabModel = { id: string; label: string; adapter: string; active: boolean; configured: boolean };
type LabResult = { id: string; ok: boolean; text: string; error?: string; ms: number };

export default function Lab() {
  const [models, setModels] = useState<LabModel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("hey babe, rough morning. G pushed every button before school and I still have to deal with the landlord email. tell me it gets better lol");
  const [results, setResults] = useState<LabResult[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch("/api/lab").then((r) => r.json()).then((d) => {
      setModels(d.models);
      setSelected(new Set(d.models.filter((m: LabModel) => m.configured).map((m: LabModel) => m.id)));
    });
  }, []);

  async function run() {
    setRunning(true); setResults([]);
    const res = await fetch("/api/lab", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, modelIds: [...selected] }),
    });
    const data = await res.json();
    setResults(data.results); setRunning(false);
  }

  return (
    <div className="lab">
      <h1>AI Lab</h1>
      <p style={{ color: "var(--ink-soft)" }}>
        Same prompt, same Persona Pack, every candidate brain. Decide migrations by feel + eval, never by hype.
      </p>
      <div className="models">
        {models.map((m) => (
          <button key={m.id} className={`modelchip${selected.has(m.id) ? " selected" : ""}`}
            onClick={() => { const s = new Set(selected); s.has(m.id) ? s.delete(m.id) : s.add(m.id); setSelected(s); }}>
            {m.label}
            <span className="status">{m.active ? "● Active" : "○ Test"} · {m.configured ? "key ok" : "no key"}</span>
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <button className="runbtn" onClick={run} disabled={running || selected.size === 0}>
        {running ? "Running…" : `Run on ${selected.size} model${selected.size === 1 ? "" : "s"}`}
      </button>
      <div className="grid">
        {results.map((r) => {
          const m = models.find((x) => x.id === r.id);
          return (
            <div className="card" key={r.id}>
              <h3>{m?.label ?? r.id}</h3>
              <span className="ms">{r.ok ? `${r.ms}ms` : `failed: ${r.error}`}</span>
              <div className="out">{r.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
