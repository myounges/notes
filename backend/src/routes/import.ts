import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { open as openZip, type ZipFile } from "yauzl";
import { extract as tarExtract } from "tar-stream";
import {
  normalizeSlug,
  noteDir,
  noteFilePath,
  writeAttachment,
  sanitizeFilename,
  parseNoteFile,
  serializeFrontmatter,
  computeWordCount,
  type Note,
  ensureAttachmentDirSync,
} from "../storage/notes.js";
import { indexNote } from "../storage/index.js";
import { deviceFromUserAgent } from "../lib/auth.js";
import {
  parseJexItem,
  jexDate,
  jexCoord,
  JEX_TYPE_NOTE,
  JEX_TYPE_RESOURCE,
  JEX_TYPE_TAG,
  JEX_TYPE_NOTE_TAG,
  type JexItem,
} from "../lib/jex.js";

interface ImportEntry {
  entry: string;
  action: "imported" | "skipped" | "error";
  reason?: string;
}

async function readAllZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  const zip: ZipFile = await new Promise((resolve, reject) => {
    openZip(zipPath, { lazyEntries: false }, (err, z) => {
      if (err) return reject(err);
      resolve(z);
    });
  });

  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    const result = new Map<string, Buffer>();
    zip.on("entry", (entry) => {
      if (/\/$/.test(entry.fileName)) {
        // directory
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          zip.readEntry();
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          result.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
        stream.on("error", reject);
      });
    });
    zip.on("end", () => resolve(result));
    zip.on("error", reject);
    // start reading
    zip.readEntry();
  });
}

/** Stream a (possibly gzipped) tar into a path→content map. */
function readAllTarEntries(tarPath: string, gzip = false): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Buffer>();
    const extractor = tarExtract();

    extractor.on("entry", (header, stream, next) => {
      if (header.type !== "file") {
        stream.resume();
        stream.on("end", next);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        result.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extractor.on("finish", () => resolve(result));
    extractor.on("error", reject);

    const src = createReadStream(tarPath);
    src.on("error", reject);
    if (gzip) src.pipe(zlib.createGunzip()).pipe(extractor);
    else src.pipe(extractor);
  });
}

type ArchiveKind = "zip" | "tar" | "gzip";

