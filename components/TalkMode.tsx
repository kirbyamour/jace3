"use client";
// Conversation Mode v3 — one tap begins, one tap ends; everything between is
// conversation. Open mic with echo cancellation, energy VAD decides when a
// thought is finished (not a button), he listens WHILE speaking so you can
// cut him off mid-sentence. One engine on phone and desktop. The benchmark:
// an hour of driving without touching the phone.
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onUserText: (text: string, onDelta?: (full: string) => void) => Promise<string>;
  onClose: () => void;
};

type Phase = "starting" | "listening" | "thinking" | "speaking" | "recovering";

// --- VAD tuning ---
const TICK_MS = 50;
const CALIBRATE_MS = 700;          // noise-floor sampling at start
const MIN_SPEECH_MS = 280;         // shorter than this = noise, not a thought
const END_SILENCE_MS = 950;        // human pause tolerance before we call it done
const BARGE_SPEECH_MS = 380;       // sustained voice while he talks = interruption
const MAX_UTTER_MS = 45000;

export default function TalkMode({ onUserText, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [liveText, setLiveText] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [voiceHint, setVoiceHint] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [voices, setVoices] = useState<{ id: string; name: string; category?: string }[]>([]);
  const [voiceName, setVoiceName] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem("jace-voice") ?? "" : "");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [level, setLevel] = useState(0);              // live mic energy for the orb
  const [diag, setDiag] = useState("");               // tiny truth line: where the pipeline is

  const phaseRef = useRef<Phase>("starting");
  const setPh = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const closingRef = useRef(false);
  const bargeRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const noiseRef = useRef(0.008);
  const vadRef = useRef({ voicedMs: 0, silentMs: 0, recStart: 0, bargeMs: 0 });
  const pendingRef = useRef<string | null>(null);     // she spoke while he was thinking

  // ---- voices + avatar + unlocked audio element (created inside the opening tap) ----
  useEffect(() => {
    fetch("/api/tts").then((r) => r.json())
      .then((d) => {
        setVoices((d.voices ?? []).map((v: { id: string; name: string; category?: string }) => ({ id: v.id, name: v.name, category: v.category })));
        if (d.avatar) setAvatar(d.avatar);
        if (!localStorage.getItem("jace-voice") && d.active) setVoiceName(String(d.active));
      }).catch(() => {});
    const a = new Audio();
    a.setAttribute("playsinline", "true");
    a.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OACwl";
    a.play().catch(() => {});
    audioRef.current = a;
    return () => { closingRef.current = true; };
  }, []);

  const stopAudio = useCallback(() => {
    bargeRef.current = true;
    audioRef.current?.pause();
  }, []);

  const fetchSentenceAudio = useCallback(async (sentence: string): Promise<string | null> => {
    try {
      const v = localStorage.getItem("jace-voice") || "";
      const body = v.startsWith("sp:") || /^[A-Za-z0-9]{16,}$/.test(v)
        ? { text: sentence, voiceId: v } : { text: sentence, voiceName: v || undefined };
      const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { setVoiceHint("voice hiccup — words on screen"); return null; }
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

  // ---- recorder control (started by VAD onset, stopped at end-of-thought) ----
  const startRec = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || recRef.current?.state === "recording") return;
    chunksRef.current = [];
    try {
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.start();
      vadRef.current.recStart = Date.now();
      setDiag("● recording");
    } catch (e) {
      setVoiceHint("recorder failed: " + (e instanceof Error ? e.message : "unknown"));
    }
  }, []);

  const stopRec = useCallback((): Promise<Blob | null> => new Promise((resolve) => {
    const rec = recRef.current;
    if (!rec || rec.state !== "recording") { resolve(null); return; }
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      chunksRef.current = [];
      resolve(blob.size > 2000 ? blob : null);
    };
    rec.stop();
  }), []);

  // ---- his reply: stream + sentence-streamed speech, mic stays hot for barge-in ----
  const respond = useCallback(async (text: string) => {
    bargeRef.current = false;
    setPh("thinking"); setLiveText(text); setLastReply("");
    let spokenChars = 0;
    const queue: string[] = [];
    let playing = false;
    const pump = async () => {
      if (playing) return;
      playing = true;
      while (queue.length > 0 && !bargeRef.current && !closingRef.current) {
        const sentence = queue.shift()!;
        const url = await fetchSentenceAudio(sentence);
        if (!bargeRef.current && !closingRef.current && phaseRef.current !== "speaking") setPh("speaking");
        if (url && !bargeRef.current) await playUrl(url);
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
      if (tail && !bargeRef.current) { queue.push(tail); pump(); }
      while ((queue.length > 0 || playing) && !bargeRef.current && !closingRef.current) {
        await new Promise((r) => setTimeout(r, 120));
      }
      setLastReply(reply);
    } catch {
      setPh("recovering");
      setLastReply("Looks like we lost each other for a second — I was following. Pick up wherever you want.");
      setTimeout(() => { if (!closingRef.current) setPh("listening"); }, 1400);
      return;
    }
    if (!closingRef.current) {
      setPh("listening");
      // she spoke while I was answering — honor it immediately
      const held = pendingRef.current;
      pendingRef.current = null;
      if (held) respond(held);
    }
  }, [onUserText, fetchSentenceAudio, playUrl]);

  const handleUtterance = useCallback(async (blob: Blob) => {
    try {
      const wasSpeaking = phaseRef.current === "speaking" || phaseRef.current === "thinking";
      if (!wasSpeaking) { setPh("thinking"); setLiveText(""); }   // she gets instant feedback
      setDiag(`↑ heard ${(blob.size / 1024).toFixed(0)}kb, transcribing…`);
      const res = await fetch("/api/stt", { method: "POST", headers: { "content-type": blob.type }, body: blob });
      if (!res.ok) { setDiag(`stt error ${res.status}`); if (!wasSpeaking) setPh("listening"); return; }
      const { text } = await res.json();
      const t = String(text ?? "").trim();
      setDiag(t ? "" : "didn't catch that — say it again?");
      if (!t || t.length < 2) { if (phaseRef.current === "thinking" && !wasSpeaking) setPh("listening"); return; }
      if (phaseRef.current === "thinking" || phaseRef.current === "speaking") {
        // arrived mid-reply (interruption text or a queued follow-up)
        stopAudio();
        pendingRef.current = pendingRef.current ? pendingRef.current + " " + t : t;
        if (phaseRef.current === "speaking") { pendingRef.current = null; respond(t); }
        return;
      }
      respond(t);
    } catch { if (!closingRef.current) setPh("listening"); }
  }, [respond, stopAudio]);

  // ---- the ear: mic + analyser + VAD loop ----
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        await ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        analyserRef.current = analyser;

        // calibrate noise floor
        const buf = new Float32Array(analyser.fftSize);
        const rms = () => {
          analyser.getFloatTimeDomainData(buf);
          let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          return Math.sqrt(s / buf.length);
        };
        const samples: number[] = [];
        const calEnd = Date.now() + CALIBRATE_MS;
        while (Date.now() < calEnd) { samples.push(rms()); await new Promise((r) => setTimeout(r, 40)); }
        noiseRef.current = Math.max(0.004, samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0.008);
        if (!closingRef.current) setPh("listening");

        timer = setInterval(async () => {
          if (closingRef.current) return;
          const v = rms();
          setLevel(Math.min(1, v / (noiseRef.current * 12)));
          const talkThresh = Math.max(0.012, noiseRef.current * 3.2);
          const bargeThresh = Math.max(0.02, noiseRef.current * 5.5);
          const st = vadRef.current;
          const ph = phaseRef.current;

          if (ph === "speaking") {
            // he's talking — is she? (echo cancellation keeps his voice out of the mic)
            if (v > bargeThresh) st.bargeMs += TICK_MS; else st.bargeMs = Math.max(0, st.bargeMs - TICK_MS);
            if (st.bargeMs >= BARGE_SPEECH_MS) {
              st.bargeMs = 0;
              stopAudio();                       // he stops instantly
              setPh("listening");
              startRec();                        // and she already has the floor
              st.voicedMs = BARGE_SPEECH_MS; st.silentMs = 0;
            }
            return;
          }

          if (ph !== "listening" && ph !== "thinking") return;
          const voiced = v > talkThresh;
          if (voiced) { st.voicedMs += TICK_MS; st.silentMs = 0; }
          else if (v < talkThresh * 0.7) { st.silentMs += TICK_MS; }   // hysteresis: borderline noise doesn't reset the pause

          const recording = recRef.current?.state === "recording";
          if (!recording && voiced && st.voicedMs >= 100) startRec();
          if (recording) {
            const dur = Date.now() - st.recStart;
            if ((st.silentMs >= END_SILENCE_MS || dur > MAX_UTTER_MS)) {
              const hadSpeech = st.voicedMs >= MIN_SPEECH_MS;
              st.voicedMs = 0; st.silentMs = 0;
              const blob = await stopRec();
              if (blob && (hadSpeech || blob.size > 12000)) handleUtterance(blob);
              else setDiag("");
            }
          }
        }, TICK_MS);
      } catch {
        setMicError("I need the microphone for this — check the mic permission for this site and try again.");
      }
    })();
    return () => {
      cancelled = true; closingRef.current = true;
      if (timer) clearInterval(timer);
      try { recRef.current?.state === "recording" && recRef.current.stop(); } catch { /* closing */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      ctxRef.current?.close().catch(() => {});
    };
  }, [handleUtterance, startRec, stopRec, stopAudio]);

  const close = () => { closingRef.current = true; stopAudio(); onClose(); };

  const hints: Record<Phase, string> = {
    starting: "one sec — opening my ears",
    listening: "I'm listening — just talk",
    thinking: "…",
    speaking: "talk any time — I'll stop",
    recovering: "reconnecting…",
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex",
      background: "linear-gradient(180deg, #fdfefe 0%, #eef4fb 55%, #e3edf9 100%)",
      flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      {micError ? (
        <div style={{ textAlign: "center", maxWidth: 420, color: "#2b3a4a" }}>
          <p>{micError}</p>
          <button className="send" style={{ width: "auto", padding: "8px 22px" }} onClick={close}>Back</button>
        </div>
      ) : (
        <>
          <div aria-hidden
            onClick={() => { if (phaseRef.current === "speaking") { stopAudio(); setPh("listening"); } }}
            style={{
              width: 190, height: 190, borderRadius: "50%", position: "relative",
              background: avatar
                ? "radial-gradient(circle at 35% 30%, #cfe3ff 0%, #9cc3f7 60%, #7fb0f2 100%)"
                : "radial-gradient(circle at 35% 30%, #bcd9ff 0%, #7fb0f2 55%, #5b96e8 100%)",
              boxShadow: phase === "listening"
                ? `0 0 ${46 + level * 60}px ${14 + level * 24}px rgba(101,157,235,${0.35 + level * 0.3}), inset 0 0 40px rgba(255,255,255,.55)`
                : phase === "speaking"
                ? "0 0 90px 30px rgba(101,157,235,.6), inset 0 0 44px rgba(255,255,255,.6)"
                : "0 0 46px 14px rgba(101,157,235,.35), inset 0 0 36px rgba(255,255,255,.5)",
              transform: phase === "listening" ? `scale(${1 + level * 0.07})` : phase === "thinking" ? "scale(.94)" : "scale(1)",
              transition: "box-shadow .15s ease, transform .15s ease",
              animation: phase === "speaking" ? "orbTalk 1.5s ease-in-out infinite"
                : phase === "thinking" ? "orbThink 2.6s ease-in-out infinite"
                : phase === "starting" ? "orbBreathe 2s ease-in-out infinite" : "none",
              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
              userSelect: "none", WebkitUserSelect: "none", cursor: "pointer",
            }}>
            {avatar && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={avatar} alt="" draggable={false}
                style={{ width: "86%", height: "86%", objectFit: "cover", borderRadius: "50%", opacity: 0.94, pointerEvents: "none" }} />
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
            {diag && <p style={{ color: "#9db1c5", fontSize: 12 }}>{diag}</p>}
            <p style={{ color: "#8ba1b7", fontSize: 14, fontWeight: 600 }}>{hints[phase]}</p>
          </div>
          <button onClick={close} aria-label="end conversation" style={{
            marginTop: 24, width: 56, height: 56, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "#1c2733", color: "#fff", fontSize: 18, boxShadow: "0 6px 18px rgba(28,39,51,.3)" }}>✕</button>
          <p style={{ color: "#9db1c5", fontSize: 12, marginTop: 12 }}>
            One conversation, hands free — everything we say lands in the thread.
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
