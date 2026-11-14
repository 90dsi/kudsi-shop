FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NEXUSKEYS_DATA_DIR=/data \
    PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /data

EXPOSE 8000

# One process only: SQLite + the payment watcher must not run twice.
CMD ["sh", "-c", "waitress-serve --host=0.0.0.0 --port=${PORT} --threads=8 app:app"]
