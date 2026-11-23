"""Shared-disk access to the backend's SQLite index + note files.

The worker shares the /data volume with the node backend, so it reads the
pending queue and writes results straight into the same SQLite database.
WAL mode makes cross-process access safe; the backend's triggers keep the
external-content FTS index in sync automatically.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import logging
from datetime import datetime, timezone

log = logging.getLogger("worker.db")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "index", "search.db")

# Env var is the configured default (spec: TRANSCRIPTION_MODEL); the app's
# persisted runtime settings (PUT /api/settings) override it per run.
DEFAULT_MODEL = os.environ.get("TRANSCRIPTION_MODEL", "florence-2-base")
VALID_MODELS = ("florence-2-base", "florence-2-large", "tesseract")

# On-demand voice transcription (Whisper). Model is loaded only while a voice
# note is actually being transcribed, then dropped. The backend persists the
# chosen model in settings.json; this env var is the fallback default.
WHISPER_MODEL_DEFAULT = os.environ.get("WHISPER_MODEL", "small")
VALID_WHISPER_MODELS = ("base", "small", "medium")

# File types the OCR pass can extract text from. Anything else (e.g. voice
# recordings) must stay out of the pending queue — Whisper handles those on
# demand in the voice route, and the OCR pass would otherwise stamp them
# "skipped".
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
PDF_EXT = {".pdf"}


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 15000")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def list_pending(limit: int = 20) -> list[dict]:
    con = connect()
    try:
        rows = con.execute(
            "SELECT note_id, filename FROM attachment_text "
            "WHERE status = 'pending' ORDER BY processed_at IS NOT NULL, rowid LIMIT ?",
            (limit,),
        ).fetchall()
        return [{"note_id": r["note_id"], "filename": r["filename"]} for r in rows]
    finally:
        con.close()


def resolve_attachment_path(note_id: str, filename: str) -> str | None:
    for candidate in (
        os.path.join(DATA_DIR, "notes", note_id, "attachments", filename),
        os.path.join(os.path.dirname(DB_PATH), "..", "notes", note_id, "attachments", filename),
    ):
        full = os.path.abspath(candidate)
        if os.path.isfile(full):
            return full
    return None


def resolve_note_path(note_id: str) -> str | None:
    for candidate in (
        os.path.join(DATA_DIR, "notes", note_id, "note.md"),
        os.path.join(os.path.dirname(DB_PATH), "..", "notes", note_id, "note.md"),
    ):
        full = os.path.abspath(candidate)
        if os.path.isfile(full):
            return full
    return None


def pending_count() -> int:
    con = connect()
    try:
        row = con.execute("SELECT COUNT(*) AS n FROM attachment_text WHERE status = 'pending'").fetchone()
        return int(row["n"]) if row else 0
    finally:
        con.close()


def rescan_pending() -> int:
    """Enqueue every on-disk image/PDF attachment that has no attachment_text row.

    Heals legacy notes imported before the AI feature wrote rows at upload time,
    and any attachments that slipped through while the worker was unreachable.
    Existing rows (done/skipped/failed) are never touched; only missing files
    are inserted as 'pending'.
    """
    notes_root = os.path.join(DATA_DIR, "notes")
    if not os.path.isdir(notes_root):
        log.warning("notes root %s missing — skipping attachment rescan", notes_root)
        return 0
    con = connect()
    try:
        existing = {
            (r["note_id"], r["filename"])
            for r in con.execute("SELECT note_id, filename FROM attachment_text").fetchall()
        }
        to_add: list[tuple[str, str]] = []
        for note_dir in os.scandir(notes_root):
            if not note_dir.is_dir():
                continue
            attach_dir = os.path.join(note_dir.path, "attachments")
            if not os.path.isdir(attach_dir):
                continue
            for f in os.scandir(attach_dir):
                if not f.is_file():
                    continue
                ext = os.path.splitext(f.name)[1].lower()
                if ext not in IMAGE_EXT and ext not in PDF_EXT:
                    continue
                if (note_dir.name, f.name) not in existing:
                    to_add.append((note_dir.name, f.name))
        if to_add:
            con.executemany(
                "INSERT OR IGNORE INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status) "
                "VALUES (?, ?, NULL, NULL, NULL, 'pending')",
                to_add,
            )
            con.commit()
        return len(to_add)
    finally:
        con.close()


def get_result(note_id: str, filename: str) -> dict | None:
    con = connect()
    try:
        row = con.execute(
            "SELECT note_id, filename, extracted_text, source, processed_at, status "
            "FROM attachment_text WHERE note_id = ? AND filename = ?",
            (note_id, filename),
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def write_result(note_id: str, filename: str, *, extracted_text: str | None, source: str, status: str) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT OR REPLACE INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, filename, extracted_text, source, now_iso(), status),
        )
        con.commit()
    finally:
        con.close()
    # Persist the extracted text into the note body so it lives on disk with the
    # note (and survives exports), not only inside the index DB.
    if extracted_text and extracted_text.strip():
        append_transcription_to_note(note_id, filename, extracted_text)


MARKER_TEMPLATE = "## Transcribed Data ({filename})"

# Mirrors backend computeWordCount (storage/notes.ts) for a consistent count.
_WORD_RE = re.compile(r"[\w\u00C0-\uFFFF]+(?:['\u2019\u2018-][\w\u00C0-\uFFFF]+)*", re.UNICODE)
_CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`]*`")


def count_words(body: str) -> int:
    text = _CODE_FENCE_RE.sub(" ", body)
    text = _INLINE_CODE_RE.sub(" ", text)
    # strip images/links keeping link text, and markdown markers
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>*_~|`-]", " ", text)
    return len(_WORD_RE.findall(text))


def append_transcription_to_note(note_id: str, filename: str, text: str) -> bool:
    """Append a `## Transcribed Data` section to the note body on disk.

    Frontmatter (including word_count) is preserved and the section is added at
    the end of the body. Idempotent: skips if this attachment already has a
    transcribed section, so re-running a pass never duplicates content. Returns
    True if written.
    """
    note_path = resolve_note_path(note_id)
    if note_path is None:
        return False
    try:
        with open(note_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return False

    marker = MARKER_TEMPLATE.format(filename=filename)
    if marker in content:
        return False

    front = ""
    body = content
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) == 3:
            front = parts[0] + "---" + parts[1] + "---"
            body = parts[2]

    new_body = body.rstrip("\n") + f"\n\n{marker}\n\n{text.strip()}\n"
    new_content = _sync_word_count(front, new_body)
    try:
        with open(note_path, "w", encoding="utf-8") as f:
            f.write(new_content)
    except OSError:
        return False
    return True


def _sync_word_count(front: str, body: str) -> str:
    """Rewrite `word_count:` in the preserved frontmatter block to match body."""
    if not front.startswith("---"):
        return body
    lines = front.splitlines()
    out = []
    replaced = False
    for line in lines:
        if line.startswith("word_count:"):
            out.append(f"word_count: {count_words(body)}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        # no word_count line — leave frontmatter as-is
        return front + "\n" + body
    return "\n".join(out) + body


def mark_pending(note_id: str, filename: str) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status) "
            "VALUES (?, ?, NULL, NULL, NULL, 'pending')",
            (note_id, filename),
        )
        con.commit()
    finally:
        con.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Voice transcription progress
# ---------------------------------------------------------------------------

_progress_ok = False


def ensure_progress_column() -> None:
    """Guard against the `progress` column being absent on an older DB."""
    global _progress_ok
    if _progress_ok:
        return
    con = connect()
    try:
        cols = {r["name"] for r in con.execute("PRAGMA table_info(attachment_text)").fetchall()}
        if "progress" not in cols:
            con.execute("ALTER TABLE attachment_text ADD COLUMN progress TEXT")
            con.commit()
        _progress_ok = True
    finally:
        con.close()


def update_progress(note_id: str, filename: str, *, phase: str, pct: int | None = None) -> None:
    """Create or update a 'running' progress row for a voice transcription."""
    ensure_progress_column()
    payload = json.dumps({"phase": phase, "pct": pct})
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status, progress) "
            "VALUES (?, ?, NULL, NULL, ?, 'running', ?)",
            (note_id, filename, now_iso(), payload),
        )
        con.execute(
            "UPDATE attachment_text SET progress = ?, processed_at = ?, status = 'running' "
            "WHERE note_id = ? AND filename = ?",
            (payload, now_iso(), note_id, filename),
        )
        con.commit()
    finally:
        con.close()


def mark_failed(note_id: str, filename: str, error: str) -> None:
    """Mark a voice transcription as failed (so the polling frontend terminates)."""
    ensure_progress_column()
    payload = json.dumps({"phase": "error", "pct": None, "error": error})
    con = connect()
    try:
        con.execute(
            "INSERT OR REPLACE INTO attachment_text(note_id, filename, extracted_text, source, processed_at, status, progress) "
            "VALUES (?, ?, NULL, NULL, ?, 'failed', ?)",
            (note_id, filename, now_iso(), payload),
        )
        con.commit()
    finally:
        con.close()


def read_settings() -> dict:
    import json

    path = os.path.join(DATA_DIR, "config", "settings.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        model = data.get("model", DEFAULT_MODEL)
        if model not in VALID_MODELS:
            model = DEFAULT_MODEL
        whisper_model = data.get("whisper_model", WHISPER_MODEL_DEFAULT)
        if whisper_model not in VALID_WHISPER_MODELS:
            whisper_model = WHISPER_MODEL_DEFAULT
        return {
            "enabled": bool(data.get("enabled", False)),
            "model": model,
            "whisper_model": whisper_model,
        }
    except (OSError, ValueError):
        return {
            "enabled": False,
            "model": DEFAULT_MODEL,
            "whisper_model": WHISPER_MODEL_DEFAULT,
        }