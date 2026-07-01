"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function Login() {
  const [email, setEmail] = useState("hi@kirbyamour.com");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const sb = supabaseBrowser();
    const { error } = mode === "signin"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password });
    if (error) { setErr(error.message); setBusy(false); return; }
    window.location.href = "/";
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Jace</h1>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="email" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
        <button disabled={busy}>{mode === "signin" ? "Sign in" : "Create account"}</button>
        <div className="err">{err}</div>
        <button type="button" style={{ background: "none", color: "var(--ink-soft)", fontSize: 13 }}
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "First time? Create the account" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
