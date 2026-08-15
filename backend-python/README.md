# Arjuga Reels Maker — Python backend

URL download (yt-dlp) and transcription run here.

- **Port:** `5051`
- **Python:** 3.10+ (3.12 / 3.13 recommended)
- Node (`5050`) proxies these routes, so the frontend still uses `/api`.

## First-time setup

```bash
cd backend-python
chmod +x start.sh
./start.sh
```

`start.sh` creates `.venv` with Homebrew Python 3.12/3.13, installs
`requirements.txt`, and starts Uvicorn.

### Manual

```bash
cd backend-python
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
cd backend-python
./start.sh
```

Or:

```bash
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 5051 --timeout-keep-alive 300
```

```bash
curl http://127.0.0.1:5051/api/health
```

Stop with `Ctrl+C`.

## Environment

OpenAI key is read from `backend/.env` (or `backend-python/.env`):

```bash
OPENAI_API_KEY=sk-...
```

Used only when YouTube captions are missing (transcribe fallback).
Meme category analysis runs on Node, not here.

## API (direct)

| Method | Endpoint | What it does |
| --- | --- | --- |
| GET | `/api/health` | Health |
| POST | `/api/import/info` | List qualities for a URL |
| POST | `/api/import/download` | Download one quality (job) |
| POST | `/api/import/transcript` | YouTube captions |
| POST | `/api/transcribe` | Upload → transcript (job) |
| GET | `/api/status/:jobId` | Progress |
| GET | `/api/download/:jobId` | File |

Downloads overwrite `output/zyvom-import-latest.mp4`. Uploads live in a
per-job folder and are deleted when the job finishes.

## Studio trio

```bash
cd backend && npm start
cd backend-python && ./start.sh
cd frontend && npm run dev
```

Browser: [http://localhost:5173](http://localhost:5173)
