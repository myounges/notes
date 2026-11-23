import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createNote,
  deleteNote,
  batchDelete,
  batchUpdateTags,
  emptyTrash,
  listNotes,
  listTags,
  listTrashedNotes,
  noteCount,
  purgeTrashedNote,
  readNote,
  restoreNote,
  updateNote,
  listAttachments,
  attachmentDir,
  writeAttachment,
  noteSize,
  sanitizeFilename,
  type NoteInput,
} from "../storage/notes.js";
import {
  indexNote,
  unindexNote,
  deleteAttachmentText,
  upsertAttachmentText,
  getAttachmentText,
  reindexAll,
} from "../storage/index.js";
import { deviceFromUserAgent } from "../lib/auth.js";
import { config } from "../lib/config.js";

function parseNoteInput(body: unknown): NoteInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const input: NoteInput = {};
  if ("title" in b) input.title = typeof b.title === "string" ? b.title : null;
  if ("body" in b) input.body = typeof b.body === "string" ? b.body : null;
  if ("pinned" in b) input.pinned = typeof b.pinned === "boolean" ? b.pinned : null;
  if ("tags" in b && Array.isArray(b.tags)) {
    input.tags = b.tags.filter((t): t is string => typeof t === "string");
  }
  if ("location" in b) {
    const loc = b.location as { lat?: unknown; lon?: unknown; name?: unknown } | null | undefined;
    if (loc && typeof loc === "object") {
      const lat = typeof loc.lat === "number" ? loc.lat : Number.NaN;
      const lon = typeof loc.lon === "number" ? loc.lon : Number.NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        input.location = {
          lat,
          lon,
          name: typeof loc.name === "string" && loc.name ? loc.name : null,
        };
      }
    } else if (loc === null) {
      input.location = null;
    }
  }
  if ("device" in b) input.device = typeof b.device === "string" ? b.device : null;
  return input;
}

const VALID_SORTS = new Set(["updated", "created", "title"]);

/** Validate + dedupe + cap an array of note ids for batch operations. */
function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const x of value) {
    if (typeof x !== "string" || !/^[\w-]+$/.test(x) || x.includes("..")) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    ids.push(x);
    if (ids.length >= 500) break;
  }
  return ids;
}

