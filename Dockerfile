# Synthea Simulation — single-container web deployment (frontend served by the FastAPI backend).
# Build:  docker build -t synthea .
# Run:    docker run -p 8000:8000 -v synthea-data:/data -e SYNTHEA_PASSWORD=... -e SYNTHEA_SECRET=... synthea

# ---- 1) build the React frontend
FROM node:22-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build

# ---- 2) Python runtime
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    SYNTHEA_DATA_DIR=/data PORT=8000
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=web /src/frontend/dist /app/frontend/dist
RUN useradd --create-home synthea && mkdir -p /data && chown -R synthea /data
USER synthea
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health')"
# one worker: the SQLite store and background jobs live in this process
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
