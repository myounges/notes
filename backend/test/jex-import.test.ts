import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pack, extract } from "tar-stream";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-jex-test-"));
const originalEnv = process.env.DATA_DIR;
const originalSecret = process.env.SESSION_SECRET;
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-session-secret";

const { buildServer } = await import("../src/server.js");
const authMod = await import("../src/lib/auth.js");
const notesMod = await import("../src/storage/notes.js");

let app: Awaited<ReturnType<typeof buildServer>>;
let createdIds: string[] = [];

const COOKIE_NAME = "notes_session";

/** Build a JEX-style tarball (plain, not gzip) from path→Buffer entries. */
function buildTar(entries: Record<string, string | Buffer>): Buffer {
  return new Promise((resolve, reject) => {
    const packer = pack();
    const chunks: Buffer[] = [];
    packer.on("data", (c) => chunks.push(c));
    packer.on("end", () => resolve(Buffer.concat(chunks)));
    packer.on("error", reject);
    const names = Object.keys(entries);
    let i = 0;
    const next = () => {
      if (i >= names.length) {
        packer.finalize();
        return;
      }
      const name = names[i++];
      const data = Buffer.isBuffer(entries[name]) ? entries[name]! : Buffer.from(entries[name] as string, "utf8");
      packer.entry({ name }, data, next);
    };
    next();
  });
}

beforeAll(async () => {
  app = await buildServer();
  if (!authMod.authConfigured()) {
    await authMod.bootstrapPassword("correct-horse-battery");
  }
  createdIds = [];
});

afterAll(async () => {
  await app.close();
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"] as unknown as string;
  return setCookie.split(";")[0].split("=")[1];
}

async function upload(tar: Buffer): Promise<{ imported: number; skipped: number; errors: number }> {
  const token = await login();
  const res = await app.inject({
    method: "POST",
    url: "/api/import",
    headers: {
      cookie: `${COOKIE_NAME}=${token}`,
      "content-type": "multipart/form-data; boundary=----testboundary",
    },
    payload: multipartPayload(tar, "backup.jex"),
  });
  return JSON.parse(res.body);
}

function multipartPayload(file: Buffer, filename: string): Buffer {
  const boundary = "----testboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([head, file, tail]);
}

describe("JEX import", () => {
  it("imports a JEX backup with tags, timestamps, location and attachments", async () => {
    const noteId = "ae08726c53434f59a3d6bd0544381a1e";
    const tagId = "f96e8c1feaa847e2ac1b8d22df929d26";
    const resId = "0a2d822946f94e3590113b953d7a8827";

    const tar = await buildTar({
      [`${noteId}.md`]: `My Imported Note

# My Imported Note
Screenshot here:

![shot](:/${resId})

id: ${noteId}
parent_id: 
created_time: 1610000000000
updated_time: 1610086400000
is_conflict: 0
latitude: 40.12345678
longitude: -3.87654321
altitude: 0.0000
type_: 1
`,
      [`${tagId}.md`]: `Home

id: ${tagId}
type_: 5
`,
      [`abc9b71b2fd54c0e819c661dd780a1ac.md`]: `id: abc9b71b2fd54c0e819c661dd780a1ac
note_id: ${noteId}
tag_id: ${tagId}
created_time: 1610000000000
updated_time: 1610000000000
type_: 6
`,
      [`${resId}.md`]: `Image

id: ${resId}
title: screenshot
mime: image/png
file_extension: png
size: 11
type_: 4
`,
      [`resources/${resId}.png`]: Buffer.from("fakeimagebytes", "utf8"),
    });

    const result = await upload(tar);
    expect(result.imported).toBeGreaterThanOrEqual(1);

    // Find the imported note on disk
    const ids = await notesMod.listNoteIds();
    const imported = ids.filter((id) => id.includes("my-imported-note"));
    expect(imported.length).toBe(1);
    const id = imported[0];
    createdIds.push(id);

    const note = await notesMod.readNote(id);
    expect(note.title).toBe("My Imported Note");
    expect(note.tags).toEqual(["Home"]);
    expect(note.created).toBe("2021-01-07T06:13:20.000Z");
    expect(note.updated).toBe("2021-01-08T06:13:20.000Z");
    expect(note.location).toEqual({ lat: 40.12345678, lon: -3.87654321, name: null });
    // internal resource link rewritten
    expect(note.body).toContain("attachments/");
    expect(note.body).not.toContain(`:/${resId}`);

    // attachment written
    const atts = await notesMod.listAttachments(id);
    expect(atts?.some((a) => a.endsWith(".png"))).toBe(true);
  });

  it("imports resources even when the archive has more than 2000 entries", async () => {
    const noteId = "5f6a4b3c2d1e0f9a8b7c6d5e4f3a2b11";
    const resId = "0a2d822946f94e3590113b953d7a8827";

    const entries: Record<string, string | Buffer> = {
      [`${noteId}.md`]: `Many Resources

![shot](:/${resId})

id: ${noteId}
parent_id: 
created_time: 1610000000000
updated_time: 1610086400000
is_conflict: 0
type_: 1
`,
      [`${resId}.md`]: `Image

id: ${resId}
title: screenshot
mime: image/png
file_extension: png
size: 11
type_: 4
`,
    };

    // Pad with filler resource binaries so the archive exceeds 2000 file entries.
    // The real resource binary is added LAST so it lands past the old 2000-entry
    // cap (regression test: without the cap removal it would be silently dropped).
    for (let i = 0; i < 2200; i++) {
      entries[`resources/0000pad${String(i).padStart(4, "0")}.bin`] = Buffer.from(`pad-${i}`, "utf8");
    }
    entries[`resources/${resId}.png`] = Buffer.from("fakeimagebytes", "utf8");

    const result = await upload(await buildTar(entries));
    expect(result.imported).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    const ids = await notesMod.listNoteIds();
    const id = ids.find((x) => x.includes("many-resources"));
    expect(id).toBeTruthy();
    createdIds.push(id!);

    const note = await notesMod.readNote(id!);
    expect(note.body).toContain("attachments/");
    expect(note.body).not.toContain(`:/${resId}`);

    const atts = await notesMod.listAttachments(id!);
    expect(atts?.some((a) => a.endsWith(".png"))).toBe(true);
  });
});

async function readTar(buf: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    const ex = extract();
    ex.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    ex.on("finish", () => resolve(entries));
    ex.on("error", reject);
    ex.end(buf);
  });
}

