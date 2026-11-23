import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pack, type Pack } from "tar-stream";
import {
  listNoteIds,
  readNote,
  listAttachments,
  attachmentPath,
  type Note,
} from "../storage/notes.js";
import { mimeFromFilename } from "./notes.js";
import {
  JEX_TYPE_NOTE,
  JEX_TYPE_RESOURCE,
  JEX_TYPE_TAG,
  JEX_TYPE_NOTE_TAG,
} from "../lib/jex.js";

/** Deterministic 32-hex Joplin-style id derived from a seed string. */
function hexId(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** Serialize an item in Joplin BaseItem format (`<title>\n\n<body>\n\nkey: value…`). */
function serializeItem(title: string, body: string, props: Array<[string, string]>): Buffer {
  const lines = [title ?? "", "", body ?? "", ""];
  for (const [k, v] of props) lines.push(`${k}: ${v}`);
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

function serializeNote(note: Note, noteHex: string, resMap: Map<string, string>): Buffer {
  const body = note.body.replace(/attachments\/([^\s()\[\]<>]+)/g, (m, raw: string) => {
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* keep raw form */
    }
    const hex = resMap.get(name) ?? resMap.get(raw);
    return hex ? `:/${hex}` : m;
  });

  const props: Array<[string, string]> = [
    ["id", noteHex],
    ["parent_id", ""],
    ["created_time", note.created],
    ["updated_time", note.updated],
    ["is_archive", "0"],
    ["is_todo", "0"],
  ];
  if (note.location) {
    props.push(["latitude", String(note.location.lat)]);
    props.push(["longitude", String(note.location.lon)]);
  }
  props.push(["altitude", ""], ["source", "web_note_export"], ["type_", String(JEX_TYPE_NOTE)]);
  return serializeItem(note.title, body, props);
}

function serializeResource(note: Note, filename: string, resHex: string, ext: string, mime: string): Buffer {
  const base = path.basename(filename, path.extname(filename));
  const props: Array<[string, string]> = [
    ["id", resHex],
    ["parent_id", hexId(note.id)],
    ["created_time", note.created],
    ["updated_time", note.updated],
    ["encryption_applied", "0"],
    ["is_archive", "0"],
    ["file_extension", ext],
    ["mime", mime],
    ["confidence", "0"],
    ["type_", String(JEX_TYPE_RESOURCE)],
  ];
  return serializeItem(base, "", props);
}

function serializeTag(name: string, tagHex: string, now: string): Buffer {
  const props: Array<[string, string]> = [
    ["id", tagHex],
    ["parent_id", ""],
    ["created_time", now],
    ["updated_time", now],
    ["type_", String(JEX_TYPE_TAG)],
  ];
  return serializeItem(name, "", props);
}

function serializeNoteTag(noteHex: string, tagHex: string, now: string): Buffer {
  const props: Array<[string, string]> = [
    ["id", hexId(`notetag:${noteHex}:${tagHex}`)],
    ["parent_id", ""],
    ["note_id", noteHex],
    ["tag_id", tagHex],
    ["created_time", now],
    ["updated_time", now],
    ["type_", String(JEX_TYPE_NOTE_TAG)],
  ];
  return serializeItem(`${noteHex}-${tagHex}`, "", props);
}

/** Add a whole-buffer (small metadata item) entry. */
async function addEntry(p: Pack, name: string, buf: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    p.entry({ name, size: buf.length }, buf, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Stream a resource binary into the archive (sequential so pack stays consistent). */
async function addResourceEntry(p: Pack, resHex: string, ext: string, filePath: string): Promise<void> {
  const stat = await fsp.stat(filePath);
  await new Promise<void>((resolve, reject) => {
    const sink = p.entry({ name: `resources/${resHex}.${ext}`, size: stat.size, mtime: stat.mtime });
    const src = createReadStream(filePath);
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    sink.on("finish", () => done());
    sink.on("error", done);
    src.on("error", (e) => {
      sink.destroy();
      done(e);
    });
    src.pipe(sink);
  });
}

async function buildJex(p: Pack): Promise<void> {
  const ids = await listNoteIds();
  const now = new Date().toISOString();
  const tagIds = new Map<string, string>();
  const noteTagsAdded = new Set<string>();

  for (const id of ids) {
    let note: Note;
    try {
      note = await readNote(id);
    } catch {
      continue; // skip unreadable/corrupt notes so the backup still succeeds
    }

    const noteHex = hexId(note.id);
    const attachments = (await listAttachments(id)) ?? [];
    const resMap = new Map<string, string>();

    for (const filename of attachments) {
      const resHex = hexId(`${note.id}:${filename}`);
      resMap.set(filename, resHex);
      const ext = path.extname(filename).replace(/^\./, "");
      const mime = mimeFromFilename(filename);
      await addEntry(p, `${resHex}.md`, serializeResource(note, filename, resHex, ext, mime));
      await addResourceEntry(p, resHex, ext, attachmentPath(id, filename));
    }

    await addEntry(p, `${noteHex}.md`, serializeNote(note, noteHex, resMap));

    for (const tag of note.tags) {
      const key = tag.trim();
      if (!key) continue;
      let tagHex = tagIds.get(key);
      if (!tagHex) {
        tagHex = hexId(`tag:${key}`);
        tagIds.set(key, tagHex);
        await addEntry(p, `${tagHex}.md`, serializeTag(key, tagHex, now));
      }
      const ntKey = `${noteHex}:${tagHex}`;
      if (!noteTagsAdded.has(ntKey)) {
        noteTagsAdded.add(ntKey);
        await addEntry(p, `${hexId(`notetag:${noteHex}:${tagHex}`)}.md`, serializeNoteTag(noteHex, tagHex, now));
      }
    }
  }
}

export function attachExportRoutes(app: FastifyInstance): void {
  app.get("/api/export", async (_req, reply) => {
    const p = pack();
    void (async () => {
      try {
        await buildJex(p);
        p.finalize();
      } catch (err) {
        p.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "application/x-joplin-archive");
    reply.header("Content-Disposition", `attachment; filename="web-note-backup-${stamp}.jex"`);
    return reply.send(p);
  });
}