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
  const [voices, setVoices] = useState<{ id: string; name: string; category?: string }[]>([]);
  const [voiceName, setVoiceName] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem("jace-voice") ?? "" : "");
  const [avatar, setAvatar] = useState<string | null>(null);
  const recRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);   // ONE persistent element (iOS unlock)
  const closingRef = useRef(false);
  const bargeRef = useRef(false);
  const holdingRef = useRef(false);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  useEffect(() => {
    fetch("/api/tts").then((r) => r.json())
      .then((d) => {
        setVoices((d.voices ?? []).map((v: { id: string; name: string; category?: string }) => ({ id: v.id, name: v.name, category: v.category })));
        if (d.avatar) setAvatar(d.avatar);
        if (!localStorage.getItem("jace-voice") && d.active) { setVoiceName(String(d.active)); }
      })
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
        body: JSON.stringify((() => {
          const v = localStorage.getItem("jace-voice") || "";
          return v.startsWith("sp:") || /^[A-Za-z0-9]{16,}$/.test(v)
            ? { text: sentence, voiceId: v, remember: true }
            : { text: sentence, voiceName: v || undefined, remember: true };
        })()),
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
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex",
      background: "linear-gradient(180deg, #fdfefe 0%, #eef4fb 55%, #e3edf9 100%)",
      flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      {!supported ? (
        <div style={{ textAlign: "center", maxWidth: 420, color: "#2b3a4a" }}>
          <p>This browser can&apos;t do live speech recognition — Safari and Chrome can. The rest of Jace works everywhere.</p>
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
              width: 190, height: 190, borderRadius: "50%", position: "relative",
              background: avatar
                ? "radial-gradient(circle at 35% 30%, #cfe3ff 0%, #9cc3f7 60%, #7fb0f2 100%)"
                : "radial-gradient(circle at 35% 30%, #bcd9ff 0%, #7fb0f2 55%, #5b96e8 100%)",
              boxShadow: phase === "listening"
                ? "0 0 70px 24px rgba(101,157,235,.5), inset 0 0 40px rgba(255,255,255,.55)"
                : phase === "speaking"
                ? "0 0 90px 30px rgba(101,157,235,.6), inset 0 0 44px rgba(255,255,255,.6)"
                : "0 0 46px 14px rgba(101,157,235,.35), inset 0 0 36px rgba(255,255,255,.5)",
              transform: phase === "listening" ? "scale(1.06)" : phase === "thinking" ? "scale(.94)" : "scale(1)",
              transition: "all .45s ease", touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
              animation: phase === "speaking" ? "orbTalk 1.5s ease-in-out infinite"
                : phase === "thinking" ? "orbThink 2.6s ease-in-out infinite"
                : "orbBreathe 4s ease-in-out infinite",
              cursor: mobile ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
            }}>
            {avatar && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={avatar} alt="" draggable={false}
                style={{ width: "86%", height: "86%", objectFit: "cover", borderRadius: "50%",
                  opacity: 0.94, pointerEvents: "none" }} />
            )}
          </div>
          <style>{`
            @keyframes orbBreathe { 0%,100% { transform: scale(1);} 50% { transform: scale(1.035);} }
            @keyframes orbTalk { 0%,100% { transform: scale(1);} 30% { transform: scale(1.07);} 65% { transform: scale(1.02);} }
            @keyframes orbThink { 0%,100% { transform: scale(.94); opacity: 1;} 50% { transform: scale(.9); opacity: .85;} }
          `}</style>
          <div style={{ minHeight: 100, marginTop: 32, maxWidth: 560, textAlign: "center" }}>
            {liveText && <p style={{ color: "#20364e", fontSize: 17 }}>{liveText}</p>}
            {!liveText && lastReply && (
              <p style={{ color: phase === "speaking" ? "#20364e" : "#7d92a8", fontSize: 15,
                maxHeight: 180, overflowY: "auto", transition: "color .4s" }}>{lastReply}</p>
            )}
            {voiceHint && <p style={{ color: "#c0392b", fontSize: 12 }}>{voiceHint}</p>}
            <p style={{ color: "#8ba1b7", fontSize: 14, fontWeight: 600 }}>{hints[phase]}</p>
          </div>
          <button onClick={close} aria-label="end conversation" style={{
            marginTop: 24, width: 56, height: 56, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "#ff5f57", color: "#fff", fontSize: 18, boxShadow: "0 6px 18px rgba(255,95,87,.35)" }}>✕</button>
          <p style={{ color: "#9db1c5", fontSize: 12, marginTop: 12 }}>
            Still the same conversation — everything we say lands in the thread.
          </p>
          {voices.length > 0 && (
            <select value={voiceName}
              onChange={(e) => { setVoiceName(e.target.value); localStorage.setItem("jace-voice", e.target.value); }}
              style={{ marginTop: 10, padding: "6px 10px", borderRadius: 10, border: "1px solid #ccdcee",
                background: "#ffffffcc", color: "#4a6076", fontSize: 13, maxWidth: 240 }}>
              <option value="">Voice: automatic</option>
              {voices.map((v) => (
                <option key={v.id} value={v.category === "speechify" ? v.id : v.name}>
                  {v.name}{v.category && v.category !== "premade" && v.category !== "speechify" ? ` (${v.category})` : ""}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}
