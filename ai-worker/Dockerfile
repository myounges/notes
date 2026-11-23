FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    TRANSCRIPTION_MODEL=florence-2-base \
    MODEL_CACHE_DIR=/models \
    HF_HOME=/models \
    HF_HUB_CACHE=/models

WORKDIR /srv/worker

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tesseract-ocr \
       tesseract-ocr-eng \
       libgl1 \
       libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# CPU-only PyTorch from the official CPU wheel index—avoids the ~5.5GB CUDA
# stack (nvidia libs + triton) that the default wheel pulls in.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

# transformers 5.x raises AttributeError on Florence-2's remote config
# (Florence2LanguageConfig.forced_bos_token_id); stay on the 4.x line.
# einops/timm are runtime deps of the Florence-2 modeling file.
RUN pip install --no-cache-dir "transformers>=4.45,<5" einops timm

# faster-whisper (CTranslate2 + PyAV + onnxruntime) powers on-demand voice
# transcription. Kept in its OWN layer so its heavy deps don't invalidate the
# torch/transformers cache (build-layer rule: no merging into requirements.txt).
RUN pip install --no-cache-dir faster-whisper

COPY app ./app

EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health/simple')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
