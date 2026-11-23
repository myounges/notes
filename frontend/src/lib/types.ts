export interface NoteLocation {
  lat: number;
  lon: number;
  name?: string | null;
}

export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  pinned: boolean;
  location?: NoteLocation | null;
  device?: string | null;
  word_count: number;
  auto_tag_hash?: string | null;
  auto_tagged_at?: string | null;
}

export interface Note extends NoteMeta {
  body: string;
  attachments: string[];
  note_size_bytes?: number;
}

export interface NoteListEntry extends NoteMeta {
  excerpt: string;
}

export interface AttachStatus {
  note_id: string;
  filename: string;
  extracted_text: string | null;
  source: string | null;
  processed_at: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  progress?: { phase: string; pct: number | null; error?: string } | null;
}

export interface SearchResult extends NoteMeta {
  snippet: string;
  matchedField: "title" | "body" | "tags" | "location" | "attachments";
  attachmentFilename: string | null;
  excerpt: string;
}

export interface Settings {
  enabled: boolean;
  model: "florence-2-base" | "florence-2-large" | "tesseract";
  schedule: string;
  whisper_model: "base" | "small" | "medium";
}

export interface VoiceTranscribeResult {
  queued: boolean;
  busy?: boolean;
  error?: string | null;
}

export interface VoiceProgress {
  phase: string;
  pct: number | null;
  error?: string;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  provider?: string;
  videoId?: string;
}

export type EditorMode = "source" | "split" | "live";

export interface ImportEntryResult {
  entry: string;
  action: "imported" | "skipped" | "error";
  reason?: string;
}

export interface ImportSummary {
  originalName: string;
  imported: number;
  skipped: number;
  errors: number;
  entries: ImportEntryResult[];
}

export interface BatchResult {
  ok: boolean;
  updated?: number;
  deleted?: number;
  missing: string[];
}