import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../lib/config.js";
import { listNoteIds, readNote, type Note } from "./notes.js";

let db: Database.Database | null = null;

function rawDb(): Database.Database {
  fs.mkdirSync(path.dirname(config.indexDbPath), { recursive: true });
  const d = new Database(config.indexDbPath);
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  return d;
}

function getDb(): Database.Database {
  if (!db) throw new Error("Search index not initialized");
  return db;
}

export function initIndex(): void {
  if (db) return;
  db = rawDb();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tags,
      location_name,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS attachment_text (
      note_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      extracted_text TEXT,
      source TEXT,
      processed_at TEXT,
      status TEXT DEFAULT 'pending',
      progress TEXT,
      PRIMARY KEY (note_id, filename)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_text_fts USING fts5(
      note_id UNINDEXED,
      filename UNINDEXED,
      extracted_text,
      content = 'attachment_text',
      content_rowid = 'rowid'
    );

    CREATE TRIGGER IF NOT EXISTS attachment_text_ai AFTER INSERT ON attachment_text BEGIN
      INSERT INTO attachment_text_fts(rowid, note_id, filename, extracted_text)
      VALUES (new.rowid, new.note_id, new.filename, new.extracted_text);
    END;

    CREATE TRIGGER IF NOT EXISTS attachment_text_ad AFTER DELETE ON attachment_text BEGIN
      INSERT INTO attachment_text_fts(attachment_text_fts, rowid, note_id, filename, extracted_text)
      VALUES ('delete', old.rowid, old.note_id, old.filename, old.extracted_text);
    END;

    CREATE TRIGGER IF NOT EXISTS attachment_text_au AFTER UPDATE ON attachment_text BEGIN
      INSERT INTO attachment_text_fts(attachment_text_fts, rowid, note_id, filename, extracted_text)
      VALUES ('delete', old.rowid, old.note_id, old.filename, old.extracted_text);
      INSERT INTO attachment_text_fts(rowid, note_id, filename, extracted_text)
      VALUES (new.rowid, new.note_id, new.filename, new.extracted_text);
    END;
  `);
  // Older databases created before the `progress` column existed need a
  // lightweight migration (voice transcription reports phase/% through it).
  const cols = db.prepare("PRAGMA table_info(attachment_text)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "progress")) {
    db.exec("ALTER TABLE attachment_text ADD COLUMN progress TEXT");
  }
}

export function closeIndex(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface SearchResult {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  pinned: boolean;
  location: Note["location"];
  snippet: string;
  matchedField: string;
  attachmentFilename?: string | null;
  excerpt: string;
}

function ftsQuery(q: string): { query: string; tokens: string[] } {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.trim().replace(/["*]/g, ""))
    .filter((t) => t.length > 0);
  // Quoted prefix phrases: special chars stay safely inside quotes (no FTS5
  // syntax injection), and the trailing * makes partial typing match —
  // "unti" finds both "untitled" and "untitledvoic".
  const parts = tokens.map((t) => `"${t}"*`);
  return { query: parts.join(" "), tokens };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[#>*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSnippet(row: Record<string, unknown>, attachment = false): string {
  if (attachment) return String(row.bodySnippet ?? "").trim();
  const body = String(row.bodySnippet ?? "").trim();
  if (body) return body;
  const title = String(row.titleSnippet ?? "").trim();
  if (title) return title;
  return String(row.tagsSnippet ?? "").trim();
}

/** Search across note body and attachment-extracted text. Deduped by note id. */
export async function searchNotes(
  q: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ results: SearchResult[]; total: number }> {
  const d = getDb();
  const { query, tokens } = ftsQuery(q);
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  if (!tokens.length) return { results: [], total: 0 };

  const found = new Map<string, string>(); // id -> snippet
  const attachmentHits = new Map<string, string>(); // id -> filename

  // 1. notes body/title/tags/location
  try {
    const noteRows = d
      .prepare(
        `SELECT id,
                snippet(notes_fts, 2, '<<', '>>', ' … ', 24) AS bodySnippet,
                snippet(notes_fts, 1, '<<', '>>', ' … ', 24) AS titleSnippet,
                snippet(notes_fts, 4, '<<', '>>', ' … ', 24) AS tagsSnippet,
                bm25(notes_fts) AS rank
         FROM notes_fts
         WHERE notes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit * 5) as Array<Record<string, unknown>>;
    for (const row of noteRows) {
      const id = row.id as string;
      if (!found.has(id)) found.set(id, extractSnippet(row));
    }
  } catch {
    // malformed query -> treat as no matches
  }

  // 2. extracted attachment text
  try {
    const attachRows = d
      .prepare(
        `SELECT a.note_id AS id, a.filename,
                snippet(attachment_text_fts, 2, '<<', '>>', ' … ', 24) AS bodySnippet,
                bm25(attachment_text_fts) AS rank
         FROM attachment_text_fts
         JOIN attachment_text a ON a.rowid = attachment_text_fts.rowid
         WHERE attachment_text_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit * 5) as Array<Record<string, unknown>>;
    for (const row of attachRows) {
      const id = row.id as string;
      if (!found.has(id)) {
        found.set(id, extractSnippet(row, true));
        attachmentHits.set(id, row.filename as string);
      }
    }
  } catch {
    // ignore
  }

  // 3. enrich with current note metadata; skip notes gone from disk
  const results: SearchResult[] = [];
  for (const [id, snippet] of found) {
    try {
      const note = await readNote(id);
      results.push({
        id,
        title: note.title,
        tags: note.tags,
        created: note.created,
        updated: note.updated,
        pinned: note.pinned,
        location: note.location,
        snippet: snippet.replace(/<</g, "").replace(/>>/g, ""),
        matchedField: attachmentHits.has(id)
          ? "attachments"
          : tokens.some((t) => note.title.toLowerCase().includes(t.toLowerCase()))
            ? "title"
            : "body",
        attachmentFilename: attachmentHits.get(id) ?? null,
        excerpt: stripMarkdown(note.body).slice(0, 260),
      });
    } catch {
      // note deleted on disk but still in FTS -> skip
    }
  }

  results.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updated.localeCompare(a.updated);
  });

  return { results: results.slice(offset, offset + limit), total: results.length };
}

export function indexNote(note: Note): void {
  const d = getDb();
  const locationName = note.location?.name ?? "";
  d.prepare(`DELETE FROM notes_fts WHERE id = ?`).run(note.id);
  d.prepare(
    `INSERT INTO notes_fts(id, title, body, tags, location_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(note.id, note.title, note.body, note.tags.join(" "), locationName);
}

export function unindexNote(id: string): void {
  const d = getDb();
  d.prepare(`DELETE FROM notes_fts WHERE id = ?`).run(id);
}

export async function reindexAll(): Promise<{ indexed: number; errors: number }> {
  const d = getDb();
  d.prepare(`DELETE FROM notes_fts`).run();
  const ids = await listNoteIds();
  let indexed = 0;
  let errors = 0;
  for (const id of ids) {
    try {
      indexNote(await readNote(id));
      indexed++;
    } catch {
      errors++;
    }
  }
  return { indexed, errors };
}

/** Progress payload written by the AI worker while a voice note is transcribed. */
export interface AttachmentProgress {
  phase: string;
  pct: number | null;
  error?: string;
}

export interface AttachmentTextStatus {
  note_id: string;
  filename: string;
  extracted_text: string | null;
  source: string | null;
  processed_at: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  progress: AttachmentProgress | null;
}

function parseProgress(col: unknown): AttachmentProgress | null {
  if (typeof col !== "string" || !col.trim()) return null;
  try {
    const parsed = JSON.parse(col) as AttachmentProgress;
    if (typeof parsed.phase !== "string" || !parsed.phase) return null;
    return { phase: parsed.phase, pct: typeof parsed.pct === "number" ? parsed.pct : null, error: parsed.error };
  } catch {
    return null;
  }
}

const ATTACH_TEXT_COLS =
  "note_id, filename, extracted_text, source, processed_at, status, progress";

export function upsertAttachmentText(
  noteId: string,
  filename: string,
  data: {
    extracted_text?: string | null;
    source?: string | null;
    processed_at?: string | null;
    status?: AttachmentTextStatus["status"];
  },
): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id, filename) DO UPDATE SET
       extracted_text = COALESCE(excluded.extracted_text, attachment_text.extracted_text),
       source = COALESCE(excluded.source, attachment_text.source),
       processed_at = COALESCE(excluded.processed_at, attachment_text.processed_at),
       status = excluded.status`,
  ).run(
    noteId,
    filename,
    data.extracted_text ?? null,
    data.source ?? null,
    data.processed_at ?? null,
    data.status ?? "pending",
  );
}

export function getAttachmentText(noteId: string, filename: string): AttachmentTextStatus | null {
  const d = getDb();
  const row = d
    .prepare(`SELECT ${ATTACH_TEXT_COLS} FROM attachment_text WHERE note_id = ? AND filename = ?`)
    .get(noteId, filename) as (AttachmentTextStatus & { progress: unknown }) | undefined;
  if (!row) return null;
  const { progress, ...rest } = row;
  return { ...rest, progress: parseProgress(progress) };
}

export function listAttachmentText(status?: AttachmentTextStatus["status"]): AttachmentTextStatus[] {
  const d = getDb();
  const rows = status
    ? d
        .prepare(`SELECT ${ATTACH_TEXT_COLS} FROM attachment_text WHERE status = ? ORDER BY processed_at DESC`)
        .all(status)
    : d
        .prepare(`SELECT ${ATTACH_TEXT_COLS} FROM attachment_text ORDER BY processed_at DESC`)
        .all();
  return (rows as Array<AttachmentTextStatus & { progress: unknown }>).map(({ progress, ...rest }) => ({
    ...rest,
    progress: parseProgress(progress),
  }));
}

export function attachmentStatusCounts(): Record<string, number> {
  const d = getDb();
  const rows = d
    .prepare(`SELECT status, COUNT(*) AS n FROM attachment_text GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const out: Record<string, number> = { pending: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function deleteAttachmentText(noteId: string, filename?: string): void {
  const d = getDb();
  if (filename) {
    d.prepare(`DELETE FROM attachment_text WHERE note_id = ? AND filename = ?`).run(noteId, filename);
  } else {
    d.prepare(`DELETE FROM attachment_text WHERE note_id = ?`).run(noteId);
  }
}