/** Detect archive type from magic bytes. */
async function detectArchive(filePath: string): Promise<ArchiveKind> {
  const fd = await fsp.open(filePath, "r");
  const buf = Buffer.alloc(262);
  try {
    await fd.read(buf, 0, 262, 0);
  } finally {
    await fd.close();
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "gzip";
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  // POSIX ustar magic at offset 257
  if (buf.slice(257, 262).toString("ascii") === "ustar") return "tar";
  return "tar";
}

/** Pick a stable attachment filename for a JEX resource. */
function resourceFilename(item: JexItem, id: string, contentName: string): string {
  const fromContent = path.extname(contentName).replace(/^\./, "");
  const ext = (item.props["file_extension"] || fromContent).replace(/^\./, "") || "bin";
  const extLc = ext.toLowerCase();
  let base = (item.props["title"] || id).trim();
  if (base.toLowerCase().endsWith(`.${extLc}`)) base = base.slice(0, -(ext.length + 1));
  return sanitizeFilename(`${base}.${ext}`);
}

interface JexNoteMeta {
  joplinId: string;
  title: string;
  body: string;
  props: Record<string, string>;
}

async function importMdNotes(
  files: Map<string, Buffer>,
  results: ImportEntry[],
  existingIds: Set<string>,
  now: Date,
  userAgent: string,
): Promise<void> {
  const mdFiles = [...files.entries()].filter(([name]) => name.endsWith(".md"));

  for (const [archivePath, contentBuf] of mdFiles) {
    const basename = path.basename(archivePath);
    if (["agent.md", "README.md", ".gitignore"].includes(basename)) {
      results.push({ entry: archivePath, action: "skipped", reason: "system file" });
      continue;
    }

    try {
      const content = contentBuf.toString("utf8");
      let note: Note;
      try {
        note = parseNoteFile(content);
      } catch {
        note = parseNoteFile(content, undefined, basename.replace(/\.md$/i, ""));
      }

      // generate id if missing
      if (!note.id) {
        const slug = normalizeSlug(note.title || basename);
        note.id = `${now.toISOString().slice(0, 10)}-${slug}-${randomUUID().slice(0, 4)}`;
      }
      // ensure unique id
      if (existingIds.has(note.id)) {
        note.id = `${note.id}-${randomUUID().slice(0, 4)}`;
      }
      existingIds.add(note.id);
      note.device = deviceFromUserAgent(userAgent);

      const dir = noteDir(note.id);
      await fsp.mkdir(dir, { recursive: true });
      ensureAttachmentDirSync(note.id);

      // Move referenced assets from same folder in zip
      const folderPrefix = path.dirname(archivePath) + "/";
      for (const [otherPath, assetBuf] of files) {
        if (
          !otherPath.endsWith(".md") &&
          otherPath.startsWith(folderPrefix) &&
          otherPath !== archivePath
        ) {
          const filename = sanitizeFilename(path.basename(otherPath));
          try {
            await writeAttachment(note.id, filename, assetBuf);
          } catch (err) {
            results.push({ entry: otherPath, action: "error", reason: (err as Error).message });
          }
        }
      }

      // Write the note file
      await fsp.writeFile(noteFilePath(note.id), content, "utf8");
      indexNote(note);
      results.push({ entry: archivePath, action: "imported" });
    } catch (err) {
      results.push({ entry: archivePath, action: "error", reason: (err as Error).message });
    }
  }
}

async function importJex(
  files: Map<string, Buffer>,
  results: ImportEntry[],
  existingIds: Set<string>,
  now: Date,
  userAgent: string,
): Promise<void> {
  const notes: JexNoteMeta[] = [];
  const resourceMeta = new Map<string, JexItem>();
  const tags = new Map<string, string>();
  const noteTagsByNote = new Map<string, string[]>();
  const resourceContent = new Map<string, Buffer>(); // id -> binary

  for (const [name, buf] of files) {
    if (name.startsWith("resources/")) {
      const m = name.match(/^resources\/([a-f0-9]{32})(?:\..*)?$/i);
      if (m) resourceContent.set(m[1], buf);
      continue;
    }
    if (!name.endsWith(".md") || name.includes("/") || name.startsWith(".")) continue;

    let item: JexItem;
    try {
      item = parseJexItem(buf.toString("utf8"));
    } catch (err) {
      results.push({ entry: name, action: "error", reason: (err as Error).message });
      continue;
    }
    const id = item.props["id"] ?? "";
    switch (item.type) {
      case JEX_TYPE_NOTE:
        notes.push({ joplinId: id, title: item.title, body: item.body, props: item.props });
        break;
      case JEX_TYPE_RESOURCE:
        if (id) resourceMeta.set(id, item);
        break;
      case JEX_TYPE_TAG:
        if (id) tags.set(id, item.title);
        break;
      case JEX_TYPE_NOTE_TAG: {
        if (!id) break;
        const noteId = item.props["note_id"];
        const tagId = item.props["tag_id"];
        if (noteId && tagId && tags.has(tagId)) {
          const arr = noteTagsByNote.get(noteId) ?? [];
          arr.push(tags.get(tagId)!);
          noteTagsByNote.set(noteId, arr);
        }
        break;
      }
      default:
        break; // folders, settings, etc. are ignored
    }
  }

  // Reusable per note: generate deduped app note ids
  for (const note of notes) {
    if (!note.title && !note.body) {
      results.push({ entry: note.joplinId || note.title || "(untitled)", action: "skipped", reason: "empty note" });
      continue;
    }

    let id = `${now.toISOString().slice(0, 10)}-${normalizeSlug(note.title || "untitled")}-${randomUUID().slice(0, 4)}`;
    while (existingIds.has(id)) {
      id = `${id}-${randomUUID().slice(0, 4)}`;
    }
    existingIds.add(id);

    const tagsForNote = [...new Set((noteTagsByNote.get(note.joplinId) ?? []).map((t) => t.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );

    const created = jexDate(note.props["created_time"], now.toISOString());
    const updated = jexDate(note.props["updated_time"], created);

    const lat = jexCoord(note.props["latitude"]);
    const lon = jexCoord(note.props["longitude"]);
    const location = lat !== null && lon !== null ? { lat, lon, name: null } : null;

    const usedAttachments = new Map<string, string>(); // joplin resource id -> filename
    let body = note.body;

    // Rewrite JEX internal resource links `:/<id>` → `attachments/<file>`.
    // Note→note links (`:/<noteId>`) are left untouched.
    body = body.replace(/:\/([a-f0-9]{32})\b/gi, (m, resId: string) => {
      const resIdLc = resId.toLowerCase();
      const meta = resourceMeta.get(resIdLc);
      const content = resourceContent.get(resIdLc);
      if (meta && content) {
        if (!usedAttachments.has(resIdLc)) {
          const actual = resolveContentName(files, resIdLc);
          usedAttachments.set(resIdLc, resourceFilename(meta, resIdLc, actual));
        }
        return `attachments/${usedAttachments.get(resIdLc)}`;
      }
      return m;
    });

    const dir = noteDir(id);
    await fsp.mkdir(dir, { recursive: true });
    ensureAttachmentDirSync(id);

    const meta = {
      id,
      title: note.title || "Untitled",
      tags: tagsForNote,
      created,
      updated,
      pinned: false,
      location,
      device: deviceFromUserAgent(userAgent),
      word_count: computeWordCount(body),
    };
    const content = serializeFrontmatter(meta, body.trimEnd() + "\n");

    // Write note.md first so writeAttachment's usable-folder check passes
    await fsp.writeFile(noteFilePath(id), content, "utf8");

    // Write referenced resource binaries into the note's attachment dir
    for (const [resId, filename] of usedAttachments) {
      const contentBuf = resourceContent.get(resId);
      if (!contentBuf) {
        results.push({ entry: `${resId}.${filename}`, action: "error", reason: "resource content missing" });
        continue;
      }
      try {
        await writeAttachment(id, filename, contentBuf);
      } catch (err) {
        results.push({ entry: filename, action: "error", reason: (err as Error).message });
      }
    }

    indexNote({ ...meta, body });

    const label = `${note.title || "(untitled)"}${note.joplinId ? ` (${note.joplinId.slice(0, 8)})` : ""}`;
    results.push({ entry: label, action: "imported" });
  }
}

function resolveContentName(files: Map<string, Buffer>, resId: string): string {
  for (const name of files.keys()) {
    const m = name.match(new RegExp(`^resources/${resId}(\\..*)?$`, "i"));
    if (m) return name;
  }
  return "";
}

export function attachImportRoutes(app: FastifyInstance): void {
  app.post("/api/import", async (req, reply) => {
    const parts = req.parts();
    let archiveFile: string | null = null;
    let originalName = "import.zip";

    for await (const part of parts) {
      if (part.type !== "file") continue;
      originalName = part.filename ?? "import.zip";
      const tmp = path.join("/tmp", `notes-import-${randomUUID()}`);
      const chunks: Buffer[] = [];
      for await (const chunk of part.file as AsyncIterable<Buffer>) chunks.push(chunk);
      if (chunks.length === 0) {
        await fsp.unlink(tmp).catch(() => {});
        return reply.code(400).send({ error: "Empty file" });
      }
      await fsp.writeFile(tmp, Buffer.concat(chunks));
      archiveFile = tmp;
    }

    if (!archiveFile) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const results: ImportEntry[] = [];
    const existingIds = new Set<string>();
    const now = new Date();

    try {
      const kind = await detectArchive(archiveFile);

      if (kind === "zip") {
        const files = await readAllZipEntries(archiveFile);
        await importMdNotes(files, results, existingIds, now, String(req.headers["user-agent"] ?? ""));
      } else {
        const files = await readAllTarEntries(archiveFile, kind === "gzip");
        await importJex(files, results, existingIds, now, String(req.headers["user-agent"] ?? ""));
      }

      const imported = results.filter((r) => r.action === "imported").length;
      const skipped = results.filter((r) => r.action === "skipped").length;
      const errors = results.filter((r) => r.action === "error").length;

      return { originalName, imported, skipped, errors, entries: results.slice(0, 100) };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: `Could not read archive (expected a .zip or Joplin .jex file): ${(err as Error).message}` });
    } finally {
      await fsp.rm(archiveFile, { force: true }).catch(() => {});
    }
  });
}