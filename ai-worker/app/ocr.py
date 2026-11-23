"""OCR + captioning for images and PDFs (Phase 9b).

Florence-2 runs its `<OCR>` task prompt for text-bearing images/PDF pages and
falls back to `<DETAILED_CAPTION>` for photos (images whose OCR yields little
text), so scanned pages are searchable by extracted text and photos are
searchable by caption like "a street with cars passing and pedestrians
walking". Tesseract mode is pure OCR (no captioning).

Everything sits behind the small ``run_image(image, model) -> (text, source)``
interface so a different VLM can be swapped in later behind one adapter
without touching the scheduler, API, or search-indexing code.
"""
from __future__ import annotations

import io
import logging
import os
import re

log = logging.getLogger("worker.ocr")

FLORENCE_IDS = {
    "florence-2-base": "microsoft/Florence-2-base",
    "florence-2-large": "microsoft/Florence-2-large",
}

# Model weights live in /models (shared volume); honor an override if given.
os.environ.setdefault("HF_HOME", os.environ.get("MODEL_CACHE_DIR", "/models"))
os.environ.setdefault("HF_HUB_CACHE", os.environ.get("MODEL_CACHE_DIR", "/models"))

_pipe = None
_loaded_model_id: str | None = None


def _load_florence(model: str):
    """Lazy, cached load so /health stays light and the first /process call
    pays the one-time download+load cost."""
    global _pipe, _loaded_model_id
    model_id = FLORENCE_IDS.get(model)
    if not model_id:
        return None
    if _pipe is not None and _loaded_model_id == model_id:
        return _pipe
    try:
        from transformers import AutoModelForCausalLM, AutoProcessor

        log.info("Loading Florence-2 %s (first run downloads weights into %s)", model, os.environ["HF_HOME"])
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        # attn_implementation="eager": Florence-2's remote modeling file predates
        # the SDPA dispatch check and crashes in model init otherwise.
        model_obj = AutoModelForCausalLM.from_pretrained(
            model_id, trust_remote_code=True, attn_implementation="eager"
        )
        _pipe = (processor, model_obj)
        _loaded_model_id = model_id
        return _pipe
    except Exception as exc:  # noqa: BLE001 - fall back to tesseract
        log.warning("Florence-2 unavailable (%s); falling back to tesseract", exc)
        _pipe = False
        _loaded_model_id = model_id
        return None


def _run_florence(task_prompt: str, processor, model, image) -> str:
    inputs = processor(text=task_prompt, images=image, return_tensors="pt")
    generated = model.generate(
        input_ids=inputs["input_ids"],
        pixel_values=inputs["pixel_values"],
        max_new_tokens=1024,
        num_beams=3,
        do_sample=False,
        # Florence-2's remote modeling code predates the transformers Cache
        # API and crashes when a Cache object is passed; disable it.
        use_cache=False,
    )
    del inputs
    text = processor.batch_decode(generated, skip_special_tokens=False)[0]
    for token in (task_prompt, "<pad>", "</s>", "<s>"):
        text = text.replace(token, "")
    return text.strip()


def florence_ocr_image(processor, model, image) -> str:
    return _run_florence("<OCR>", processor, model, image)


def florence_caption_image(processor, model, image) -> str:
    return _run_florence("<DETAILED_CAPTION>", processor, model, image)


def tesseract_ocr_image(image) -> str:
    import pytesseract

    return pytesseract.image_to_string(image).strip()


def run_image(image, model: str) -> tuple[str, str]:
    """OCR or caption a single image. Returns (text, source).

    Text-bearing images (documents, screenshots, signage) return their OCR
    text. Photos without much text (a street scene, object, landscape) instead
    get a short caption like "a city street with cars passing and pedestrians
    walking". The OCR result decides which is which: if it yields enough
    letter-words the image is text; otherwise it is treated as a photo.
    """
    if model != "tesseract":
        pipe = _load_florence(model)
        if pipe and pipe is not False:
            try:
                processor, florence = pipe
                ocr = florence_ocr_image(processor, florence, image)
                if _is_text_image(ocr):
                    return ocr, model
                caption = florence_caption_image(processor, florence, image)
                if caption:
                    return caption, model
            except Exception as exc:  # noqa: BLE001
                log.warning("Florence-2 inference failed, falling back: %s", exc)
    text = tesseract_ocr_image(image)
    return text, "tesseract"


_LETTER_WORD_RE = re.compile(r"[A-Za-z\u00C0-\u024F]{2,}")


def _is_text_image(ocr_text: str) -> bool:
    """True when OCR produced enough real words to be treated as a text image.

    Photos usually leave OCR nearly empty or with a few stray words (signs,
    logos), so requiring >= 5 letter-words sends those to captioning instead.
    """
    return len(_LETTER_WORD_RE.findall(ocr_text)) >= 5


def ocr_pdf(path: str, model: str) -> tuple[str, str]:
    """Extract text/captions from a PDF.

    Pages with embedded text use it directly (cleaner than re-OCRing); pages
    without it (scanned PDFs) get rasterized with pypdfium2 and run through
    the same OCR/caption pipeline.
    """
    source = f"{model}+pdf"
    try:
        from pypdf import PdfReader
    except ImportError:
        raise
    try:
        reader = PdfReader(path)
    except Exception as exc:  # noqa: BLE001
        log.warning("Couldn't open PDF %s: %s", path, exc)
        return "", source

    results: list[tuple[str, str]] = []
    for page in reader.pages:
        embedded = (page.extract_text() or "").strip()
        # Mature check: rasterize only when there's no usable embedded text.
        if len(embedded) >= 20:
            results.append((embedded, f"pypdf+{model}"))
            continue
        try:
            raster = _rasterize_pdf_page(path, page.page_number - 1)
            for raster_page in raster:
                text, _ = run_image(raster_page, model)
                if text:
                    results.append((text, source))
        except Exception as exc:  # noqa: BLE001
            log.warning("PDF rasterize failed for %s page %s: %s", path, page.page_number, exc)

    combined = "\n\n".join(text for text, _src in results)
    return combined, source


def _rasterize_pdf_page(path: str, page_index: int) -> list:
    import pypdfium2 as pdfium
    from PIL import Image

    doc = pdfium.PdfDocument(path)
    try:
        page = doc[page_index]
        bitmap = page.render(scale=2.0)  # ~144 dpi
        image = bitmap.to_pil().convert("RGB")
        return [image]
    finally:
        doc.close()


def model_loaded(model: str) -> bool:
    if model == "tesseract":
        try:
            import pytesseract  # noqa: F401

            return True
        except ImportError:
            return False
    pipe = _load_florence(model)
    return pipe is not None and pipe is not False