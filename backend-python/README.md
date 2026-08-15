# Zyvom Python backend

URL se video download (qualities) aur Meme transcript yahan chalte hain.

- **Port:** `5051`
- **Python:** 3.10+ (3.12 / 3.13 recommended — system 3.9 yt-dlp ke saath kaam nahi karta)
- Node backend (`5050`) isko proxy karta hai, isliye frontend same `/api` use karta hai.

## Pehli baar setup

```bash
cd backend-python
chmod +x start.sh
./start.sh
```

`start.sh` ye karta hai:

1. Python 3.12/3.13 se `.venv` banata hai (agar nahi hai)
2. `requirements.txt` install karta hai
3. Uvicorn `127.0.0.1:5051` par start karta hai

### Manual setup (bina start.sh)

```bash
cd backend-python

# Homebrew Python 3.12 use karo (macOS)
/opt/homebrew/bin/python3.12 -m venv .venv

# Windows / dusra Python 3.10+
# python3 -m venv .venv

source .venv/bin/activate          # macOS / Linux
# .venv\Scripts\activate           # Windows

pip install -r requirements.txt
```

## Har baar chalana

**Asaan tareeka:**

```bash
cd backend-python
./start.sh
```

**Manual tareeka (venv already bana ho):**

```bash
cd backend-python
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 5051 --timeout-keep-alive 300
```

Code change ke baad auto-reload chahiye ho to:

```bash
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 5051 --reload --timeout-keep-alive 300
```

Health check:

```bash
curl http://127.0.0.1:5051/api/health
```

Band karne ke liye terminal me `Ctrl+C`.

## Environment

OpenAI key Node wale `.env` se padhi jati hai:

```bash
# backend/.env
OPENAI_API_KEY=sk-...
```

Chaaho to `backend-python/.env` me bhi same key rakh sakte ho.

FFmpeg Node ke `ffmpeg-static` se milta hai. Alag se install zaroori nahi.

## Useful commands

```bash
# Dependencies dubara install
source .venv/bin/activate
pip install -r requirements.txt

# yt-dlp update
pip install -U yt-dlp

# venv delete karke fresh setup
rm -rf .venv
./start.sh
```

## API (direct Python)

| Method | Endpoint | Kaam |
| ------ | -------- | ---- |
| GET | `/api/health` | Health check |
| POST | `/api/import/info` | URL se qualities (360p / 720p / 1080p / Recommended) |
| POST | `/api/import/download` | Selected quality download (job) |
| POST | `/api/transcribe` | Video upload → exact transcript (job) |
| GET | `/api/status/:jobId` | Job progress |
| GET | `/api/download/:jobId` | Downloaded MP4 |

Frontend inhe Node `5050` ke through call karta hai. Direct Python tab use karo jab test karna ho.

## Studio ke saath kaise chalaye

Teen terminals:

```bash
# 1) Node — merge / split / speed / music / watermark
cd backend && npm start

# 2) Python — URL download + transcript
cd backend-python && ./start.sh

# 3) Frontend
cd frontend && npm run dev
```

Browser: `http://localhost:5173`

Python band ho to Meme URL/transcript fail hoga. Merge / Split / Music Node se chalte rahenge.
