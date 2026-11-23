import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, pollVoiceTranscription, voicePhaseLabel } from "../lib/api";
import type { AttachStatus, VoiceProgress } from "../lib/types";

interface Props {
  noteId: string;
  attachments: string[];
  onChanged: () => void;
  onInsert: (text: string) => void;
  onTranscribed?: () => void;
  refreshTick?: number;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const VIDEO_RE = /\.(mp4|mov)$/i;
const AUDIO_RE = /\.(webm|ogg|mp3|m4a|wav)$/i;
const PDF_RE = /\.pdf$/i;

export default function AttachmentsPanel({ noteId, attachments, onChanged, onInsert, onTranscribed, refreshTick }: Props) {
  const [statuses, setStatuses] = useState<Record<string, AttachStatus>>({});
  const [transcribingName, setTranscribingName] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, VoiceProgress>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatuses = useCallback(async () => {
    const map: Record<string, AttachStatus> = {};
    for (const f of attachments) {
      try {
        map[f] = await api.attachText(noteId, f);
      } catch {
        // no record (pending implied or none)
      }
    }
    setStatuses(map);
  }, [noteId, attachments]);

  useEffect(() => {
    void loadStatuses();
    const t = setInterval(() => {
      if (attachments.length && attachments.some((f) => statuses[f]?.status === "pending")) {
        void loadStatuses();
      }
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments.length, refreshTick]);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files as File[])) {
        try {
          await api.uploadAttachment(noteId, file);
          onChanged();
          if (IMAGE_RE.test(file.name)) onInsert(`![${file.name}](attachments/${encodeURIComponent(file.name)})\n`);
          else if (AUDIO_RE.test(file.name)) onInsert(`[${file.name}](attachments/${encodeURIComponent(file.name)})\n`);
          else if (VIDEO_RE.test(file.name)) onInsert(`[${file.name}](attachments/${encodeURIComponent(file.name)})\n`);
          else if (PDF_RE.test(file.name)) onInsert(`[${file.name}](attachments/${encodeURIComponent(file.name)})\n`);
          else onInsert(`[${file.name}](attachments/${encodeURIComponent(file.name)})\n`);
        } catch (err) {
          alert(err instanceof Error ? err.message : "Upload failed");
        }
      }
    },
    [noteId, onChanged, onInsert],
  );

  const remove = useCallback(
    async (filename: string) => {
      if (!confirm(`Remove ${filename}?`)) return;
      try {
        await api.deleteAttachment(noteId, filename);
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [noteId, onChanged],
  );

  const transcribe = useCallback(
    async (filename: string) => {
      if (transcribingName) return;
      setTranscribingName(filename);
      setProgress((p) => ({ ...p, [filename]: { phase: "queued", pct: null } }));
      try {
        const res = await api.transcribeVoice(noteId, filename);
        if (res.busy) {
          setProgress((p) => ({ ...p, [filename]: { phase: "error", pct: null, error: "A voice transcription is already running — try again in a moment." } }));
          return;
        }
        const result = await pollVoiceTranscription(noteId, filename, {
          onProgress: (status) => {
            if (status.progress?.phase) setProgress((p) => ({ ...p, [filename]: status.progress as VoiceProgress }));
          },
          shouldStop: () => !mountedRef.current,
        });
        setProgress((p) => {
          const next = { ...p };
          delete next[filename];
          return next;
        });
        if (result.done) {
          void loadStatuses();
          onTranscribed?.();
        } else if (result.error) {
          setProgress((p) => ({ ...p, [filename]: { phase: "error", pct: null, error: result.error } }));
          void loadStatuses();
        }
      } catch (err) {
        setProgress((p) => {
          const next = { ...p };
          delete next[filename];
          return next;
        });
        alert(err instanceof Error ? err.message : "Voice transcription failed.");
      } finally {
        setTranscribingName(null);
      }
    },
    [transcribingName, noteId, loadStatuses, onTranscribed],
  );

  const sorted = useMemo(() => [...attachments].sort(), [attachments]);

  return (
    <div className="attachments-panel">
      <div className="attachments-header">
        <h3>Attachments</h3>
        <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
          +
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {sorted.length === 0 ? (
        <div className="attachments-empty">Drag files onto the editor or click + to attach.</div>
      ) : (
        <ul className="attachment-list">
          {sorted.map((name) => {
            const status = statuses[name];
            return (
              <li key={name} className="attachment-item">
                <span className="attachment-icon" aria-hidden="true">
                  {IMAGE_RE.test(name) ? "🖼" : AUDIO_RE.test(name) ? "🎙" : VIDEO_RE.test(name) ? "🎞" : PDF_RE.test(name) ? "📄" : "📎"}
                </span>
                <a
                  className="attachment-name"
                  href={api.attachmentUrl(noteId, name)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {name}
                </a>
                {status && (
                  <span className={`attach-status status-${status.status}`} title={status.extracted_text ?? undefined}>
                    {status.status === "done" ? "✔ extracted" : status.status === "running" ? "… transcribing" : status.status === "pending" ? "… pending" : status.status === "failed" ? "✕ failed" : "skipped"}
                  </span>
                )}
                {AUDIO_RE.test(name) && (
                  <button
                    className="btn btn-secondary btn-sm attach-transcribe"
                    aria-label={`Transcribe ${name}`}
                    onClick={() => void transcribe(name)}
                    disabled={transcribingName !== null}
                  >
                    {transcribingName === name ? "…" : "Transcribe"}
                  </button>
                )}
                {transcribingName === name && progress[name]?.phase && (
                  <span className="voice-progress voice-progress-inline">
                    <span className="voice-progress-track">
                      <span
                        className="voice-progress-fill"
                        style={{ width: `${progress[name]?.pct != null ? Math.min(100, progress[name].pct ?? 0) : 8}%` }}
                        data-indeterminate={progress[name]?.pct == null ? "true" : undefined}
                      />
                    </span>
                    <span className="voice-progress-label">
                      {progress[name]?.phase === "error"
                        ? (progress[name]?.error ?? "Transcription failed")
                        : voicePhaseLabel(progress[name]?.phase ?? "queued", progress[name]?.pct ?? null)}
                    </span>
                  </span>
                )}
                <button className="attachment-delete" aria-label={`Remove ${name}`} onClick={() => void remove(name)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}