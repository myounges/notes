import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import matter from "gray-matter";
import { config } from "../lib/config.js";

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
  /** sha256 of the content last sent to the auto-tag classifier (skip-if-unchanged). */
  auto_tag_hash?: string | null;
  /** ISO timestamp of the last auto-tag run over this note. */
  auto_tagged_at?: string | null;
}

export interface Note extends NoteMeta {
  body: string;
}

export interface NoteListEntry extends NoteMeta {
  /** First 260 chars of body, stripped of markdown syntax, for list previews. */
  excerpt: string;
}

export interface NoteInput {
  title?: string | null;
  tags?: string[] | null;
  body?: string | null;
  pinned?: boolean | null;
  location?: NoteLocation | null;
  device?: string | null;
  created?: string | null;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  sort?: "updated" | "created" | "title";
  order?: "asc" | "desc";
  tag?: string;
  pinned?: boolean;
}

const NOTE_FILE = "note.md";
const ATTACH_DIR = "attachments";

export function normalizeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "note";
}

/** Generate `<YYYY-MM-DD>-<slug>-<4hex>` id. */
export function generateNoteId(title: string, existingIds: Set<string> = new Set()): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  const hash = crypto.randomBytes(2).toString("hex");
  let id = `${ymd}-${normalizeSlug(title)}-${hash}`;
  while (existingIds.has(id)) {
    id = `${ymd}-${normalizeSlug(title)}-${crypto.randomBytes(2).toString("hex")}`;
  }
  return id;
}

export function computeWordCount(body: string): number {
  const text = body
    // strip code fences entirely
    .replace(/```[\s\S]*?```/g, " ")
    // strip inline code
    .replace(/`[^`]*`/g, " ")
    // strip images and links but keep link text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // strip markdown syntax markers
    .replace(/[#>*_~|`-]/g, " ");
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  return words.length;
}

export function noteDir(id: string): string {
  if (!/^[\w-]+$/.test(id) || id.includes("..")) {
    throw new Error(`Invalid note id: ${id}`);
  }
  return path.join(config.notesDir, id);
}

export function noteFilePath(id: string): string {
  return path.join(noteDir(id), NOTE_FILE);
}

export function attachmentDir(id: string): string {
  return path.join(noteDir(id), ATTACH_DIR);
}

export function attachmentPath(id: string, filename: string): string {
  return path.join(attachmentDir(id), filename);
}

export function trashNoteDir(id: string): string {
  if (!/^[\w-]+$/.test(id) || id.includes("..")) {
    throw new Error(`Invalid note id: ${id}`);
  }
  return path.join(config.trashDir, id);
}

export async function ensureDirs(): Promise<void> {
  await fsp.mkdir(config.notesDir, { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });
  await fsp.mkdir(config.configDir, { recursive: true });
  await fsp.mkdir(path.join(config.dataDir, "index"), { recursive: true });
}

