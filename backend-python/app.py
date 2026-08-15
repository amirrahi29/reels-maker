"""
Zyvom Python backend — URL import (yt-dlp) + exact transcription.
Node (port 5050) still owns merge / split / music / speed / watermark.
This service runs on 5051; Node proxies the meme/import routes here.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request as UrlRequest, urlopen

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from openai import OpenAI
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / "backend" / ".env")

UPLOAD_DIR = ROOT / "uploads"
OUTPUT_DIR = ROOT / "output"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
IMPORT_OUTPUT_NAME = "zyvom-import-latest.mp4"


def clear_workdir(folder: Path, keep: set[str] | None = None) -> None:
    """Keep only .gitkeep so generated files replace instead of piling up."""
    retain = keep or {".gitkeep"}
    if not folder.exists():
        return
    for item in folder.iterdir():
        if item.name in retain:
            continue
        try:
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
        except OSError:
            pass


clear_workdir(UPLOAD_DIR)
clear_workdir(OUTPUT_DIR)

IMPORT_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240]
TRANSCRIBE_CHUNK_SEC = 12 * 60
TRANSCRIBE_PROMPT = (
    "Transcribe exactly what is spoken, word for word. "
    "Do not summarize or paraphrase. Keep the original spoken language. "
    "Add punctuation and paragraph breaks only."
)

jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()

app = FastAPI(title="Zyvom Python Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    msg = "Invalid request."
    for err in exc.errors():
        loc = err.get("loc") or []
        if "video" in loc:
            msg = "Upload a video to transcribe."
            break
        if "url" in loc:
            msg = "Paste a valid public video URL."
            break
    return JSONResponse(status_code=400, content={"error": msg})


def ffmpeg_bin() -> str:
    env = os.environ.get("FFMPEG_PATH")
    if env and Path(env).exists():
        return env
    bundled = (
        ROOT.parent
        / "backend"
        / "node_modules"
        / "ffmpeg-static"
        / "ffmpeg"
    )
    if bundled.exists():
        return str(bundled)
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise RuntimeError("FFmpeg not found")


def parse_import_url(raw: str | None) -> str | None:
    try:
        parsed = urlparse(str(raw or "").strip())
    except Exception:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if (
        host in {"localhost", "0.0.0.0", "[::1]"}
        or host.endswith(".local")
        or re.match(r"^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)", host)
    ):
        return None
    return parsed.geturl()


def format_bytes_label(bytes_n: Any) -> str | None:
    try:
        n = float(bytes_n)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if n >= 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024 * 1024):.1f} GB"
    if n >= 1024 * 1024:
        return f"{max(1, round(n / (1024 * 1024)))} MB"
    return f"{max(1, round(n / 1024))} KB"


def safe_download_name(title: str, ext: str = "mp4") -> str:
    base = re.sub(r"[^\w\s.-]+", "", title or "video").strip()
    base = re.sub(r"\s+", "-", base)[:80] or "video"
    return f"{base}.{ext}"


def quality_selector(height: int) -> str:
    return "/".join(
        [
            f"bv*[height={height}][ext=mp4][protocol^=http][protocol!*=dash]+ba[ext=m4a][protocol^=http][protocol!*=dash]",
            f"bv*[height={height}][protocol^=http][protocol!*=dash]+ba[protocol^=http][protocol!*=dash]",
            f"b[height={height}][ext=mp4][protocol^=http][protocol!*=dash]",
            f"bv*[height={height}][ext=mp4]+ba[ext=m4a]",
            f"bv*[height={height}]+ba",
            f"b[height={height}][ext=mp4]",
            f"b[height={height}]",
            f"bv*[height<={height}]+ba",
            f"b[height<={height}]",
        ]
    )


def build_import_qualities(info: dict[str, Any]) -> list[dict[str, Any]]:
    by_height: dict[int, dict[str, Any]] = {}
    for fmt in info.get("formats") or []:
        height = fmt.get("height")
        try:
            height = int(height)
        except (TypeError, ValueError):
            continue
        if height < 144:
            continue
        if fmt.get("has_drm"):
            continue
        vcodec = fmt.get("vcodec") or "none"
        if vcodec == "none":
            continue
        has_audio = bool(fmt.get("acodec") and fmt.get("acodec") != "none")
        ext = str(fmt.get("ext") or "").lower()
        score = (
            (80 if has_audio else 0)
            + (25 if ext == "mp4" else 8 if ext == "webm" else 0)
            + (float(fmt.get("tbr") or fmt.get("vbr") or 0) / 80)
        )
        prev = by_height.get(height)
        if not prev or score > prev["score"]:
            by_height[height] = {
                "height": height,
                "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
                "score": score,
            }

    qualities: list[dict[str, Any]] = []
    used: set[int] = set()
    for h in IMPORT_HEIGHTS:
        if h not in by_height or h in used:
            continue
        used.add(h)
        q = by_height[h]
        qualities.append(
            {
                "id": str(h),
                "label": f"{h}p",
                "height": h,
                "ext": "mp4",
                "sizeLabel": format_bytes_label(q["filesize"]),
                "selector": quality_selector(h),
            }
        )

    for h, q in sorted(by_height.items(), key=lambda item: item[0], reverse=True):
        if h in used:
            continue
        used.add(h)
        qualities.append(
            {
                "id": str(h),
                "label": f"{h}p",
                "height": h,
                "ext": "mp4",
                "sizeLabel": format_bytes_label(q["filesize"]),
                "selector": quality_selector(h),
            }
        )

    qualities.sort(key=lambda item: item["height"], reverse=True)
    rec = next((q for q in qualities if q["height"] == 720), None)
    rec = rec or next((q for q in qualities if q["height"] <= 1080), None)
    rec = rec or (qualities[0] if qualities else None)
    if rec:
        qualities.insert(
            0,
            {
                **rec,
                "id": "recommended",
                "label": "Recommended",
                "note": f"{rec['height']}p MP4",
                "recommended": True,
            },
        )
    return qualities


def clean_ytdlp_error(err: BaseException) -> str:
    text = str(err) or "Could not read this URL."
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    text = re.sub(r"\[(?:\d+;)*\d+m", "", text)
    text = re.sub(r"^ERROR:\s*", "", text, flags=re.I).strip()
    lower = text.lower()
    if "not available on this app" in lower or "latest version of youtube" in lower:
        return (
            "YouTube blocked this request. Restart backend-python so it can "
            "use the latest yt-dlp, then try Read URL again."
        )
    if "drm" in lower:
        return "This video is DRM protected, so it cannot be downloaded."
    if "proxyerror" in lower or "tunnel connection failed" in lower:
        return "Could not reach YouTube. Check the network and try Read URL again."
    if "403" in lower or "forbidden" in lower:
        return (
            "YouTube blocked the video file (403). Try Recommended or 360p, "
            "or Read URL again in a minute."
        )
    if "sign in" in lower or "confirm your age" in lower:
        return "This video needs a signed-in YouTube session. Try another public URL."
    return text[:280]


def ytdlp_base_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "no_color": True,
        "no_check_certificate": True,
        "retries": 8,
        "fragment_retries": 8,
        "extractor_retries": 3,
        "file_access_retries": 3,
        "socket_timeout": 30,
        "concurrent_fragment_downloads": 1,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/128.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
        "ffmpeg_location": str(Path(ffmpeg_bin()).parent),
        # Empty string disables inherited HTTP_PROXY, which breaks YouTube.
        "proxy": (os.environ.get("YTDLP_PROXY") or "").strip(),
    }
    node = shutil.which("node")
    if node:
        opts["js_runtimes"] = {"node": {"path": node}}
    cookies_file = (os.environ.get("YTDLP_COOKIES_FILE") or "").strip()
    if cookies_file and Path(cookies_file).exists():
        opts["cookiefile"] = cookies_file
    cookies_from = (os.environ.get("YTDLP_COOKIES_FROM_BROWSER") or "").strip()
    if cookies_from:
        opts["cookiesfrombrowser"] = (cookies_from,)
    return opts


def probe_import_url(url: str) -> dict[str, Any]:
    import yt_dlp

    opts = ytdlp_base_opts()
    opts["skip_download"] = True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as err:
        raise RuntimeError(clean_ytdlp_error(err)) from err
    if not info:
        raise RuntimeError("Could not read this URL.")
    qualities = build_import_qualities(info)
    if not qualities:
        raise RuntimeError("No downloadable MP4 qualities were found for this URL.")
    thumbs = info.get("thumbnails") or []
    return {
        "title": str(info.get("title") or "Video"),
        "thumbnail": info.get("thumbnail") or (thumbs[0].get("url") if thumbs else ""),
        "duration": float(info.get("duration") or 0),
        "qualities": qualities,
    }


def download_import(url: str, selector: str, output_path: Path) -> None:
    import yt_dlp

    fallbacks = [
        selector,
        "bv*[protocol^=http][protocol!*=dash]+ba[protocol^=http][protocol!*=dash]/b[protocol^=http][protocol!*=dash]",
        "bv*+ba/b",
        "best",
    ]
    client_sets = [
        ["default"],
        ["tv", "web", "mweb"],
        ["default", "-android_sdkless"],
    ]
    last_err: Exception | None = None
    for clients in client_sets:
        for index, fmt in enumerate(fallbacks):
            opts = ytdlp_base_opts()
            opts["extractor_args"] = {"youtube": {"player_client": clients}}
            opts.update(
                {
                    "format": fmt,
                    "merge_output_format": "mp4",
                    "outtmpl": str(output_path.with_name(output_path.stem + ".%(ext)s")),
                    "restrictfilenames": True,
                    "overwrites": True,
                    "check_formats": index > 0,
                }
            )
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.download([url])
                last_err = None
                break
            except Exception as err:
                last_err = err
                text = str(err).lower()
                retryable = any(
                    token in text
                    for token in (
                        "403",
                        "forbidden",
                        "unavailable",
                        "requested format",
                        "drm",
                    )
                )
                if not retryable:
                    raise RuntimeError(clean_ytdlp_error(err)) from err
        if last_err is None:
            break
    if last_err:
        raise RuntimeError(clean_ytdlp_error(last_err)) from last_err
    if output_path.exists():
        return
    matches = list(output_path.parent.glob(output_path.stem + ".*"))
    mp4 = next((p for p in matches if p.suffix.lower() == ".mp4"), None)
    if mp4:
        mp4.rename(output_path)
        return
    if matches:
        matches[0].rename(output_path)
        return
    raise RuntimeError("The selected quality could not be saved as MP4.")


def probe_duration(path: Path) -> float:
    try:
        out = subprocess.check_output(
            [ffmpeg_bin(), "-hide_banner", "-i", str(path)],
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.CalledProcessError as err:
        out = err.output or ""
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not match:
        return 0
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def has_audio_stream(path: Path) -> bool:
    try:
        out = subprocess.check_output(
            [ffmpeg_bin(), "-hide_banner", "-i", str(path)],
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.CalledProcessError as err:
        out = err.output or ""
    return "Audio:" in out


def extract_speech_audio(
    input_path: Path, output_path: Path, start: float | None = None, duration: float | None = None
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg_bin(), "-y"]
    if start and start > 0:
        cmd += ["-ss", str(start)]
    cmd += ["-i", str(input_path)]
    if duration and duration > 0:
        cmd += ["-t", str(duration)]
    cmd += [
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not output_path.is_file() or output_path.stat().st_size < 64:
        raise RuntimeError("Could not extract audio from this video.")


def transcribe_with_openai(audio_path: Path, language: str) -> dict[str, Any]:
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Add OPENAI_API_KEY to backend/.env to transcribe videos.")
    client = OpenAI(api_key=api_key)

    def call(model: str, response_format: str) -> Any:
        kwargs: dict[str, Any] = {
            "model": model,
            "file": audio_path.open("rb"),
            "prompt": TRANSCRIBE_PROMPT,
            "response_format": response_format,
        }
        if language and language != "auto":
            kwargs["language"] = language
        try:
            return client.audio.transcriptions.create(**kwargs)
        finally:
            kwargs["file"].close()

    try:
        data = call("gpt-4o-transcribe", "json")
        return {
            "text": str(getattr(data, "text", "") or "").strip(),
            "language": getattr(data, "language", language) or "",
            "segments": list(getattr(data, "segments", None) or []),
            "model": "gpt-4o-transcribe",
        }
    except Exception as err:
        if "401" in str(err) or "403" in str(err):
            raise
        data = call("whisper-1", "verbose_json")
        segs = []
        for s in getattr(data, "segments", None) or []:
            if isinstance(s, dict):
                segs.append(s)
            else:
                segs.append(
                    {
                        "start": getattr(s, "start", 0),
                        "end": getattr(s, "end", 0),
                        "text": getattr(s, "text", ""),
                    }
                )
        return {
            "text": str(getattr(data, "text", "") or "").strip(),
            "language": getattr(data, "language", language) or "",
            "segments": segs,
            "model": "whisper-1",
        }


def transcribe_video_file(
    video_path: Path,
    language: str,
    on_progress,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    if not has_audio_stream(video_path):
        raise RuntimeError("This video has no audio to transcribe.")
    duration = probe_duration(video_path)
    on_progress(18, "extracting audio")

    speech = (work_dir or UPLOAD_DIR) / "zyvom-speech-latest.mp3"
    offsets: list[float] = [0.0]
    if duration > TRANSCRIBE_CHUNK_SEC + 20:
        offsets = []
        t = 0.0
        while t < duration - 0.05:
            offsets.append(t)
            t += min(TRANSCRIBE_CHUNK_SEC, duration - t)

    parts = []
    try:
        for i, offset in enumerate(offsets):
            length = min(TRANSCRIBE_CHUNK_SEC, max(0.4, duration - offset)) if duration else None
            on_progress(
                22 + round((i / max(len(offsets), 1)) * 70),
                f"transcribing {i + 1}/{len(offsets)}" if len(offsets) > 1 else "transcribing",
            )
            extract_speech_audio(video_path, speech, offset, length)
            result = transcribe_with_openai(speech, language)
            result["offset"] = offset
            parts.append(result)
            speech.unlink(missing_ok=True)
    finally:
        speech.unlink(missing_ok=True)

    text = "\n\n".join(p["text"] for p in parts if p.get("text")).strip()
    if not text:
        raise RuntimeError("No speech was detected in this video.")

    segments = []
    for part in parts:
        for s in part.get("segments") or []:
            if isinstance(s, dict):
                start = float(s.get("start") or 0) + part["offset"]
                end = float(s.get("end") or 0) + part["offset"]
                body = str(s.get("text") or "").strip()
            else:
                start = float(getattr(s, "start", 0) or 0) + part["offset"]
                end = float(getattr(s, "end", 0) or 0) + part["offset"]
                body = str(getattr(s, "text", "") or "").strip()
            if body:
                segments.append({"start": start, "end": end, "text": body})

    return {
        "text": text,
        "language": parts[0].get("language") or "",
        "segments": segments,
        "model": parts[0].get("model") or "",
        "duration": duration,
    }


def set_job(job_id: str, **fields: Any) -> None:
    with jobs_lock:
        job = jobs.setdefault(job_id, {})
        job.update(fields)


def get_job(job_id: str) -> dict[str, Any] | None:
    with jobs_lock:
        job = jobs.get(job_id)
        return dict(job) if job else None


MEME_CATEGORY_HINTS = {
    "comedy": "funny interactions, jokes, punchlines, roasting, awkward comedy, laugh-out-loud dialogue",
    "suspense": "curiosity, tension, unanswered questions, unexpected reveals, wait-for-it moments",
    "attitude": "powerful dialogue, swag, dominance, comeback energy, lines that feel like attitude",
    "emotional": "sad, crying, heartfelt, family, breakup, grief, relatable tender moments",
    "twist": "plot twists, shocking statements, gasp lines, sudden turns that flip the scene",
    "comment": "lines people will quote in comments, debate bait, screenshot text, stitch-worthy one-liners",
    "standalone": "self-contained scenes that work without movie context, clear setup and payoff in one clip",
    "hook": "scroll-stopping first seconds, high-energy peaks, Reels or Shorts openers",
    "roast": "insults, clapbacks, savage replies, public call-outs, argument wins",
    "motivation": "speeches, comeback, confidence, advice that hits hard",
    "romance": "flirting, love confession, chemistry, couple tension",
    "cringe": "awkward silence, second-hand embarrassment, failed flex, uncomfortable comedy",
    "song": "full picturized songs, sung verses, chorus, musical numbers — every gaana in the movie",
}


class AnalyzeBody(BaseModel):
    transcript: str
    category: str = "comedy"
    duration: float = 0
    segments: list[dict[str, Any]] = []


def analyze_meme_moments(
    transcript: str,
    category: str,
    duration: float,
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Add OPENAI_API_KEY to backend/.env to find meme moments.")
    cat = category if category in MEME_CATEGORY_HINTS else "standalone"
    hint = MEME_CATEGORY_HINTS[cat]
    is_song = cat == "song"
    timed = ""
    for s in segments[: 900 if is_song else 400]:
        try:
            start = float(s.get("start") or 0)
            text = str(s.get("text") or "").strip()
        except Exception:
            continue
        if text:
            timed += f"[{start:.1f}] {text}\n"
    source = timed.strip() or transcript.strip()
    if not source:
        raise RuntimeError("Transcribe the video first.")
    if len(source) < 20:
        raise RuntimeError("Transcript is too short to find moments.")

    client = OpenAI(api_key=api_key)
    prompt = (
        f"You find clip-worthy moments in a video transcript for category '{cat}': {hint}.\n"
        "Return ONLY valid JSON: {\"moments\":[{\"start\":12.4,\"end\":28.1,\"title\":\"...\",\"reason\":\"...\"}]}\n"
        "Rules:\n"
        + (
            "- list EVERY sung song / musical number, in time order, do not skip any\n"
            "- start/end are seconds, end > start, each song 45 to 480 seconds (full gaana)\n"
            if is_song
            else "- 3 to 10 moments, strongest first\n- start/end are seconds, end > start, each clip 6 to 45 seconds\n"
        )
        + "- stay inside the video duration if given\n"
        "- use the timestamps in the transcript; do not invent far-off times\n"
        + (
            "- title is the song name or first lyric line; reason is one line\n"
            if is_song
            else "- title is short; reason is one line why it can go viral in this category\n"
        )
        + "- if category is standalone, each clip must make sense with no movie context\n"
        "- if category is comment, prefer one sharp line people will quote or argue about\n"
        f"Video duration seconds: {duration or 'unknown'}\n\n"
        f"TRANSCRIPT:\n{source[:40000 if is_song else 24000]}"
    )
    res = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.3,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": "You extract timestamped viral video moments. Reply with JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
    )
    raw = res.choices[0].message.content or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as err:
        raise RuntimeError("Could not parse meme moments.") from err
    moments = []
    max_end = duration if duration and duration > 1 else 24 * 60 * 60
    for item in data.get("moments") or []:
        try:
            start = max(0.0, float(item.get("start") or 0))
            end = min(max_end, float(item.get("end") or 0))
        except (TypeError, ValueError):
            continue
        if end - start < 4:
            end = min(max_end, start + 8)
        if end <= start:
            continue
        moments.append(
            {
                "start": round(start, 2),
                "end": round(end, 2),
                "title": str(item.get("title") or "Moment").strip()[:80],
                "reason": str(item.get("reason") or "").strip()[:180],
            }
        )
    if not moments:
        raise RuntimeError("No matching moments found. Try another category.")
    if is_song:
        moments.sort(key=lambda item: item["start"])
    return moments[: 20 if is_song else 10]


class ImportInfoBody(BaseModel):
    url: str


class ImportTranscriptBody(BaseModel):
    url: str
    language: str = "auto"


def parse_vtt_segments(text: str) -> list[dict[str, Any]]:
    cue_re = re.compile(
        r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})"
    )

    def to_sec(hour: str | None, minute: str, sec: str, ms: str) -> float:
        return int(hour or 0) * 3600 + int(minute) * 60 + int(sec) + int(ms) / 1000

    segments: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", (text or "").replace("\r\n", "\n"))
    for block in blocks:
        lines = [
            ln.strip()
            for ln in block.split("\n")
            if ln.strip()
            and not ln.strip().startswith(("WEBVTT", "NOTE", "Kind:", "Language:"))
        ]
        ts_line = next((ln for ln in lines if "-->" in ln), None)
        if not ts_line:
            continue
        match = cue_re.search(ts_line)
        if not match:
            continue
        body = " ".join(
            re.sub(r"<[^>]+>", "", ln)
            for ln in lines
            if "-->" not in ln and not re.fullmatch(r"\d+", ln)
        )
        body = re.sub(r"\s+", " ", body).strip()
        if not body:
            continue
        start = to_sec(match.group(1), match.group(2), match.group(3), match.group(4))
        end = to_sec(match.group(5), match.group(6), match.group(7), match.group(8))
        if segments and segments[-1]["text"] == body:
            segments[-1]["end"] = end
        else:
            segments.append({"start": start, "end": end, "text": body})
    return segments


def fetch_url_captions(url: str, language: str = "auto") -> dict[str, Any]:
    import yt_dlp

    opts = ytdlp_base_opts()
    opts.update(
        {
            "skip_download": True,
            "writesubtitles": False,
            "writeautomaticsub": False,
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise RuntimeError("Could not read captions for this URL.")

    manuals = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    preferred = [language, f"{language}-orig"] if language in {"hi", "en"} else ["hi", "en", "en-orig", "hi-orig"]
    lang = None
    tracks = None
    kind = ""
    for store, label in ((manuals, "captions"), (autos, "auto-captions")):
        for code in preferred:
            if store.get(code):
                lang, tracks, kind = code, store[code], label
                break
        if tracks:
            break
        for code, items in store.items():
            if items:
                lang, tracks, kind = code, items, label
                break
        if tracks:
            break
    if not tracks:
        raise RuntimeError("No captions were found for this URL.")

    order = ("vtt", "srv3", "srt")
    chosen = None
    for ext in order:
        chosen = next(
            (item for item in tracks if str(item.get("ext") or "").lower() == ext and item.get("url")),
            None,
        )
        if chosen:
            break
    chosen = chosen or next((item for item in tracks if item.get("url")), None)
    if not chosen:
        raise RuntimeError("No captions were found for this URL.")

    req = UrlRequest(
        chosen["url"],
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
    )
    with urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    segments = parse_vtt_segments(raw)
    text = " ".join(s["text"] for s in segments).strip()
    if not text:
        raise RuntimeError("Captions were empty for this URL.")
    return {
        "transcript": text,
        "segments": segments,
        "language": lang or "",
        "source": kind,
    }


class ImportDownloadBody(BaseModel):
    url: str
    selector: str = ""
    title: str = "video"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "zyvom-python-backend"}


@app.post("/api/import/info")
def import_info(body: ImportInfoBody) -> dict[str, Any]:
    url = parse_import_url(body.url)
    if not url:
        raise HTTPException(400, "Paste a valid public video URL.")
    try:
        return probe_import_url(url)
    except Exception as err:
        raise HTTPException(400, str(err) or "Could not read qualities for this URL.") from err


@app.post("/api/import/transcript")
def import_transcript(body: ImportTranscriptBody) -> dict[str, Any]:
    url = parse_import_url(body.url)
    if not url:
        raise HTTPException(400, "Paste a valid public video URL.")
    lang = body.language.lower() if body.language.lower() in {"hi", "en"} else "auto"
    try:
        return fetch_url_captions(url, lang)
    except Exception as err:
        raise HTTPException(400, str(err) or "No captions were found for this URL.") from err


@app.post("/api/import/download")
def import_download(body: ImportDownloadBody) -> dict[str, str]:
    url = parse_import_url(body.url)
    selector = (body.selector or "").strip()
    if not url:
        raise HTTPException(400, "Paste a valid public video URL.")
    if not selector or re.search(r"[\s;|&$`]", selector):
        raise HTTPException(400, "Choose a video quality.")

    job_id = str(uuid.uuid4())
    clear_workdir(OUTPUT_DIR)
    output_path = OUTPUT_DIR / IMPORT_OUTPUT_NAME
    download_name = safe_download_name(body.title or "video")
    set_job(
        job_id,
        status="processing",
        progress=8,
        stage="downloading",
        outputPath=str(output_path),
        downloadName=download_name,
    )

    def work() -> None:
        try:
            download_import(url, selector, output_path)
            if not output_path.exists():
                raise RuntimeError("The selected quality could not be saved as MP4.")
            set_job(job_id, status="done", progress=100, stage="complete")
        except Exception as err:
            set_job(job_id, status="error", error=str(err) or "Download failed")

    threading.Thread(target=work, daemon=True).start()
    return {
        "jobId": job_id,
        "statusUrl": f"/api/status/{job_id}",
        "downloadUrl": f"/api/download/{job_id}",
    }


@app.post("/api/meme/analyze")
def meme_analyze(body: AnalyzeBody) -> dict[str, Any]:
    try:
        moments = analyze_meme_moments(
            body.transcript,
            body.category,
            float(body.duration or 0),
            body.segments or [],
        )
        return {"moments": moments, "category": body.category}
    except Exception as err:
        raise HTTPException(400, str(err) or "Could not find moments.") from err


@app.post("/api/transcribe")
async def transcribe(
    video: UploadFile = File(...),
    language: str = Form("auto"),
) -> dict[str, str]:
    lang = language.lower() if language.lower() in {"hi", "en"} else "auto"
    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    job_id = str(uuid.uuid4())
    work_dir = UPLOAD_DIR / f"job-{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)
    dest = work_dir / f"video{suffix}"
    dest.write_bytes(await video.read())
    set_job(job_id, status="processing", progress=6, stage="queued")

    def work() -> None:
        try:
            result = transcribe_video_file(
                dest,
                lang,
                on_progress=lambda progress, stage: set_job(
                    job_id, progress=progress, stage=stage
                ),
                work_dir=work_dir,
            )
            set_job(
                job_id,
                status="done",
                progress=100,
                stage="complete",
                transcript=result["text"],
                segments=result["segments"],
                language=result["language"],
            )
        except Exception as err:
            set_job(job_id, status="error", error=str(err) or "Transcription failed")
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    threading.Thread(target=work, daemon=True).start()
    return {"jobId": job_id, "statusUrl": f"/api/status/{job_id}"}


@app.get("/api/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return JSONResponse(
        {
            "status": job.get("status"),
            "progress": job.get("progress"),
            "stage": job.get("stage"),
            "error": job.get("error"),
            "transcript": job.get("transcript"),
            "segments": job.get("segments"),
            "language": job.get("language"),
            "downloadUrl": (
                f"/api/download/{job_id}"
                if job.get("status") == "done" and job.get("outputPath")
                else None
            ),
            "downloadName": job.get("downloadName"),
        }
    )


@app.get("/api/download/{job_id}")
def download(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("status") != "done":
        raise HTTPException(409, "Job not finished yet")
    path = Path(job.get("outputPath") or "")
    if not path.exists():
        raise HTTPException(404, "Output file missing")
    return FileResponse(
        path,
        filename=job.get("downloadName") or path.name,
        media_type="video/mp4",
    )
