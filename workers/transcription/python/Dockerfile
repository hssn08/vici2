# N07 Python GPU sidecar
# Base: CUDA 12.1 + cuDNN 8 (required by CTranslate2 / faster-whisper 1.x)
# N07 PLAN §2.1, §11.1, §14 (CUDA version pinning)

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-dev python3-pip \
    libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

# ---------------------------------------------------------------------------
# Dependency installation (separate layer for caching)
# ---------------------------------------------------------------------------
FROM base AS deps

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch==2.3.0 --index-url https://download.pytorch.org/whl/cu121 \
    && pip install --no-cache-dir -r requirements.txt

# Pre-download spaCy models (baked into image for faster cold start)
RUN python -m spacy download en_core_web_lg \
    && python -m spacy download es_core_news_md

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM base AS runtime

WORKDIR /app

# Copy installed packages from deps layer
COPY --from=deps /usr/local/lib/python3.11/dist-packages /usr/local/lib/python3.11/dist-packages
COPY --from=deps /usr/local/bin /usr/local/bin

COPY . .

ENV WHISPER_MODEL=large-v3-turbo \
    WHISPER_DEVICE=cuda \
    WHISPER_COMPUTE_TYPE=int8 \
    N07_SIDECAR_PORT=8765 \
    LOG_LEVEL=info

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8765/health')"

CMD ["python", "-m", "uvicorn", "transcription_service:app", \
     "--host", "0.0.0.0", "--port", "8765", \
     "--log-level", "info", "--workers", "1"]
