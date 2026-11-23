import crypto from "node:crypto";
import { listNoteIds, readNote, patchNoteMeta, type Note } from "../storage/notes.js";
import { listAttachmentText, indexNote } from "../storage/index.js";

export interface AutotagResult {
  tag: string;
  score: number;
  method: "keyword" | "vector";
}

export interface AutotagSummary {
  /** Notes whose content was sent to the classifier this run. */
  checked: number;
  /** Checked notes that gained at least one auto tag. */
  tagged: number;
  /** Checked notes that produced no confident tag. */
  untagged: number;
  /** Notes skipped because their content hash is unchanged since last run. */
  skipped: number;
  /** Total notes on disk. */
  total: number;
  /** Tags actually applied across all notes (deduped). */
  appliedTags: string[];
}

type WorkerCall = (texts: string[]) => Promise<AutotagResult[][]>;

const BATCH_SIZE = 40;
const WORKER_TIMEOUT_MS = 60 * 60 * 1000;

/** Strip markdown syntax so the classifier sees plain words, not `**`, `#`, links. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, " ")
    .replace(/[*>_~|#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Default worker call (override in tests to avoid the network). */
async function callWorker(workerUrl: string, texts: string[]): Promise<AutotagResult[][]> {
  const res = await fetch(`${workerUrl}/autotag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`worker /autotag responded ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { results: Array<{ tags: Array<Record<string, unknown>> }> };
  return data.results.map((r) =>
    (r.tags ?? [])
      .filter((t) => typeof t.tag === "string" && t.tag)
      .map((t) => ({
        tag: t.tag as string,
        score: typeof t.score === "number" ? t.score : 0,
        method: t.method === "keyword" ? ("keyword" as const) : ("vector" as const),
      })),
  );
}

/** Read every note's attachments and concatenate their extracted text. */
async function attachmentTextsByNote(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const row of listAttachmentText()) {
    const t = row.extracted_text?.trim();
    if (!t) continue;
    map.set(row.note_id, `${map.get(row.note_id) ?? ""}\n${t}`);
  }
  return map;
}

/** Content text the classifier sees for a note: title + body + attachment text. */
async function buildNoteText(
  note: Note,
  attaching: Map<string, string>,
): Promise<{ text: string; hash: string }> {
  const extract = attaching.get(note.id) ?? "";
  const text = [note.title, plainText(note.body), extract.trim()].join("\n").trim();
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  return { text, hash };
}

interface BatchItem {
  id: string;
  text: string;
  hash: string;
  tags: string[];
}

/** Read every note, compute its classification fingerprint, keep only stale ones. */
export async function buildAutotagBatch(): Promise<{ batch: BatchItem[]; skipped: number; total: number }> {
  const ids = await listNoteIds();
  const attachMap = await attachmentTextsByNote();
  const batch: BatchItem[] = [];
  let skipped = 0;
  let total = 0;
  for (const id of ids) {
    total++;
    let note: Note;
    try {
      note = await readNote(id);
    } catch {
      continue; // unreadable/corrupt note — don't let it block a run
    }
    const { text, hash } = await buildNoteText(note, attachMap);
    if (note.auto_tag_hash === hash) {
      skipped++;
      continue;
    }
    batch.push({ id, text, hash, tags: note.tags });
  }
  return { batch, skipped, total };
}

/** Run the full pass: collect, classify, apply. Returns a run summary. */
export async function runAutotag(
  workerUrl: string,
  workerCall: WorkerCall = (texts) => callWorker(workerUrl, texts),
): Promise<AutotagSummary> {
  const { batch, skipped, total } = await buildAutotagBatch();
  const checked = batch.length;
  let tagged = 0;
  let untagged = 0;
  const appliedTags = new Set<string>();

  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const slice = batch.slice(i, i + BATCH_SIZE);
    const results = await workerCall(slice.map((b) => b.text));
    for (let j = 0; j < slice.length; j++) {
      const item = slice[j];
      const preds = results[j] ?? [];
      const newTags = preds
        .map((p) => p.tag)
        .filter((t) => !item.tags.includes(t));
      if (newTags.length > 0) {
        await patchNoteMeta(item.id, {
          tags: [...item.tags, ...newTags],
          auto_tag_hash: item.hash,
          auto_tagged_at: new Date().toISOString(),
        });
        for (const t of newTags) appliedTags.add(t);
        tagged++;
      } else {
        await patchNoteMeta(item.id, {
          auto_tag_hash: item.hash,
          auto_tagged_at: new Date().toISOString(),
        });
        untagged++;
      }
    }
  }

  // Keep the search index's tag column in sync with the notes we touched.
  for (const item of batch) {
    try {
      indexNote(await readNote(item.id));
    } catch {
      // note vanished while tagging — ignore
    }
  }

  return { checked, tagged, untagged, skipped, total, appliedTags: [...appliedTags].sort() };
}