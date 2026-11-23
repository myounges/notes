import { useCallback, useEffect, useRef, useState } from "react";
import { api, pollVoiceTranscription, voicePhaseLabel } from "../lib/api";

interface Props {
  noteId: string;
  onRecorded: (url: string, label: string) => void;
  onTranscribed?: () => void;
}

const MIME_CANDIDATES = ["audio/webm", "audio/mp4", "audio/ogg"];

function pickMime(): string | undefined {
  return MIME_CANDIDATES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}

function extForBlob(type: string): string {
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4")) return "m4a";
  return "webm";
}

export default function VoiceRecorder({ noteId, onRecorded, onTranscribed }: Props) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; pct: number | null } | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stop = useCallback(async () => {
    const recorder = mediaRef.current;
    const stream = streamRef.current;
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRef.current = null;
    streamRef.current = null;
    stream?.getTracks().forEach((t) => t.stop());
    if (!recorder) return;
    try {
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
        recorder.stop();
      });
      chunksRef.current = [];
      const ext = extForBlob(blob.type);
      const filename = `recording-${Date.now()}.${ext}`;
      setLastName(filename);
      setMessage(null);
      setBusy(true);
      try {
        await api.uploadAttachment(noteId, new File([blob], filename, { type: blob.type }));
        onRecorded(`attachments/${filename}`, filename);
      } finally {
        setBusy(false);
      }
    } catch {
      setError("Recording failed — try again.");
    }
  }, [noteId, onRecorded]);

  const start = useCallback(async () => {
    setError(null);
    setMessage(null);
    setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRef.current = recorder;
      recorder.start();
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access denied.");
    }
  }, []);

  const transcribe = useCallback(async () => {
    if (!lastName) return;
    setError(null);
    setMessage(null);
    setProgress({ phase: "queued", pct: null });
    try {
      const res = await api.transcribeVoice(noteId, lastName);
      if (res.busy) {
        setProgress(null);
        setError("A voice transcription is already running — try again in a moment.");
        return;
      }
      // 202 queued: keep polling until the worker row reaches a terminal state.
      const result = await pollVoiceTranscription(noteId, lastName, {
        onProgress: (status) => {
          const p = status.progress;
          if (p?.phase && p.phase !== "error") {
            setProgress({ phase: p.phase, pct: p.pct });
          }
        },
        shouldStop: () => !mountedRef.current,
      });
      setProgress(null);
      if (result.done) {
        setMessage("Voice note transcribed — added to the note.");
        onTranscribed?.();
      } else if (result.timedOut) {
        setError("Transcription is still running — it will appear in the note when done.");
      } else if (result.error && result.error !== "Stopped") {
        setError(result.error);
      }
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : "Voice transcription failed.");
    }
  }, [lastName, noteId, onTranscribed]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const fmt = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const transcribing = progress !== null;

  return (
    <div className="voice-control" data-recording={recording}>
      {recording ? (
        <>
          <span className="voice-timer" aria-live="polite">{fmt}</span>
          <button className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
            {busy ? "Saving…" : "Stop & save"}
          </button>
        </>
      ) : (
        <button className="btn btn-secondary" onClick={() => void start()} disabled={busy || transcribing}>
          {busy ? "Saving…" : "● Record voice"}
        </button>
      )}
      {!recording && lastName && (
        <button className="btn btn-secondary voice-transcribe" onClick={() => void transcribe()} disabled={transcribing || busy}>
          {transcribing ? "Transcribing…" : "▶ Transcribe voice"}
        </button>
      )}
      {transcribing && (
        <div className="voice-progress" role="status" aria-live="polite">
          <span className="voice-progress-label">{voicePhaseLabel(progress?.phase ?? "transcribing", progress?.pct ?? null)}</span>
          <span className="voice-progress-track">
            <span
              className="voice-progress-fill"
              style={{ width: `${progress?.pct != null ? Math.min(100, progress.pct) : 8}%` }}
              data-indeterminate={progress?.pct == null ? "true" : undefined}
            />
          </span>
        </div>
      )}
      {message && <span className="voice-message" role="status">{message}</span>}
      {error && <span className="voice-error">{error}</span>}
    </div>
  );
}