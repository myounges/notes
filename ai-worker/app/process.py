"""Per-attachment processing: route by file type, extract text, write results.

Each item is processed independently so one bad file never stops the queue.
Phase 9b covers images (OCR + caption) and PDFs (embedded text / rasterized
OCR). Unsupported types are marked skipped so the queue stays unblocked.
"""
from __future__ import annotations

import logging
import threading

from . import db, ocr

log = logging.getLogger("worker.process")

MODELS = ("florence-2-base", "florence-2-large", "tesseract")


def process_one(note_id: str, filename: str, model: str) -> dict:
    """Process a single attachment. Returns {entry, action, reason?}."""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    path = db.resolve_attachment_path(note_id, filename)
    source = model if model in MODELS else "florence-2-base"

    if path is None:
        db.write_result(note_id, filename, extracted_text=None, source=source, status="failed")
        return {"entry": f"{note_id}/{filename}", "action": "error", "reason": "file missing on disk"}

    try:
        if ext in db.IMAGE_EXT:
            from PIL import Image

            with Image.open(path) as img:
                text, source = ocr.run_image(img.convert("RGB"), model)
            status = "done" if text else "skipped"
            db.write_result(note_id, filename, extracted_text=text or None, source=source, status=status)
            reason = None if text else "no text or caption found"
            return {"entry": f"{note_id}/{filename}", "action": "imported" if text else "skipped", "reason": reason}

        if ext in db.PDF_EXT:
            text, source = ocr.ocr_pdf(path, model)
            status = "done" if text else "failed"
            db.write_result(note_id, filename, extracted_text=text or None, source=source, status=status)
            return {
                "entry": f"{note_id}/{filename}",
                "action": "imported" if text else "error",
                "reason": None if text else "no text extracted",
            }

        # Unsupported types (e.g. voice recordings). A file that already has a
        # successful transcription (Whisper voice notes) must not be clobbered
        # with "skipped" here — an OCR pass racing a voice transcription could
        # otherwise wipe its extracted text from the index.
        previous = db.get_result(note_id, filename)
        if previous and previous.get("status") == "done" and previous.get("extracted_text"):
            return {"entry": f"{note_id}/{filename}", "action": "skipped", "reason": "already transcribed"}
        db.write_result(note_id, filename, extracted_text=None, source=source, status="skipped")
        return {"entry": f"{note_id}/{filename}", "action": "skipped", "reason": "unsupported file type"}
    except Exception as exc:  # noqa: BLE001
        log.exception("Processing failed for %s/%s", note_id, filename)
        db.write_result(note_id, filename, extracted_text=None, source=source, status="failed")
        return {"entry": f"{note_id}/{filename}", "action": "error", "reason": str(exc)[:200]}


def run_pass(model: str) -> dict:
    # Self-healing: enqueue on-disk image/PDF attachments that never got an
    # attachment_text row, so a single run also drains legacy notes imported
    # before the AI feature (or added while the worker was unreachable).
    backfilled = db.rescan_pending()
    if backfilled:
        log.info("Backfilled %d on-disk attachments into the pending queue", backfilled)

    # Drain the WHOLE queue, not a fixed 20-item page: with hundreds of notes a
    # user must not have to re-trigger a pass dozens of times. Every processed
    # item leaves 'pending' (done/skipped/failed), so the loop terminates;
    # the cap is only a safety net against an unrepresentable DB error.
    processed: list[dict] = []
    while len(processed) < 50_000:
        pending = db.list_pending(limit=1000)
        if not pending:
            break
        for item in pending:
            processed.append(process_one(item["note_id"], item["filename"], model))
        if len(pending) < 1000:
            break
    imported = sum(1 for p in processed if p["action"] == "imported")
    errors = sum(1 for p in processed if p["action"] == "error")
    skipped = sum(1 for p in processed if p["action"] == "skipped")
    return {
        "queue_processed": len(processed),
        "backfilled": backfilled,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "entries": processed,
    }


# A transcription pass can take minutes on CPU, but /process used to block the
# whole pass before responding — so any other request during a run (Auto Tag,
# another "Run transcription") would time out. Passes now run in a background
# thread and /process replies immediately with "started"; /health reports busy.
_guard_lock = threading.Lock()
_pass_thread: threading.Thread | None = None


def is_busy() -> bool:
    with _guard_lock:
        return _pass_thread is not None and _pass_thread.is_alive()


def start_pass(model: str) -> dict:
    """Kick off a transcription pass in the background. Never blocks."""
    global _pass_thread
    with _guard_lock:
        if _pass_thread is not None and _pass_thread.is_alive():
            return {
                "started": False,
                "busy": True,
                "error": "A transcription pass is already running on the worker.",
            }

        def _runner() -> None:
            try:
                res = run_pass(model)
                log.info(
                    "transcription pass finished: queue=%s imported=%s skipped=%s errors=%s",
                    res.get("queue_processed"),
                    res.get("imported"),
                    res.get("skipped"),
                    res.get("errors"),
                )
            except Exception:  # noqa: BLE001
                log.exception("background transcription pass failed")

        _pass_thread = threading.Thread(target=_runner, name="transcription-pass", daemon=True)
        _pass_thread.start()
        return {"started": True, "busy": True, "model": model}