"use client";
// PWA glue: service worker, install prompt, push opt-in.
import { useEffect, useState } from "react";

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const VAPID_PUBLIC = "BKnH4ghav4QpBQ0qw0mk5qYQvWO7osfBUa_fTBNUMQCrVROfXROqMuyqEpN2w5r_7mJXX-QGYTXq4rrZbpW_EMQ";

function b64ToU8(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enablePush(): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "This browser doesn't support notifications.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications were declined.";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
  const r = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub }) });
  return r.ok ? "Jace can reach you here now." : "Couldn't save the subscription.";
}

export default function PWA() {
  const [installEvt, setInstallEvt] = useState<BIPEvent | null>(null);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const onBIP = (e: Event) => { e.preventDefault(); setInstallEvt(e as BIPEvent); };
    window.addEventListener("beforeinstallprompt", onBIP);
    return () => window.removeEventListener("beforeinstallprompt", onBIP);
  }, []);
  if (!installEvt) return null;
  return (
    <button onClick={async () => { await installEvt.prompt(); setInstallEvt(null); }}
      style={{ position: "fixed", bottom: 14, left: 14, zIndex: 70, padding: "8px 14px", borderRadius: 20,
        border: "1px solid var(--line)", background: "var(--pill-bg)", color: "var(--ink)", fontSize: 13,
        cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.12)" }}>
      ⤓ Install Jace
    </button>
  );
}