/** Validate + dedupe + cap a list of tag names for batch operations. */
function parseTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const x of value) {
    if (typeof x !== "string") continue;
    const t = x.trim().replace(/^#/, "").slice(0, 100);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  return tags;
}

export function attachNoteRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
    notes: (await noteCount()).toString(),
  }));

  app.get("/api/notes", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const sort = VALID_SORTS.has(q.sort ?? "") ? (q.sort as "updated" | "created" | "title") : "updated";
    const order = q.order === "asc" ? "asc" : "desc";
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const tag = q.tag || undefined;
    const pinned = q.pinned === "true" ? true : q.pinned === "false" ? false : undefined;

    const notes = await listNotes({ sort, order, limit, offset, tag, pinned });
    const total = await noteCount({ tag, pinned });
    const hasMore = offset + notes.length < total;
    return { notes, total, hasMore };
  });

  app.get("/api/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const note = await readNote(id);
      const attachments = await listAttachments(id);
      const size = await noteSize(id);
      return { ...note, attachments: attachments ?? [], note_size_bytes: size.bytes };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post("/api/notes", async (req, reply) => {
    const input = parseNoteInput(req.body);
    input.device = deviceFromUserAgent(req.headers["user-agent"]);
    // New notes keep a blank title until the user types one; display fallbacks
    // (list, search) show "Untitled" only when empty.
    input.title = typeof input.title === "string" ? input.title.trim() : "";
    try {
      const note = await createNote(input);
      indexNote(note);
      return reply.code(201).send(note);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.put("/api/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = parseNoteInput(req.body);
    try {
      const note = await updateNote(id, input);
      indexNote(note);
      const size = await noteSize(id);
      return { ...note, note_size_bytes: size.bytes };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await readNote(id); // 404 if missing
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    // Soft-delete: move the note + attachments into the bin.
    await deleteNote(id);
    // Binned notes leave the search index until restored or purged.
    unindexNote(id);
    deleteAttachmentText(id);
    return { ok: true };
  });

  // ---------- batch (bulk selection) ----------

  app.post("/api/notes/batch/tags", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = parseIdList(b.ids);
    const add = parseTagList(b.add);
    const remove = parseTagList(b.remove);
    if (ids.length === 0) return reply.code(400).send({ error: "No valid note ids provided" });
    if (add.length === 0 && remove.length === 0) {
      return reply.code(400).send({ error: "Nothing to apply — provide add and/or remove tags" });
    }
    const { updated, missing } = await batchUpdateTags(ids, add, remove);
    for (const note of updated) indexNote(note);
    return { ok: true, updated: updated.length, missing };
  });

  app.post("/api/notes/batch/delete", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = parseIdList(b.ids);
    if (ids.length === 0) return reply.code(400).send({ error: "No valid note ids provided" });
    const { deleted, missing } = await batchDelete(ids);
    for (const id of deleted) {
      unindexNote(id);
      deleteAttachmentText(id);
    }
    return { ok: true, deleted: deleted.length, missing };
  });

  // ---------- bin (trash) ----------

  app.get("/api/trash", async () => ({ notes: await listTrashedNotes() }));

  app.post("/api/trash/:id/restore", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const note = await restoreNote(id);
      indexNote(note);
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/trash/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await purgeTrashedNote(id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    unindexNote(id);
    deleteAttachmentText(id);
    return { ok: true };
  });

  app.delete("/api/trash", async () => ({
    ok: true,
    purged: await emptyTrash(),
  }));

  // ---------- attachments ----------

  app.post("/api/notes/:id/attachments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const maxBytes = config.maxUploadMb * 1024 * 1024;
    try {
      const note = await readNote(id);
      void note;
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }

    const parts = req.parts();
    const uploaded: Array<{ filename: string; bytes: number; status: "done" | "failed" }> = [];
    const failures: string[] = [];
    for await (const part of parts) {
      if (part.type !== "file") continue;
      const originalName = part.filename ?? "file";
      let filename: string;
      try {
        filename = sanitizeFilename(originalName);
      } catch {
        failures.push(`${originalName}: invalid filename`);
        continue;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      for await (const chunk of part.file as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) {
          tooBig = true;
          chunks.length = 0;
          break;
        }
        chunks.push(chunk);
      }
      if (tooBig) {
        failures.push(`${originalName}: exceeds ${config.maxUploadMb}MB limit`);
        continue;
      }
      if (size === 0) {
        failures.push(`${originalName}: empty file`);
        continue;
      }
      const data = Buffer.concat(chunks);
      try {
        await writeAttachment(id, filename, data);
        upsertAttachmentText(id, filename, { status: "pending" });
        uploaded.push({ filename, bytes: data.length, status: "done" });
      } catch (err) {
        failures.push(`${originalName}: ${(err as Error).message}`);
      }
    }

    return reply.code(201).send({
      uploaded,
      errors: failures,
      maxBytes,
    });
  });

  app.get("/api/notes/:id/attachments/:filename", async (req, reply) => {
    const { id, filename } = req.params as { id: string; filename: string };
    try {
      const file = path.join(attachmentDir(id), sanitizeFilename(filename));
      if (!file.startsWith(attachmentDir(id) + path.sep)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return reply.code(404).send({ error: "Not found" });
      const stream = fs.createReadStream(file);
      return reply.type(mimeFromFilename(filename)).header("content-length", stat.size).send(stream);
    } catch {
      return reply.code(404).send({ error: "Attachment not found" });
    }
  });

  app.delete("/api/notes/:id/attachments/:filename", async (req, reply) => {
    const { id, filename } = req.params as { id: string; filename: string };
    try {
      const file = path.join(attachmentDir(id), sanitizeFilename(filename));
      await fs.promises.unlink(file);
      deleteAttachmentText(id, filename);
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: "Attachment not found" });
    }
  });

  app.get("/api/transcription/attachment/:noteId/:filename", async (req, reply) => {
    const { noteId, filename } = req.params as { noteId: string; filename: string };
    const status = getAttachmentText(noteId, filename);
    if (!status) return reply.code(404).send({ error: "No extraction record for this attachment" });
    return status;
  });

  // ---------- tags ----------

  app.get("/api/tags", async () => ({ tags: await listTags() }));

  // ---------- reindex ----------

  app.post("/api/reindex", async () => {
    const res = await reindexAll();
    return { ...res };
  });
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}