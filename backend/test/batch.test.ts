import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must set DATA_DIR before the storage module is imported (module reads env at load).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-batch-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const notes = await import("../src/storage/notes.js");

afterAll(() => {
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await notes.ensureDirs();
});

beforeEach(async () => {
  fs.rmSync(path.join(dataDir, "notes"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "notes"), { recursive: true });
  fs.rmSync(path.join(dataDir, "trash"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "trash"), { recursive: true });
});

const { createNote, readNote, listTrashedNotes, batchUpdateTags, batchDelete, updateNote } = notes;

async function makeNotes(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const note = await createNote({ title: `Batch note ${i}`, body: `body ${i}`, tags: i % 2 === 0 ? ["shared"] : [] });
    ids.push(note.id);
  }
  return ids;
}

describe("batchUpdateTags", () => {
  it("adds a tag to every listed note and keeps existing tags sorted", async () => {
    const ids = await makeNotes(3);
    const { updated, missing } = await batchUpdateTags(ids, ["new-tag"]);
    expect(missing).toEqual([]);
    expect(updated.length).toBe(3);
    for (const id of ids) {
      const note = await readNote(id);
      expect(note.tags).toContain("new-tag");
      expect([...note.tags].sort()).toEqual(note.tags);
    }
  });

  it("does not duplicate an existing tag or rewrite unchanged notes", async () => {
    const ids = await makeNotes(2);
    const first = await batchUpdateTags(ids, ["shared"]); // one note already has "shared", other doesn't
    expect(first.updated.length).toBe(1);
    const again = await batchUpdateTags(ids, ["shared"]);
    expect(again.updated.length).toBe(0);
    for (const id of ids) {
      expect((await readNote(id)).tags.filter((t) => t === "shared").length).toBe(1);
    }
  });

  it("removes tags and lets remove win over add", async () => {
    const ids = await makeNotes(3);
    const { updated } = await batchUpdateTags(ids, ["alpha"], ["shared"]);
    expect(updated.length).toBe(3);
    for (const id of ids) {
      const note = await readNote(id);
      expect(note.tags).not.toContain("shared");
      expect(note.tags).toContain("alpha");
    }
  });

  it("strips # prefixes and empty names", async () => {
    const ids = await makeNotes(1);
    const { updated, missing } = await batchUpdateTags(ids, ["#work", "   ", ""], ["#shared"]);
    expect(missing).toEqual([]);
    expect(updated.length).toBe(1);
    const note = await readNote(ids[0]!);
    expect(note.tags).toContain("work");
    expect(note.tags).not.toContain("shared");
  });

  it("reports missing ids without failing the valid ones", async () => {
    const ids = await makeNotes(2);
    const { updated, missing } = await batchUpdateTags([...ids, "does-not-exist"], ["x"]);
    expect(updated.length).toBe(2);
    expect(missing).toEqual(["does-not-exist"]);
  });

  it("bumps `updated` like a normal tag edit", async () => {
    const ids = await makeNotes(1);
    const before = (await readNote(ids[0]!)).updated;
    await new Promise((r) => setTimeout(r, 10));
    await batchUpdateTags(ids, ["new-tag"]);
    const after = (await readNote(ids[0]!)).updated;
    expect(after > before).toBe(true);
  });
});

describe("batchDelete", () => {
  it("moves every listed note to the bin and reports missing", async () => {
    const ids = await makeNotes(3);
    const added = await updateNote(ids[0]!, { tags: ["keep"] }); // ensure readable note
    void added;
    const { deleted, missing } = await batchDelete([...ids, "no-such-id"]);
    expect(deleted.sort()).toEqual([...ids].sort());
    expect(missing).toEqual(["no-such-id"]);
    const trashed = await listTrashedNotes();
    expect(trashed.map((n) => n.id).sort()).toEqual([...ids].sort());
    await expect(readNote(ids[0]!)).rejects.toThrow();
  });

  it("is safe on an empty list", async () => {
    const { deleted, missing } = await batchDelete([]);
    expect(deleted).toEqual([]);
    expect(missing).toEqual([]);
  });
});