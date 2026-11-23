"""On-demand voice transcription (Whisper via faster-whisper).

The model is loaded lazily on the *first* transcription request and dropped
as soon as that request finishes, so an idle worker holds no Whisper state in
memory. Languages are auto-detected and restricted to English/Spanish to avoid
transcribing a note in an unexpected language (per product requirement).

Runs standalone from the OCR transcription pass: a pass and a voice
transcription may happen at the same time (they only contend for CPU). A
mutex-free busy flag keeps two concurrent /transcribe-voice calls from
double-loading the model.

Long transcriptions run in the background (the backend responds 202 and the
client polls). Progress is streamed through the attachment_text row's
`progress` column ({phase, pct}), and every terminal path either writes the
transcript (done) or marks the row failed so the client stops polling.
"""
from __future__ import annotations

import gc
import logging
import threading

from . import db

log = logging.getLogger("worker.transcribe")

SUPPORTED_LANGS = {"en": "English", "es": "Spanish"}

_whisper = None
_whisper_name: str | None = None
_busy = False
_busy_lock = threading.Lock()


def is_busy() -> bool:
    with _busy_lock:
        return _busy


def _unload() -> None:
    """Drop the loaded model and release what we can back to the OS.

    CTranslate2 may keep some allocator memory mapped after this, but the
    heap is returned to the allocator for reuse.
    """
    global _whisper, _whisper_name
    _whisper = None
    _whisper_name = None
    gc.collect()


def _load(name: str):
    """Load (or reuse already-loaded) the Whisper model. First use downloads
    the model into HF_HOME (= /models on the worker) and converts it to
    CTranslate2 format — subsequent loads are fast."""
    global _whisper, _whisper_name
    if _whisper is not None and _whisper_name == name:
        return _whisper
    _unload()
    from faster_whisper import WhisperModel

    log.info("Loading Whisper model %s (CPU, int8) — first use may download it", name)
    _whisper = WhisperModel(name, device="cpu", compute_type="int8")
    _whisper_name = name
    return _whisper


def transcribe(note_id: str, filename: str, model: str) -> dict:
    """Transcribe a voice attachment. Returns a result dict (never raises).

    Keys: transcribed, busy, language, text, duration, error.
    """
    global _busy
    with _busy_lock:
        if _busy:
            return {
                "transcribed": False,
                "busy": True,
                "language": None,
                "text": None,
                "error": "A voice transcription is already running on the worker.",
            }
        _busy = True
    try:
        path = db.resolve_attachment_path(note_id, filename)
        if path is None:
            return {
                "transcribed": False,
                "busy": False,
                "language": None,
                "text": None,
                "error": "Voice note file was not found on the worker.",
            }

        # Every downstream path either reports phase/pct progress or marks the
        # row failed, so the polling frontend never waits forever.
        db.update_progress(note_id, filename, phase="loading")
        whisper = _load(model)
        from faster_whisper.audio import decode_audio

        # Decode once (PyAV, accepts webm/ogg/m4a) and reuse the same waveform
        # for language detection AND transcription — detect_language in this
        # faster-whisper version does not decode a path itself.
        db.update_progress(note_id, filename, phase="decoding")
        waveform = decode_audio(path)
        db.update_progress(note_id, filename, phase="detecting")
        language, _probability, _all_probs = whisper.detect_language(waveform)
        if language not in SUPPORTED_LANGS:
            shown = SUPPORTED_LANGS.get(language, language)
            db.mark_failed(
                note_id,
                filename,
                f"Detected {shown} — only English and Spanish voice notes are transcribed.",
            )
            return {
                "transcribed": False,
                "busy": False,
                "language": language,
                "text": None,
                "error": f"Detected {shown} — only English and Spanish voice notes are transcribed.",
            }

        db.update_progress(note_id, filename, phase="transcribing", pct=0)
        segments, info = whisper.transcribe(waveform, language=language, beam_size=5, vad_filter=True)
        duration = round(float(getattr(info, "duration", 0.0) or 0.0), 2)
        if duration <= 0:
            # decode_audio returns a mono 16 kHz waveform; duration is a fallback
            # if the transcription info isn't populated yet.
            duration = round(len(waveform) / 16000, 2)
        parts: list[str] = []
        for seg in segments:
            if seg.end and duration > 0:
                db.update_progress(
                    note_id,
                    filename,
                    phase="transcribing",
                    pct=min(99, int(seg.end / duration * 100)),
                )
            if seg.text and seg.text.strip():
                parts.append(seg.text.strip())
        text = "\n".join(parts)
        if not text.strip():
            db.mark_failed(note_id, filename, "No speech detected in this recording.")
            return {
                "transcribed": False,
                "busy": False,
                "language": language,
                "text": None,
                "error": "No speech detected in this recording.",
            }

        # Same path as OCR results: persisted + searchable + appended to the
        # note body under "## Transcribed Data"; Auto Tag reads it too.
        db.write_result(
            note_id,
            filename,
            extracted_text=text,
            source=f"whisper-{model}:{language}",
            status="done",
        )
        log.info("Transcribed %s/%s (%s, %ss)", note_id, filename, language, duration)
        return {
            "transcribed": True,
            "busy": False,
            "language": language,
            "text": text,
            "duration": duration,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        log.exception("Whisper transcription failed for %s/%s", note_id, filename)
        db.mark_failed(note_id, filename, f"Whisper failed: {str(exc)[:200]}")
        return {
            "transcribed": False,
            "busy": False,
            "language": None,
            "text": None,
            "error": f"Whisper failed: {str(exc)[:200]}",
        }
    finally:
        _unload()
        with _busy_lock:
            _busy = False