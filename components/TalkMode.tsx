"use client";
// Talk Mode v2 — mobile-first. Phone: hold-to-talk, one persistent audio pipe,
// mic sleeps while he speaks (no self-interruption). Desktop: open conversation + barge-in.
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onUserText: (text: string, onDelta?: (full: string) => void) => Promise<string>;
  onClose: () => void;
};

type Phase = "idle" | "listening" | "thinking" | "speaking" | "recovering";

const isMobile = () => typeof navigator !== "undefined" &&
  (/iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints ?? 0) > 2);

export default function TalkMode({ onUserText, onClose }: Props) {
  const mobile = useRef(isMobile()).current;
  const [phase, setPhase] = useState<Phase>(mobile ? "idle" : "listening");
  const [liveText, setLiveText] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [voiceHint, setVoiceHint] = useState("");
  const [supported, setSupported] = useState(true);
  const [voices, setVoices] = useState<{ name: string; category?: string }[]>([]);
  const [voiceName, setVoiceName] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem("jace-voice") ?? "" : "");
  const recRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);   // ONE persistent element (iOS unlock)
  const closingRef = useRef(false);
  const bargeRef = useRef(false);
  const holdingRef = useRef(false);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  useEffect(() => {
    fetch("/api/tts").then((r) => r.json())
      .then((d) => setVoices((d.voices ?? []).map((v: { name: string; category?: string }) => ({ name: v.name, category: v.category }))))
      .catch(() => {});
    // Unlock the single audio element inside the opening tap's gesture window.
    const a = new Audio();
    a.setAttribute("playsinline", "true");
    a.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OACwl";
    a.play().catch(() => {});
    audioRef.current = a;
  }, []);

  const stopAudio = useCallback(() => {
    bargeRef.current = true;
    if (audioRef.current) { audioRef.current.pause(); }
  }, []);

  const fetchSentenceAudio = useCallback(async (sentence: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sentence, voiceName: localStorage.getItem("jace-voice") || undefined }),
      });
      if (!res.ok) { console.error("[talk] tts:", await res.text()); setVoiceHint("voice hiccup — words on screen"); return null; }
      setVoiceHint("");
      return URL.createObjectURL(await res.blob());
    } catch { return null; }
  }, []);

  const playUrl = useCallback((url: string) => new Promise<void>((resolve) => {
    const a = audioRef.current;
    if (!a || bargeRef.current) { URL.revokeObjectURL(url); resolve(); return; }
    a.src = url;
    a.onended = () => { URL.revokeObjectURL(url); resolve(); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    a.play().catch(() => { URL.revokeObjectURL(url); resolve(); });
  }), []);

  const stopRecognition = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* not running */ }
  }, []);

  const handleFinal = useCallback(async (text: string) => {
    if (!text.trim() || phaseRef.current === "thinking") return;
    stopAudio();
    stopRecognition();                 // mic sleeps while he thinks & speaks
    bargeRef.current = false;
    setPhase("thinking"); setLiveText(text); setLastReply("");

    let spokenChars = 0;
    const queue: string[] = [];
    let playing = false;
    const pump = async () => {
      if (playing) return;
      playing = true;
      while (queue.length > 0 && !bargeRef.current && !closingRef.current) {
        const sentence = queue.shift()!;
        const url = await fetchSentenceAudio(sentence);
        if (phaseRef.current !== "speaking" && !bargeRef.current && !closingRef.current) setPhase("speaking");
        if (url) await playUrl(url);
      }
      playing = false;
    };
    const onDelta = (full: string) => {
      setLastReply(full);
      const unspoken = full.slice(spokenChars);
      const m = unspoken.match(/^[\s\S]*?[.!?…](?=\s|$)/);
      if (m && m[0].trim().length > 1) { spokenChars += m[0].length; queue.push(m[0].trim()); pump(); }
    };

    try {
      const reply = await onUserText(text, onDelta);
      setLiveText("");
      const tail = reply.slice(spokenChars).trim();
      if (tail) { queue.push(tail); pump(); }
      while ((queue.length > 0 || playing) && !bargeRef.current && !closingRef.current) {
        await new Promise((r) => setTimeout(r, 150));
      }
      setLastReply(reply);
    } catch {
      setPhase("recovering");
      setLastReply("Looks like we lost each other for a second — I was following. Pick up wherever you want.");
      setTimeout(() => { if (!closingRef.current) setPhase(mobile ? "idle" : "listening"); }, 1500);
      return;
    }
    if (!closingRef.current) {
      setPhase(mobile ? "idle" : "listening");
      if (!mobile) startRecognition(); // desktop resumes open listening
    }
  }, [onUserText, fetchSentenceAudio, playUrl, stopAudio, stopRecognition, mobile]);

  const finalBufRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startRecognition = useCallback(() => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition;
    if (!SR) { setSupported(false); return; }
    try { recRef.current?.stop(); } catch { /* fresh start */ }
    const rec = new SR();
    recRef.current = rec;
    rec.continuous = !mobile;          // mobile: single-utterance mode is far more stable
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      if (!mobile && phaseRef.current === "speaking") { stopAudio(); setPhase("listening"); } // desktop barge-in
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalBufRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setLiveText((finalBufRef.current + " " + interim).trim());
      if (!mobile) {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          const text = finalBufRef.current.trim();
          finalBufRef.current = "";
          if (text) handleFinal(text);
        }, 900);
      }
    };
    rec.onend = () => {
      if (mobile) {
        // hold-to-talk: released or iOS cut it — send what we have
        const text = finalBufRef.current.trim();
        finalBufRef.current = "";
        if (holdingRef.current) holdingRef.current = false;
        if (text && !closingRef.current) handleFinal(text);
        else if (!closingRef.current && phaseRef.current === "listening") setPhase("idle");
      } else if (!closingRef.current && phaseRef.current === "listening") {
        try { rec.start(); } catch { /* busy */ }
      }
    };
    rec.onerror = () => { /* onend handles */ };
    try { rec.start(); } catch { /* already */ }
  }, [mobile, handleFinal, stopAudio]);

  useEffect(() => {
    if (!mobile) startRecognition();
    return () => { closingRef.current = true; try { recRef.current?.stop(); } catch {} };
  }, [mobile, startRecognition]);

  // Mobile hold-to-talk handlers
  function holdStart() {
    if (phaseRef.current === "thinking") return;
    stopAudio();                         // tapping to talk interrupts him
    bargeRef.current = true;
    holdingRef.current = true;
    finalBufRef.current = "";
    setLiveText(""); setPhase("listening");
    bargeRef.current = false;
    startRecognition();
  }
  function holdEnd() {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    stopRecognition();                   // onend fires -> sends the buffer
  }

  function close() {
    closingRef.current = true;
    stopAudio();
    try { recRef.current?.stop(); } catch {}
    onClose();
  }

  const hints: Record<Phase, string> = {
    idle: "hold the circle and talk", listening: mobile ? "listening — release to send" : "listening…",
    thinking: "…", speaking: mobile ? "tap and hold to interrupt" : "", recovering: "reconnecting…",
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
          <div aria-hidden
            onTouchStart={mobile ? holdStart : undefined}
            onTouchEnd={mobile ? holdEnd : undefined}
            onTouchCancel={mobile ? holdEnd : undefined}
            onMouseDown={mobile ? holdStart : undefined}
            onMouseUp={mobile ? holdEnd : undefined}
            style={{
              width: 150, height: 150, borderRadius: "50%",
              background: phase === "listening" ? "var(--accent, #c0392b)" : "var(--ink)",
              opacity: phase === "speaking" ? 0.9 : 0.8,
              transform: phase === "listening" ? "scale(1.08)" : phase === "thinking" ? "scale(.88)" : "scale(1)",
              transition: "all .4s ease", touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
              animation: phase === "speaking" ? "breathe 1.6s ease-in-out infinite" : "none",
              cursor: mobile ? "pointer" : "default",
            }} />
          <style>{`@keyframes breathe { 0%,100% { transform: scale(1);} 50% { transform: scale(1.08);} }`}</style>
          <div style={{ minHeight: 100, marginTop: 30, maxWidth: 560, textAlign: "center" }}>
            {liveText && <p style={{ color: "var(--ink)", fontSize: 17 }}>{liveText}</p>}
            {!liveText && lastReply && (
              <p style={{ color: phase === "speaking" ? "var(--ink)" : "var(--ink-soft)", fontSize: 15,
                maxHeight: 180, overflowY: "auto", transition: "color .4s" }}>{lastReply}</p>
            )}
            {voiceHint && <p style={{ color: "#c0392b", fontSize: 12 }}>{voiceHint}</p>}
            <p style={{ color: "var(--ink-soft)", fontSize: 14, fontWeight: 600 }}>{hints[phase]}</p>
          </div>
          <button onClick={close} aria-label="end conversation" style={{
            marginTop: 24, width: 52, height: 52, borderRadius: "50%",
            background: "#c0392b", color: "#fff", fontSize: 18 }}>✕</button>
          <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 12 }}>
            Still the same conversation — everything we say lands in the thread.
          </p>
          {voices.length > 0 && (
            <select value={voiceName}
              onChange={(e) => { setVoiceName(e.target.value); localStorage.setItem("jace-voice", e.target.value); }}
              style={{ marginTop: 10, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)",
                background: "var(--bg)", color: "var(--ink-soft)", fontSize: 13 }}>
              <option value="">Voice: automatic</option>
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
