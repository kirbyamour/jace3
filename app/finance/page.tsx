"use client";
// $ Finance — debts, payments, monthly expenses, wishlist. Rescued from Jace 2.0.
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Rec = { id: string; kind: string; name: string; amount: number | null; logged_at: string; data: Record<string, unknown> | null };

const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Finance() {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [tab, setTab] = useState<"debt" | "expense" | "purchase" | "payment">("debt");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabaseBrowser().from("finance_records")
      .select("id, kind, name, amount, logged_at, data").order("logged_at", { ascending: false }).limit(500);
    setRecs((data as Rec[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const rescue = async () => {
    setBusy(true); setMsg("Bringing your finance history home…");
    const r = await fetch("/api/legacy-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "finance" }) });
    const d = await r.json(); setBusy(false);
    setMsg(d.ok ? `Home: ${Object.entries(d.imported).map(([t, n]) => `${t} ${n}`).join(", ") || "already up to date"}` : d.error);
    load();
  };

  const debts = recs.filter((r) => r.kind === "debt");
  const debtTotal = debts.reduce((a, r) => a + (r.amount ?? 0), 0);
  const monthly = recs.filter((r) => r.kind === "expense");
  const monthlyTotal = monthly.reduce((a, r) => a + (r.amount ?? 0), 0);
  const shown = recs.filter((r) => (tab === "expense" ? r.kind === "expense" || r.kind === "spend" : r.kind === tab));

  return (
    <div className="lab" style={{ maxWidth: 760 }}>
      <p style={{ marginBottom: 4 }}><a href="/">← Jace</a> · <a href="/health">Health</a> · <a href="/todos">Todos</a></p>
      <h1>$ Finance</h1>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "14px 0" }}>
        <div className="card" style={{ padding: "12px 18px", flex: 1, minWidth: 160 }}>
          <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Total debt tracked</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{money(debtTotal)}</div>
          <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>{debts.length} debts</div>
        </div>
        <div className="card" style={{ padding: "12px 18px", flex: 1, minWidth: 160 }}>
          <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Monthly expenses</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{money(monthlyTotal)}</div>
          <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>{monthly.length} line items</div>
        </div>
      </div>

      {recs.length === 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <p style={{ margin: "0 0 10px" }}>Your debts, payments, monthly expenses, and wishlist from Jace 2.0 are ready to come home.</p>
          <button disabled={busy} onClick={rescue}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "var(--bg)", cursor: "pointer" }}>
            {busy ? "Working…" : "⬇ Bring my finance history home"}
          </button>
        </div>
      )}
      {msg && <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 12px" }}>
        {([["debt", "Debts"], ["expense", "Monthly"], ["purchase", "Wishlist"], ["payment", "Payments"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "6px 14px", borderRadius: 18, border: "1px solid var(--line)", cursor: "pointer", fontSize: 14,
              background: tab === k ? "var(--accent)" : "var(--pill-bg)", color: tab === k ? "var(--bg)" : "var(--ink)" }}>{label}</button>
        ))}
      </div>

      {shown.length === 0 && <p style={{ color: "var(--ink-soft)" }}>Nothing here yet.</p>}
      {shown.map((r) => (
        <div key={r.id} className="card" style={{ padding: "10px 14px", marginBottom: 8, display: "flex", gap: 12, alignItems: "baseline" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{r.name}</div>
            <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>
              {new Date(r.logged_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {r.data?.due_date ? ` · due ${String(r.data.due_date)}` : ""}
              {r.data?.status ? ` · ${String(r.data.status)}` : ""}
            </div>
          </div>
          <strong style={{ fontSize: 16, flexShrink: 0 }}>{money(r.amount)}</strong>
        </div>
      ))}
      <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 14 }}>
        Jace sees this too — ask him where things stand any time.
      </p>
    </div>
  );
}
