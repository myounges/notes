import type { ImportSummary, LinkPreview, Note, NoteListEntry, SearchResult, Settings, AttachStatus, VoiceTranscribeResult, BatchResult } from "./types";

const API = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: init?.body instanceof FormData
      ? (init.headers ?? {})
      : init?.body != null
        ? { "Content-Type": "application/json", ...(init?.headers ?? {}) }
        : (init?.headers ?? {}),
  });
  if (res.status === 204) return undefined as T;
  let body: unknown;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const api = {
  login: (password: string) => request<{ ok: boolean }>("/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  session: () => request<{ authenticated: boolean }>("/auth/session"),

  listNotes: (params: { sort?: string; order?: string; limit?: number; offset?: number; tag?: string; pinned?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return request<{ notes: NoteListEntry[]; total: number; hasMore: boolean }>(`/notes?${qs}`);
  },
  getNote: (id: string) => request<Note>(`/notes/${encodeURIComponent(id)}`),
  createNote: (data: Partial<Note>) => request<Note>("/notes", { method: "POST", body: JSON.stringify(data) }),
  updateNote: (id: string, data: Partial<Note>) => request<Note>(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNote: (id: string) => request<{ ok: boolean }>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),

  batchTags: (ids: string[], add: string[] = [], remove: string[] = []) =>
    request<BatchResult>("/notes/batch/tags", { method: "POST", body: JSON.stringify({ ids, add, remove }) }),
  batchDelete: (ids: string[]) =>
    request<BatchResult>("/notes/batch/delete", { method: "POST", body: JSON.stringify({ ids }) }),

  listTrash: () => request<{ notes: NoteListEntry[] }>("/trash"),
  restoreTrashed: (id: string) => request<{ ok: boolean }>(`/trash/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  purgeTrashed: (id: string) => request<{ ok: boolean }>(`/trash/${encodeURIComponent(id)}`, { method: "DELETE" }),
  emptyTrash: () => request<{ ok: boolean; purged: number }>("/trash", { method: "DELETE" }),

  uploadAttachment: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ uploaded: { filename: string; bytes: number }[]; errors: string[] }>(
      `/notes/${encodeURIComponent(id)}/attachments`,
      { method: "POST", body: fd },
    );
  },
  deleteAttachment: (id: string, filename: string) =>
    request<{ ok: boolean }>(`/notes/${encodeURIComponent(id)}/attachments/${encodeURIComponent(filename)}`, { method: "DELETE" }),
  attachmentUrl: (id: string, filename: string) => `${API}/notes/${encodeURIComponent(id)}/attachments/${encodeURIComponent(filename)}`,

  search: (q: string, limit = 50) => request<{ q: string; results: SearchResult[]; total: number }>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  tags: () => request<{ tags: Array<{ name: string; count: number }> }>("/tags"),
  reindex: () => request<{ indexed: number; errors: number }>("/reindex", { method: "POST" }),

  settings: () => request<Settings>("/settings"),
  updateSettings: (s: Partial<Settings>) => request<Settings>("/settings", { method: "PUT", body: JSON.stringify(s) }),
  transcriptionStatus: () => request<{ counts: Record<string, number>; attachments: AttachStatus[] }>("/transcription/status"),
  runTranscription: () =>
    request<{ busy?: boolean; workerResponse: unknown }>("/transcription/run", { method: "POST" }),
  runAutotag: () =>
    request<{ checked: number; tagged: number; untagged: number; skipped: number; total: number; appliedTags: string[] }>(
      "/autotag/run",
      { method: "POST" },
    ),
  attachText: (noteId: string, filename: string) =>
    request<AttachStatus>(`/transcription/attachment/${encodeURIComponent(noteId)}/${encodeURIComponent(filename)}`),
  transcribeVoice: (noteId: string, filename: string) =>
    request<VoiceTranscribeResult>("/voice/transcribe", { method: "POST", body: JSON.stringify({ noteId, filename }) }),
  linkPreview: (url: string) =>
    request<LinkPreview>(`/linkpreview?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null),

  importZip: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<ImportSummary>("/import", { method: "POST", body: fd });
  },

  exportBackup: async () => {
    const res = await fetch(`${API}/export`, { credentials: "same-origin" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const disp = res.headers.get("Content-Disposition") ?? "";
    const m = disp.match(/filename="?([^";]+)"?/i);
    const filename = m?.[1] ?? `web-note-backup-${new Date().toISOString().slice(0, 10)}.jex`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Human label for a worker transcription phase. */
export function voicePhaseLabel(phase: string, pct: number | null): string {
  switch (phase) {
    case "loading":
      return "Loading speech model…";
    case "decoding":
      return "Reading audio file…";
    case "detecting":
      return "Detecting language…";
    case "transcribing":
      return pct != null ? `Transcribing… ${pct}%` : "Transcribing…";
    case "error":
      return "Transcription failed";
    default:
      return "Transcribing…";
  }
}

export interface PollVoiceOptions {
  onProgress?: (status: AttachStatus) => void;
  shouldStop?: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface PollVoiceResult {
  ok: boolean;
  done?: boolean;
  timedOut?: boolean;
  error?: string;
}

/** Poll a voice transcription until the worker row reaches a terminal state.
 *
 * The transcript is written into the note body by the worker when done; the
 * status row it streams into (question: which field?) tells us whether to keep
 * waiting. 404 responses (row not created yet) are treated as "still queued".
 */
export async function pollVoiceTranscription(
  noteId: string,
  filename: string,
  { onProgress, shouldStop, timeoutMs = 30 * 60 * 1000, intervalMs = 2000 }: PollVoiceOptions = {},
): Promise<PollVoiceResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shouldStop?.()) return { ok: false, error: "Stopped" };
    let status: AttachStatus | null = null;
    try {
      status = await api.attachText(noteId, filename);
    } catch {
      status = null;
    }
    if (status) {
      onProgress?.(status);
      if (status.status === "done") return { ok: true, done: true };
      if (status.status === "failed" || status.status === "skipped") {
        return {
          ok: false,
          error:
            status.progress?.error ??
            (status.status === "failed" ? "Voice transcription failed." : "Voice transcription skipped."),
        };
      }
      if (status.progress?.phase === "error") {
        return { ok: false, error: status.progress.error ?? "Voice transcription failed." };
      }
    }
    if (Date.now() >= deadline) return { ok: false, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Reverse-geocode via Nominatim (free, no key). Uses display_name; falls back to coords. */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
      { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error("geocode failed");
    const data = (await res.json()) as { display_name?: string };
    if (data.display_name) return data.display_name;
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}