describe("JEX export", () => {
  it("exports notes as a JEX tarball with tags and attachments", async () => {
    const note = await notesMod.createNote({
      title: "Export Me",
      body: "Hello world\n\n![pic](attachments/pic.png)\n",
      tags: ["abc", "def"],
      pinned: true,
    });
    createdIds.push(note.id);
    await notesMod.writeAttachment(note.id, "pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const token = await login();
    const res = await app.inject({
      method: "GET",
      url: "/api/export",
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    const cd = res.headers["content-disposition"] as string;
    expect(cd).toMatch(/filename="web-note-backup-\d{4}-\d{2}-\d{2}\.jex"/);

    const entries = await readTar(res.rawPayload as Buffer);

    // note item present with type_ 1 and its attachment link rewritten to :/<hex>
    const noteEntry = [...entries.values()].find((b) => b.toString("utf8").includes("Export Me"));
    expect(noteEntry).toBeTruthy();
    const noteText = noteEntry!.toString("utf8");
    expect(noteText).toContain("type_: 1");
    const resHexMatch = noteText.match(/:\/([a-f0-9]{32})/);
    expect(resHexMatch).toBeTruthy();
    expect(noteText).not.toContain("attachments/pic.png");

    // resource binary present
    expect(entries.has(`resources/${resHexMatch![1]}.png`)).toBe(true);
    const resourceItem = [...entries.values()].find((b) => b.toString("utf8").includes("type_: 4"));
    expect(resourceItem).toBeTruthy();

    // tag + note-tag items present
    const tagItem = [...entries.values()].find((b) => b.toString("utf8").includes("type_: 5"));
    expect(tagItem).toBeTruthy();
    const noteTagItem = [...entries.values()].find(
      (b) => b.toString("utf8").includes("note_id:") && b.toString("utf8").includes("tag_id:"),
    );
    expect(noteTagItem).toBeTruthy();
  });
});
