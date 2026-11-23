"""AI worker sidecar (Phase 9b): OCR + image captioning for photos and PDFs.

Runs as a FastAPI service on port 8000 inside the compose network. It shares
/data with the backend and reads settings.json there; models are cached in
the /models volume. Driven by the backend's scheduler (POST /process) or a
manual pass from the Settings dialog.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from pydantic import BaseModel

from . import db, ocr

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("worker")

app = FastAPI(title="notes ai-worker", version="0.1.0")


class ProcessRequest(BaseModel):
    settings: dict | None = None


class AutotagRequest(BaseModel):
    texts: list[str]


class VoiceTranscribeRequest(BaseModel):
    note_id: str
    filename: str
    model: str | None = None


class Health(BaseModel):
    status: str
    model: str
    model_loaded: bool
    pending: int
    busy: bool
    whisper_busy: bool = False


@app.get("/health", response_model=Health)
def health() -> Health:
    from . import process
    from . import transcribe

    settings = db.read_settings()
    return Health(
        status="ok",
        model=settings["model"],
        model_loaded=ocr.model_loaded(settings["model"]),
        pending=db.pending_count(),
        busy=process.is_busy(),
        whisper_busy=transcribe.is_busy(),
    )


@app.post("/process")
def process(req: ProcessRequest) -> dict:
    from . import process

    body = req.settings or {}
    settings = db.read_settings()
    model = body.get("model") or settings["model"]
    if model not in db.VALID_MODELS:
        model = settings["model"]
    log.info("Kicking off transcription pass with model=%s", model)
    return process.start_pass(model)


@app.post("/autotag")
def autotag(req: AutotagRequest) -> dict:
    from . import tagging  # local import; model only loads on first classify

    tags = tagging.classify_many(req.texts)
    return {"results": [{"tags": ts} for ts in tags]}


@app.post("/transcribe-voice")
def transcribe_voice(req: VoiceTranscribeRequest) -> dict:
    from . import transcribe  # local import; faster-whisper only loads on demand

    settings = db.read_settings()
    model = req.model or settings.get("whisper_model") or db.WHISPER_MODEL_DEFAULT
    if model not in db.VALID_WHISPER_MODELS:
        model = "small"
    return transcribe.transcribe(req.note_id, req.filename, model)


@app.get("/health/simple")
def health_simple() -> dict:
    return {"status": "ok"}