function yamlString(value: string): string {
  if (value === "") return '""';
  if (/^[\w .,;:!?@#$%^&*()\[\]{}\-+/='"]*$/.test(value) && value === value.trim() && !/^[-?:,.[\]{}#&*!|>'"%@`]/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function serializeFrontmatter(meta: NoteMeta, body: string): string {
  const lines: string[] = [];
  lines.push(`id: ${yamlString(meta.id)}`);
  lines.push(`title: ${yamlString(meta.title ?? "")}`);
  lines.push(`tags: [${(meta.tags ?? []).map((t) => yamlString(t)).join(", ")}]`);
  lines.push(`created: ${yamlString(meta.created)}`);
  lines.push(`updated: ${yamlString(meta.updated)}`);
  lines.push(`pinned: ${meta.pinned ? "true" : "false"}`);
  lines.push(`word_count: ${meta.word_count}`);
  if (meta.location) {
    lines.push(`location:`);
    lines.push(`  lat: ${Number(meta.location.lat)}`);
    lines.push(`  lon: ${Number(meta.location.lon)}`);
    if (meta.location.name) lines.push(`  name: ${yamlString(meta.location.name)}`);
  }
  if (meta.device) lines.push(`device: ${yamlString(meta.device)}`);
  if (meta.auto_tag_hash) lines.push(`auto_tag_hash: ${yamlString(meta.auto_tag_hash)}`);
  if (meta.auto_tagged_at) lines.push(`auto_tagged_at: ${yamlString(meta.auto_tagged_at)}`);
  const yaml = lines.join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}

function sortTags(tags: string[]): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function parseDateRaw(value: unknown, fallback: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

export function parseNoteFile(
  fileContent: string | Buffer,
  id?: string,
  fallbackTitle?: string,
): Note {
  const raw = Buffer.isBuffer(fileContent) ? fileContent.toString("utf8") : fileContent;
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;

  const now = new Date().toISOString();
  // Explicitly empty titles stay empty (so new notes don't show "Untitled");
  // we only fall back when no `title` is present in the frontmatter.
  const title =
    typeof fm.title === "string"
      ? fm.title.trim()
      : fallbackTitle ?? "Untitled";

  const locRaw = fm.location;
  let location: NoteLocation | null = null;
  if (locRaw && typeof locRaw === "object") {
    const lat = Number((locRaw as Record<string, unknown>).lat);
    const lon = Number((locRaw as Record<string, unknown>).lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      const name = (locRaw as Record<string, unknown>).name;
      location = { lat, lon, name: typeof name === "string" && name ? name : null };
    }
  }

  const resolvedId = typeof fm.id === "string" && fm.id ? fm.id : id ?? "";

  return {
    id: resolvedId,
    title,
    tags: Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : [],
    created: parseDateRaw(fm.created, now),
    updated: parseDateRaw(fm.updated, now),
    pinned: !!fm.pinned,
    location,
    device: typeof fm.device === "string" && fm.device ? fm.device : null,
    auto_tag_hash: typeof fm.auto_tag_hash === "string" && fm.auto_tag_hash ? fm.auto_tag_hash : null,
    auto_tagged_at:
      fm.auto_tagged_at instanceof Date
        ? fm.auto_tagged_at.toISOString()
        : typeof fm.auto_tagged_at === "string" && fm.auto_tagged_at
          ? fm.auto_tagged_at
          : null,
    word_count:
      typeof fm.word_count === "number" && Number.isFinite(fm.word_count)
        ? fm.word_count
        : computeWordCount(parsed.content),
    body: parsed.content.replace(/^\n/, "").trimEnd() + "\n",
  };
}

export async function readNote(id: string): Promise<Note> {
  const filePath = noteFilePath(id);
  const content = await fsp.readFile(filePath);
  try {
    return parseNoteFile(content, id);
  } catch (err) {
    throw new Error(`Failed to parse note ${id}: ${(err as Error).message}`);
  }
}

function stripMarkdownForExcerpt(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/[#>*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toListEntry(note: Note): NoteListEntry {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    created: note.created,
    updated: note.updated,
    pinned: note.pinned,
    location: note.location,
    device: note.device,
    word_count: note.word_count,
    excerpt: stripMarkdownForExcerpt(note.body).slice(0, 260),
  };
}

/** Ensure a note folder on disk exists and matches the id; throws if a different note claims it. */
async function assertUsableFolder(id: string): Promise<void> {
  const dir = noteDir(id);
  try {
    await fsp.access(dir);
  } catch {
    throw new Error(`Note not found: ${id}`);
  }
  const filePath = noteFilePath(id);
  try {
    await fsp.access(filePath);
  } catch {
    throw new Error(`Note is missing note.md: ${id}`);
  }
  const existing = await readNote(id);
  if (existing.id !== id) {
    throw new Error(
      `Note folder ${id} contains a note with different id (${existing.id}). Fix on disk.`,
    );
  }
}

export interface CreateResult {
  note: Note;
}

/** Add/remove tags on several notes at once (single user, so sequential is fine).

Returns the notes that actually changed (for re-indexing) plus the ids that
don't exist. When `add` and `remove` overlap, `remove` wins.
 */
export async function batchUpdateTags(
  ids: string[],
  add: string[] = [],
  remove: string[] = [],
): Promise<{ updated: Note[]; missing: string[] }> {
  const addSet = new Set(add.map((t) => t.trim().replace(/^#/, "")).filter(Boolean));
  const removeSet = new Set(remove.map((t) => t.trim().replace(/^#/, "")).filter(Boolean));
  const updated: Note[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    try {
      const existing = await readNote(id);
      const next = sortTags(existing.tags.filter((t) => !removeSet.has(t)));
      for (const t of addSet) {
        if (!next.includes(t)) next.push(t);
      }
      const sorted = sortTags(next);
      if (sorted.join("\u0000") === existing.tags.join("\u0000")) continue; // no-op, don't touch `updated`
      updated.push(await updateNote(id, { tags: sorted }));
    } catch {
      missing.push(id);
    }
  }
  return { updated, missing };
}

/** Move several notes to the bin at once. Returns ids actually binned + missing. */
export async function batchDelete(ids: string[]): Promise<{ deleted: string[]; missing: string[] }> {
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    try {
      await readNote(id); // 404/parse failures are "missing"
      await deleteNote(id);
      deleted.push(id);
    } catch {
      missing.push(id);
    }
  }
  return { deleted, missing };
}

export async function createNote(input: NoteInput): Promise<Note> {
  const title = (input.title ?? "").trim();
  const now = new Date().toISOString();
  const id = generateNoteId(title);

  const body = normalizeBody(input.body ?? "");
  const meta: NoteMeta = {
    id,
    title,
    tags: sortTags(input.tags ?? []),
    created: input.created ?? now,
    updated: now,
    pinned: !!input.pinned,
    location: input.location ?? null,
    device: input.device ?? null,
    word_count: computeWordCount(body),
  };

  const dir = noteDir(id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(attachmentDir(id), { recursive: true });
  try {
    await fsp.writeFile(noteFilePath(id), serializeFrontmatter(meta, body), "utf8");
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { ...meta, body };
}

export async function updateNote(id: string, input: NoteInput): Promise<Note> {
  await assertUsableFolder(id);
  const existing = await readNote(id);

  const body = normalizeBody(input.body !== undefined ? (input.body ?? "") : existing.body);
  const title = (input.title ?? existing.title).trim();
  const meta: NoteMeta = {
    id,
    title,
    tags: sortTags(input.tags ?? existing.tags),
    created: existing.created,
    updated: new Date().toISOString(),
    pinned: input.pinned ?? existing.pinned,
    location: input.location !== undefined ? input.location : existing.location,
    device: input.device !== undefined ? input.device : existing.device,
    word_count: computeWordCount(body),
    auto_tag_hash: existing.auto_tag_hash,
    auto_tagged_at: existing.auto_tagged_at,
  };

  // Atomic write
  const filePath = noteFilePath(id);
  const tmp = path.join(noteDir(id), `.note.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  await fsp.writeFile(tmp, serializeFrontmatter(meta, body), "utf8");
  await fsp.rename(tmp, filePath);
  return { ...meta, body };
}

/** Patch listed metadata fields without touching body, title, or `updated`.

Auto-tagging (and any bookkeeping-style update) must not bump `updated`, which
would masquerade as a content edit in the note list. Preserves everything else.
 */
export async function patchNoteMeta(
  id: string,
  patch: Partial<Pick<NoteMeta, "tags" | "auto_tag_hash" | "auto_tagged_at">>,
): Promise<Note> {
  await assertUsableFolder(id);
  const existing = await readNote(id);
  const meta: NoteMeta = {
    id: existing.id,
    title: existing.title,
    tags: patch.tags !== undefined ? sortTags(patch.tags) : existing.tags,
    created: existing.created,
    updated: existing.updated,
    pinned: existing.pinned,
    location: existing.location,
    device: existing.device,
    word_count: existing.word_count,
    auto_tag_hash: patch.auto_tag_hash !== undefined ? patch.auto_tag_hash : existing.auto_tag_hash,
    auto_tagged_at: patch.auto_tagged_at !== undefined ? patch.auto_tagged_at : existing.auto_tagged_at,
  };

  const filePath = noteFilePath(id);
  const tmp = path.join(noteDir(id), `.note.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  await fsp.writeFile(tmp, serializeFrontmatter(meta, existing.body), "utf8");
  await fsp.rename(tmp, filePath);
  return { ...meta, body: existing.body };
}

/** Move a note folder into the bin. The note stays on disk until emptied. */
export async function deleteNote(id: string): Promise<void> {
  await moveToTrash(id);
}

async function moveToTrash(id: string): Promise<void> {
  const from = noteDir(id);
  let exists = true;
  try {
    await fsp.access(from);
  } catch {
    exists = false;
  }
  if (!exists) return;
  const to = trashNoteDir(id);
  await fsp.mkdir(config.trashDir, { recursive: true });
  // On same filesystem rename is atomic; fall back to copy+remove otherwise.
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Move a binned note back into the notes area. Throws if not in the bin. */
export async function restoreNote(id: string): Promise<Note> {
  const from = trashNoteDir(id);
  const to = noteDir(id);
  await fsp.access(from); // throws if missing
  await fsp.access(path.join(from, NOTE_FILE));
  await fsp.mkdir(noteDir(id), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
  return readNote(id);
}

/** Permanently remove a single binned note. */
export async function purgeTrashedNote(id: string): Promise<void> {
  await fsp.rm(trashNoteDir(id), { recursive: true, force: true });
}

/** Permanently remove every binned note. Returns number purged. */
export async function emptyTrash(): Promise<number> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(config.trashDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let purged = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (!/^[A-Za-z0-9-_]+$/.test(e.name)) continue;
    await fsp.rm(path.join(config.trashDir, e.name), { recursive: true, force: true });
    purged++;
  }
  return purged;
}

/** List notes currently in the bin, newest first. */
export async function listTrashedNotes(): Promise<NoteListEntry[]> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(config.trashDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const notes: NoteListEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (!/^[A-Za-z0-9-_]+$/.test(e.name)) continue;
    try {
      const content = await fsp.readFile(path.join(config.trashDir, e.name, NOTE_FILE));
      const note = parseNoteFile(content, e.name);
      if (note.id !== e.name) continue; // skip mismatched/corrupt bins
      notes.push(toListEntry(note));
    } catch {
      // skip unreadable binned notes
    }
  }
  notes.sort((a, b) => b.updated.localeCompare(a.updated));
  return notes;
}

/** Total on-disk size of a note's text file plus all attachments, and attachment count. */
export async function noteSize(id: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  try {
    const st = await fsp.stat(noteFilePath(id));
    bytes += st.size;
  } catch {
    /* no note.md (yet) */
  }
  let count = 0;
  const attach = attachmentDir(id);
  try {
    const entries = await fsp.readdir(attach, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        bytes += (await fsp.stat(path.join(attach, e.name))).size;
        count++;
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    /* no attachments dir */
  }
  return { bytes, count };
}

export async function listNoteIds(): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(config.notesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (!/^[A-Za-z0-9-_]+$/.test(e.name)) continue;
    const exists = await fsp.access(path.join(config.notesDir, e.name, NOTE_FILE)).then(
      () => true,
      () => false,
    );
    if (exists) ids.push(e.name);
  }
  return ids.sort();
}

export async function listNotes(opts: ListOptions = {}): Promise<NoteListEntry[]> {
  const ids = await listNoteIds();
  const notes: Note[] = [];
  for (const id of ids) {
    try {
      notes.push(await readNote(id));
    } catch {
      // skip unreadable/corrupt notes rather than killing the list
    }
  }

  let filtered = notes;
  if (opts.tag) {
    filtered = filtered.filter((n) => n.tags.includes(opts.tag!));
  }
  if (opts.pinned !== undefined) {
    filtered = filtered.filter((n) => n.pinned === opts.pinned);
  }

  const sort = opts.sort ?? "updated";
  const dir = opts.order === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    let cmp = 0;
    if (sort === "title") cmp = a.title.localeCompare(b.title);
    else cmp = a[sort].localeCompare(b[sort]);
    return cmp * dir;
  });

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return filtered.slice(offset, offset + limit).map(toListEntry);
}

export async function listNotesTotal(opts: Omit<ListOptions, "limit" | "offset"> = {}): Promise<number> {
  return noteCount(opts);
}

export async function noteCount(opts: { tag?: string; pinned?: boolean } = {}): Promise<number> {
  const ids = await listNoteIds();
  let n = 0;
  for (const id of ids) {
    try {
      const note = await readNote(id);
      if (opts.tag && !note.tags.includes(opts.tag)) continue;
      if (opts.pinned !== undefined && note.pinned !== opts.pinned) continue;
      n++;
    } catch {
      // skip
    }
  }
  return n;
}

export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const ids = await listNoteIds();
  const counts = new Map<string, number>();
  for (const id of ids) {
    try {
      const note = await readNote(id);
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    } catch {
      // skip
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function normalizeBody(body: string): string {
  // Normalize CRLF to LF, strip trailing whitespace per line, ensure single trailing newline
  const cleaned = body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  return cleaned.trimEnd() + "\n";
}

/** List attachment filenames for a note, or null if the note doesn't exist. */
export async function listAttachments(id: string): Promise<string[] | null> {
  const dir = noteDir(id);
  try {
    await fsp.access(dir);
  } catch {
    return null;
  }
  const attach = attachmentDir(id);
  try {
    const entries = await fsp.readdir(attach, { withFileTypes: true });
    return entries.filter((f) => f.isFile()).map((f) => f.name).sort();
  } catch {
    return [];
  }
}

/** Validate an attachment filename against path traversal and weirdness. */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[\x00-\x1f]/g, "");
  if (!base || base === "." || base === "..") throw new Error("Invalid filename");
  return base.slice(0, 255);
}

/** Stream helper: write an uploaded buffer to a temp file then rename (atomic). */
export async function writeAttachment(
  id: string,
  filename: string,
  data: Buffer,
): Promise<{ noteDir: string; finalPath: string }> {
  await assertUsableFolder(id);
  const dir = attachmentDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, filename);
  const tmp = path.join(dir, `.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  await fsp.writeFile(tmp, data, { mode: 0o644 });
  await fsp.rename(tmp, finalPath);
  return { noteDir: dir, finalPath };
}

export function ensureAttachmentDirSync(id: string): void {
  fs.mkdirSync(attachmentDir(id), { recursive: true });
  fs.mkdirSync(noteDir(id), { recursive: true });
}

/** tmpdir helper for imports/uploads */
export function createTempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "notes-"));
}

export async function rmDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}