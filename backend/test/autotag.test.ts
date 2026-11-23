import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must set DATA_DIR before the storage modules are imported (they read env at load).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-autotag-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const notes = await import("../src/storage/notes.js");
const idx = await import("../src/storage/index.js");
const autotag = await import("../src/lib/autotag.js");

afterAll(() => {
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await notes.ensureDirs();
  idx.initIndex();
});

beforeEach(() => {
  // Isolate each test: fresh notes dir (index keeps old rows, but those note
  // dirs no longer exist, so listNoteIds/readNote never see them).
  for (const dir of ["notes", "trash"]) {
    fs.rmSync(path.join(dataDir, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dataDir, "notes"), { recursive: true });
});

const { createNote, updateNote, readNote, patchNoteMeta } = notes;
const { buildAutotagBatch, runAutotag, plainText } = autotag;

const noTagsWorker = async () => [];

describe("autotag orchestration", () => {
  it("tags a fresh note, stamps auto_tag_hash, preserves updated", async () => {
    const note = await createNote({ title: "Paris weekend", body: "flight and hotel booked for the trip" });
    const stamp = (await readNote(note.id)).updated;

    const worker = vi.fn(async (texts: string[]) => [
      [{ tag: "Travel", score: 0.9, method: "keyword" }],
    ]);
    const summary = await runAutotag("http://unused", worker);

    expect(summary.checked).toBe(1);
    expect(summary.tagged).toBe(1);
    expect(summary.appliedTags).toContain("Travel");

    const reread = await readNote(note.id);
    expect(reread.tags).toContain("Travel");
    expect(reread.auto_tag_hash).toBeTruthy();
    expect(reread.auto_tagged_at).toBeTruthy();
    expect(reread.updated).toBe(stamp); // auto-tag is not a content edit
  });

  it("skips notes whose content hash is unchanged (worker not called)", async () => {
    const note = await createNote({ title: "Stable note", body: "flight to madrid" });
    await runAutotag("http://unused", async () => [[{ tag: "Travel", score: 1, method: "keyword" }]]);

    const first = await buildAutotagBatch();
    expect(first.skipped).toBe(1);
    expect(first.total).toBe(1);
    expect(first.batch).toHaveLength(0);

    const bomb = vi.fn(async () => {
      throw new Error("worker should not have been called");
    });
    const summary = await runAutotag("http://unused", bomb);
    expect(summary.checked).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.tagged).toBe(0);
    expect(bomb).not.toHaveBeenCalled();
    expect((await readNote(note.id)).tags).toContain("Travel");
  });

  it("re-runs after content changes and merges (never duplicates) tags", async () => {
    const note = await createNote({ title: "Changing", body: "original body text" });
    await runAutotag("http://unused", async () => [[]]);
    await updateNote(note.id, { body: "a new recipe for pasta with fresh ingredients" });

    const worker = vi.fn(async (texts: string[]) => [
      [{ tag: "Recipes", score: 0.82, method: "vector" }],
    ]);
    const summary = await runAutotag("http://unused", worker);
    expect(summary.checked).toBe(1);
    expect(summary.tagged).toBe(1);

    const reread = await readNote(note.id);
    expect(reread.tags).toEqual(["Recipes"]);
  });

  it("merges with existing manual tags without duplicating", async () => {
    const note = await createNote({ title: "Dup guard", body: "recipe notes", tags: ["Travel"] });
    const summary = await runAutotag("http://unused", async () => [
      [{ tag: "Travel", score: 0.9, method: "keyword" }],
    ]);
    expect(summary.untagged).toBe(1); // no *new* tag added; still marked processed
    const reread = await readNote(note.id);
    expect(reread.tags.filter((t) => t === "Travel")).toHaveLength(1);
    expect(reread.auto_tag_hash).toBeTruthy();
  });

  it("marks a note processed even when the classifier is not confident", async () => {
    const note = await createNote({ title: "Vague", body: "just some short thought" });
    const summary = await runAutotag("http://unused", noTagsWorker);
    expect(summary.checked).toBe(1);
    expect(summary.untagged).toBe(1);
    const reread = await readNote(note.id);
    expect(reread.auto_tag_hash).toBeTruthy();
  });
});

describe("plainText", () => {
  it("strips markdown syntax but keeps words and link text", () => {
    expect(plainText("# Title\n\nSome **bold** and [a link](https://x.com) ![pic](f.png)")).toBe(
      "Title Some bold and a link pic",
    );
  });

  it("drops code fences entirely", () => {
    expect(plainText("before\n```js\nconst x = 1;\n```\nafter")).toBe("before after");
  });
});

describe("patchNoteMeta", () => {
  it("updates tags and stamps auto-tag fields without bumping updated", async () => {
    const note = await createNote({ title: "Patching", body: "body", tags: ["a"] });
    const stamp = note.updated;
    const patched = await patchNoteMeta(note.id, {
      tags: ["a", "b"],
      auto_tag_hash: "abc123",
      auto_tagged_at: stamp,
    });
    expect(patched.updated).toBe(stamp);
    expect(patched.tags).toEqual(["a", "b"]);
    expect(patched.auto_tag_hash).toBe("abc123");
    const reread = await readNote(note.id);
    expect(reread.tags).toEqual(["a", "b"]);
    expect(reread.auto_tag_hash).toBe("abc123");
  });
});