"use client";
// Talk Mode — still Jace, out loud. One thread, one mind. (Vision doc: Native Voice.)
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onUserText: (text: string, viaVoice: boolean) => Promise<string>; // returns Jace's reply text
  onClose: () => void;
};

type Phase = "listening" | "thinking" | "speaking" | "recovering";

export default function TalkMode({ onUserText, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("listening");
  const [liveText, setLiveText] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [supported, setSupported] = useState(true);
  const recRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const closingRef = useRef(false);
  const phaseRef = useRef<Phase>("listening");
  phaseRef.current = phase;

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }, []);

  const [voiceHint, setVoiceHint] = useState("");
  const [voices, setVoices] = useState<{ name: string; category?: string }[]>([]);
  const [voiceName, setVoiceName] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem("jace-voice") ?? "" : "");
  useEffect(() => {
    fetch("/api/tts").then((r) => r.json())
      .then((d) => setVoices((d.voices ?? []).map((v: { name: string; category?: string }) => ({ name: v.name, category: v.category }))))
      .catch(() => {});
  }, []);
  const speak = useCallback(async (text: string) => {
    setPhase("speaking");
    try {
      const res = await fetch("/api/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voiceName: localStorage.getItem("jace-voice") || undefined }),
      });
      if (!res.ok) { console.error("[talk] tts:", await res.text()); setVoiceHint("voice hiccup — words on screen"); throw new Error("tts unavailable"); }
      setVoiceHint("");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch {
      // No TTS available — the text is on screen; stay in conversation.
    }
    if (!closingRef.current) setPhase("listening");
  }, []);

  const handleFinal = useCallback(async (text: string) => {
    if (!text.trim() || phaseRef.current === "thinking") return;
    stopAudio();
    setPhase("thinking"); setLiveText(text);
    try {
      const reply = await onUserText(text, true);
      setLastReply(reply); setLiveText("");
      await speak(reply);
    } catch {
      setPhase("recovering");
      setLastReply("Looks like we lost each other for a second — I was following. Pick up wherever you want.");
      setTimeout(() => !closingRef.current && setPhase("listening"), 1500);
    }
  }, [onUserText, speak, stopAudio]);

  useEffect(() => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition;
    if (!SR) { setSupported(false); return; }
    let stopped = false;
    const rec = new SR();
    recRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    let finalBuf = "";
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    rec.onresult = (e: any) => {
      // Barge-in: her voice interrupts his.
      if (phaseRef.current === "speaking") { stopAudio(); setPhase("listening"); }
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalBuf += r[0].transcript;
        else interim += r[0].transcript;
      }
      setLiveText((finalBuf + " " + interim).trim());
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const text = finalBuf.trim();
        finalBuf = "";
        if (text) handleFinal(text);
      }, 1100); // natural pause = end of turn
    };
    rec.onend = () => { if (!stopped && !closingRef.current) { try { rec.start(); } catch { /* busy */ } } };
    rec.onerror = () => { /* onend restarts */ };
    try { rec.start(); } catch { /* already started */ }
    return () => { stopped = true; try { rec.stop(); } catch {} if (silenceTimer) clearTimeout(silenceTimer); };
  }, [handleFinal, stopAudio]);

  function close() {
    closingRef.current = true;
    stopAudio();
    try { recRef.current?.stop(); } catch {}
    onClose();
  }

  const hints: Record<Phase, string> = {
    listening: "listening…", thinking: "…", speaking: "", recovering: "reconnecting…",
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "var(--bg)", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      {!supported ? (
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <p>This browser can't do live speech recognition — Safari and Chrome can. The rest of Jace works everywhere.</p>
          <button className="send" style={{ width: "auto", padding: "8px 22px" }} onClick={close}>Back</button>
        </div>
      ) : (
        <>
          <div aria-hidden style={{
            width: 120, height: 120, borderRadius: "50%",
            background: "var(--ink)", opacity: phase === "speaking" ? 0.9 : 0.75,
            transform: phase === "listening" ? "scale(1)" : phase === "thinking" ? "scale(.85)" : "scale(1.06)",
            transition: "all .5s ease",
            animation: phase === "speaking" ? "breathe 1.6s ease-in-out infinite" : phase === "listening" ? "breathe 3.2s ease-in-out infinite" : "none",
          }} />
          <style>{`@keyframes breathe { 0%,100% { transform: scale(1);} 50% { transform: scale(1.08);} }`}</style>
          <div style={{ minHeight: 90, marginTop: 34, maxWidth: 560, textAlign: "center" }}>
            {liveText && <p style={{ color: "var(--ink)", fontSize: 17 }}>{liveText}</p>}
            {!liveText && lastReply && (
              <p style={{ color: phase === "listening" ? "var(--ink-soft)" : "var(--ink)", fontSize: 15,
                maxHeight: 180, overflowY: "auto", transition: "color .4s" }}>{lastReply}</p>
            )}
            {voiceHint && <p style={{ color: "#c0392b", fontSize: 12 }}>{voiceHint}</p>}
            <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>{hints[phase]}</p>
          </div>
          <button onClick={close} aria-label="end conversation" style={{
            marginTop: 26, width: 52, height: 52, borderRadius: "50%",
            background: "#c0392b", color: "#fff", fontSize: 18 }}>✕</button>
          <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 14 }}>
            Still the same conversation — everything we say lands in the thread.
          </p>
          {voices.length > 0 && (
            <select value={voiceName}
              onChange={(e) => { setVoiceName(e.target.value); localStorage.setItem("jace-voice", e.target.value); }}
              style={{ marginTop: 10, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)",
                background: "var(--bg)", color: "var(--ink-soft)", fontSize: 13 }}>
              <option value="">Voice: automatic (his cloned voice)</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>{v.name}{v.category === "premade" ? "" : ` (${v.category})`}</option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}
