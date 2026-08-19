/**
 * Professional Video Merger + Watermark Remover – Backend
 * --------------------------------------------------------
 * Express server that accepts short videos and can:
 *   1. Remove a corner watermark (e.g. the "Grok" logo) using FFmpeg's
 *      `delogo` filter, which interpolates the surrounding pixels.
 *   2. Concatenate multiple clips into one MP4.
 *
 * Why re-encode instead of using the simple `concat` demuxer?
 *   Short videos uploaded from phones / different sources often have different
 *   codecs, resolutions, frame rates or audio sample rates. The concat demuxer
 *   fails (or produces broken output) in that case. We normalise every clip to
 *   the SAME codec/resolution/fps/audio params first, then concatenate. This
 *   gives a clean, professional, glitch-free output.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PYTHON_API = process.env.PYTHON_API || "http://127.0.0.1:5051";

require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const archiver = require("archiver");
const sharp = require("sharp");
const youtubedl = require("youtube-dl-exec");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("@ffprobe-installer/ffprobe").path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(process.env.FFPROBE_PATH || ffprobePath);

/** macOS hardware H.264 — huge speedup on long music videos. */
const USE_H264_VIDEOTOOLBOX = (() => {
  try {
    const out = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return /h264_videotoolbox/.test(out);
  } catch {
    return false;
  }
})();

/**
 * Fast encode opts for slideshow.
 * - clip/assemble: always libx264 ultrafast (VT hangs on short zoompan stills)
 * - final: VideoToolbox when available (big win on long music mux)
 */
function slideshowEncodeOpts({
  bitrate = "6M",
  crf = 23,
  mode = "clip",
} = {}) {
  if (mode === "final" && USE_H264_VIDEOTOOLBOX) {
    return [
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      bitrate,
      "-pix_fmt",
      "yuv420p",
      "-allow_sw",
      "1",
      "-realtime",
      "0",
      "-threads",
      "0",
    ];
  }
  const opts = [
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "0",
  ];
  return opts;
}

/** Run async work over items with limited parallelism. */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

const app = express();
// Default to 5050 because macOS uses port 5000 for the AirPlay Receiver.
const PORT = process.env.PORT || 5050;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "output");
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Fixed names so each new export overwrites the previous and disk stays lean. */
const OUTPUT_NAMES = {
  merge: "zyvom-latest.mp4",
  music: "zyvom-music-latest.mp4",
  split: "zyvom-split-latest.zip",
  meme: "zyvom-meme-latest.zip",
  duet: "zyvom-duet-latest.mp4",
};

/** Remove every file in output/ except .gitkeep (keeps only the next export). */
function clearOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) return;
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    if (name === ".gitkeep") continue;
    try {
      fs.rmSync(path.join(OUTPUT_DIR, name), { recursive: true, force: true });
    } catch {
      // ignore locked/missing files
    }
  }
}

/**
 * Wipe uploads/ (files + temp dirs) so old jobs don't pile up.
 * Pass `keepPaths` for the current request's uploads so they survive.
 */
function clearUploadsDir(keepPaths = []) {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const keep = new Set(
    keepPaths.filter(Boolean).map((p) => path.resolve(p))
  );
  keep.add(path.resolve(UPLOAD_DIR, ".gitkeep"));

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.resolve(UPLOAD_DIR, name);
    if (keep.has(full)) continue;
    // Keep a directory if any retained file lives inside it
    const holdsKept = [...keep].some(
      (k) => k.startsWith(full + path.sep)
    );
    if (holdsKept) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // ignore locked/missing files
    }
  }
}

// Free disk from older exports / leftover uploads on boot.
clearOutputDir();
clearUploadsDir();

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Track merge jobs in memory so the frontend can poll progress.
const jobs = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|3gp|ogv|ts|flv|wmv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac|wma)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

const videoFileFilter = (_req, file, cb) => {
  // Accept by MIME type OR by extension – some browsers / clients set the
  // mime to application/octet-stream for valid video files.
  if (
    file.mimetype.startsWith("video/") ||
    VIDEO_EXT.test(file.originalname || "")
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only video files are allowed"));
  }
};

const mergeFileFilter = (_req, file, cb) => {
  if (file.fieldname === "videos") return videoFileFilter(_req, file, cb);
  if (file.fieldname === "coverImage") {
    if (
      file.mimetype.startsWith("image/") ||
      IMAGE_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only image files are allowed for cover"));
  }
  cb(new Error("Unexpected upload field"));
};

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
  fileFilter: mergeFileFilter,
});

const splitFileFilter = (_req, file, cb) => {
  if (file.fieldname === "video") return videoFileFilter(_req, file, cb);
  if (file.fieldname === "coverImage") {
    if (
      file.mimetype.startsWith("image/") ||
      IMAGE_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only image files are allowed for cover"));
  }
  cb(new Error("Unexpected upload field"));
};

// Split accepts a long source video plus an optional cover image.
const uploadSplit = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: splitFileFilter,
});

const slideshowFileFilter = (_req, file, cb) => {
  if (file.fieldname === "audio") {
    if (
      file.mimetype.startsWith("audio/") ||
      AUDIO_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only audio files (MP3, M4A, WAV…) are allowed"));
  }
  if (file.fieldname === "images") {
    if (
      file.mimetype.startsWith("image/") ||
      IMAGE_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only image files (JPG, PNG, WebP…) are allowed"));
  }
  cb(new Error("Unexpected upload field"));
};

const uploadSlideshow = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
  fileFilter: slideshowFileFilter,
});

const uploadMeme = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: videoFileFilter,
});

const duetFileFilter = (_req, file, cb) => {
  if (file.fieldname === "videoTop" || file.fieldname === "videoBottom") {
    return videoFileFilter(_req, file, cb);
  }
  if (file.fieldname === "overlayImage") {
    if (
      file.mimetype.startsWith("image/") ||
      IMAGE_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only image files are allowed for overlay"));
  }
  if (
    file.fieldname === "audio" ||
    file.fieldname === "audioTop" ||
    file.fieldname === "audioBottom"
  ) {
    if (
      file.mimetype.startsWith("audio/") ||
      AUDIO_EXT.test(file.originalname || "")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Only audio files (MP3, M4A, WAV…) are allowed"));
  }
  cb(new Error("Unexpected upload field"));
};

const uploadDuet = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: duetFileFilter,
});

const DUET_WIDTH = 1080;
const DUET_PANE_H = 958;
const DUET_BAR_H = 4;
const DUET_HEIGHT = DUET_PANE_H * 2 + DUET_BAR_H;
const DUET_FPS = 30;
const DUET_PIP_SIZE = 300;
const DUET_PIP_RING = 10;

const SPLIT_PARTS_MIN = 2;
const SPLIT_PARTS_MAX = 80;

function parseSplitPartCount(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return 2;
  return Math.max(SPLIT_PARTS_MIN, Math.min(SPLIT_PARTS_MAX, n));
}
/** 24fps is plenty for Ken Burns slides and encodes ~20% faster than 30. */
const SLIDESHOW_FPS = 24;
const SLIDESHOW_LAYOUTS = new Set(["auto", "landscape", "portrait", "square"]);
/** Soft crossfade between slides (seconds) — long enough to feel like a real slide. */
const SLIDESHOW_XFADE_MAX = 0.9;
const SLIDESHOW_XFADE_MIN = 0.7;
/** How long each image stays on screen before the next (then the set loops). */
const SLIDESHOW_HOLD_SEC = 3.2;
/** Parallel Ken Burns encodes (keep small on laptops to avoid RAM thrash). */
const SLIDESHOW_ENCODE_CONCURRENCY = Math.min(
  3,
  Math.max(1, (os.cpus() || []).length - 1 || 1)
);

function cleanupFiles(files) {
  for (const f of files) {
    fs.promises.unlink(f).catch(() => {});
  }
}

const VALID_POSITIONS = new Set([
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
]);

// Output layouts for merge/split.
const LAYOUT_SIZES = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
  square: { width: 1080, height: 1080 },
};
/** Higher-res canvases for music slides so split tiles stay sharper when scaled. */
const SLIDESHOW_LAYOUT_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};
const VALID_LAYOUTS = new Set(["auto", ...Object.keys(LAYOUT_SIZES)]);
const VALID_PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function parsePlaybackSpeed(raw) {
  const speed = Number.parseFloat(raw);
  return VALID_PLAYBACK_SPEEDS.includes(speed) ? speed : 1;
}

async function resolveLayout(layout, firstFilePath) {
  if (layout !== "auto") {
    return LAYOUT_SIZES[layout] || LAYOUT_SIZES.landscape;
  }
  try {
    const { width, height } = await probeVideo(firstFilePath);
    if (height > width * 1.1) return LAYOUT_SIZES.portrait;
    if (width > height * 1.1) return LAYOUT_SIZES.landscape;
    return LAYOUT_SIZES.square;
  } catch {
    return LAYOUT_SIZES.landscape;
  }
}

/**
 * Auto canvas for music slideshow: majority orientation across all photos
 * so every image sits on a frame that matches the set.
 */
function orientedStillSize(meta) {
  const o = meta.orientation || 1;
  const swap = o >= 5 && o <= 8;
  const width = Number(swap ? meta.height : meta.width) || 0;
  const height = Number(swap ? meta.width : meta.height) || 0;
  return { width, height };
}

/** 1080p canvas that matches the photo aspect — no letterbox stretch. */
function slideshowCanvasForAspect(srcW, srcH) {
  const ar = srcW / Math.max(1, srcH);
  if (Math.abs(ar - 1) < 0.06) {
    return { width: 1080, height: 1080 };
  }
  if (ar > 1) {
    let w = 1920;
    let h = evenDim(Math.round(w / ar));
    if (h > 1080) {
      h = 1080;
      w = evenDim(Math.round(h * ar));
    }
    return {
      width: evenDim(Math.max(640, w)),
      height: evenDim(Math.max(406, h)),
    };
  }
  let h = 1920;
  let w = evenDim(Math.round(h * ar));
  if (w > 1080) {
    w = 1080;
    h = evenDim(Math.round(w / ar));
  }
  return {
    width: evenDim(Math.max(406, w)),
    height: evenDim(Math.max(640, h)),
  };
}

async function resolveSlideshowLayout(layout, imagePaths) {
  if (layout !== "auto") {
    return SLIDESHOW_LAYOUT_SIZES[layout] || SLIDESHOW_LAYOUT_SIZES.landscape;
  }
  if (!imagePaths?.length) return SLIDESHOW_LAYOUT_SIZES.landscape;
  if (imagePaths.length === 1) {
    try {
      const { width: sw, height: sh } = orientedStillSize(
        await sharp(imagePaths[0]).metadata()
      );
      if (sw > 0 && sh > 0) return slideshowCanvasForAspect(sw, sh);
    } catch {
      // fall through to majority vote
    }
  }

  let portrait = 0;
  let landscape = 0;
  let square = 0;

  for (const filePath of imagePaths) {
    try {
      const { width, height } = orientedStillSize(await sharp(filePath).metadata());
      if (height > width * 1.1) portrait += 1;
      else if (width > height * 1.1) landscape += 1;
      else square += 1;
    } catch {
      // skip unreadable stills
    }
  }

  if (portrait >= landscape && portrait >= square && portrait > 0) {
    return SLIDESHOW_LAYOUT_SIZES.portrait;
  }
  if (landscape >= portrait && landscape >= square && landscape > 0) {
    return SLIDESHOW_LAYOUT_SIZES.landscape;
  }
  if (square > 0) return SLIDESHOW_LAYOUT_SIZES.square;
  const fallback = await resolveLayout("auto", imagePaths[0]);
  if (fallback.height > fallback.width) return SLIDESHOW_LAYOUT_SIZES.portrait;
  if (fallback.width > fallback.height) return SLIDESHOW_LAYOUT_SIZES.landscape;
  return SLIDESHOW_LAYOUT_SIZES.square;
}

/**
 * Detect a regular photo-grid collage (e.g. 2×4 with white/black gutters) and
 * crop each panel into its own file. Prevents portrait cover-crop from showing
 * two stacked panels with a line through the middle.
 */
async function detectAndSplitCollage(imagePath, outDir, jobId, index) {
  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (srcW < 80 || srcH < 80) return null;

  const maxDetect = 900;
  const scale = Math.min(1, maxDetect / Math.max(srcW, srcH));
  const dw = Math.max(2, Math.round(srcW * scale));
  const dh = Math.max(2, Math.round(srcH * scale));

  const { data, info } = await sharp(imagePath)
    .resize(dw, dh, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const ve = new Float32Array(w);
  for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      s += Math.abs(lum[i + 1] - lum[i - 1]);
    }
    ve[x] = s / h;
  }

  const he = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]);
    }
    he[y] = s / w;
  }

  const median = (arr, from, to) => {
    const slice = Array.from(arr.slice(from, to)).sort((a, b) => a - b);
    return slice[Math.floor(slice.length / 2)] || 1;
  };
  const med = (median(ve, 8, w - 8) + median(he, 8, h - 8)) / 2;

  /** Peak seam, then snap to center of the high-energy gutter band. */
  const bestSeam = (profile, ideal, limit, search) => {
    let best = 0;
    let bestPos = ideal;
    for (let d = -search; d <= search; d++) {
      const p = ideal + d;
      if (p < 2 || p >= limit - 2) continue;
      if (profile[p] > best) {
        best = profile[p];
        bestPos = p;
      }
    }
    const thresh = best * 0.55;
    let lo = bestPos;
    let hi = bestPos;
    while (lo > 2 && profile[lo - 1] >= thresh) lo -= 1;
    while (hi < limit - 3 && profile[hi + 1] >= thresh) hi += 1;
    return { energy: best, pos: Math.round((lo + hi) / 2) };
  };

  const scoreGrid = (rows, cols) => {
    const vSeams = [];
    const hSeams = [];
    for (let i = 1; i < cols; i++) {
      vSeams.push(
        bestSeam(ve, Math.round((i * w) / cols), w, Math.max(6, Math.round(w * 0.02)))
      );
    }
    for (let i = 1; i < rows; i++) {
      hSeams.push(
        bestSeam(he, Math.round((i * h) / rows), h, Math.max(6, Math.round(h * 0.02)))
      );
    }
    const energies = [...vSeams, ...hSeams].map((s) => s.energy);
    if (!energies.length) return null;
    const minE = Math.min(...energies);
    const avgE = energies.reduce((a, b) => a + b, 0) / energies.length;
    return {
      rows,
      cols,
      minE,
      avgE,
      minRatio: minE / Math.max(med, 1),
      ratio: avgE / Math.max(med, 1),
      vSeams: vSeams.map((s) => s.pos),
      hSeams: hSeams.map((s) => s.pos),
      cells: rows * cols,
    };
  };

  const candidates = [
    [2, 2],
    [2, 3],
    [2, 4],
    [2, 5],
    [2, 6],
    [3, 2],
    [3, 3],
    [3, 4],
    [3, 5],
    [4, 2],
    [4, 3],
    [4, 4],
    [4, 5],
    [5, 2],
    [5, 3],
    [5, 4],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 1],
    [3, 1],
    [4, 1],
    [5, 1],
  ];

  let best = null;
  for (const [rows, cols] of candidates) {
    const scored = scoreGrid(rows, cols);
    if (!scored) continue;
    // Strong gutter seams only — avoid chopping normal photos
    if (scored.minRatio < 4.2 || scored.ratio < 5.0) continue;
    if (
      !best ||
      scored.cells > best.cells ||
      (scored.cells === best.cells && scored.avgE > best.avgE)
    ) {
      best = scored;
    }
  }

  if (!best || best.cells < 2) return null;

  const toSrc = (v) => Math.round(v / scale);
  const boundsX = [
    0,
    ...best.vSeams.map(toSrc),
    srcW,
  ];
  const boundsY = [
    0,
    ...best.hSeams.map(toSrc),
    srcH,
  ];

  // Ensure monotonic unique bounds matching grid size
  const uniqSorted = (arr, expected) => {
    const cleaned = [...new Set(arr.map((v) => Math.max(0, Math.min(v, expected === "x" ? srcW : srcH))))]
      .sort((a, b) => a - b);
    if (cleaned[0] !== 0) cleaned.unshift(0);
    const end = expected === "x" ? srcW : srcH;
    if (cleaned[cleaned.length - 1] !== end) cleaned.push(end);
    return cleaned;
  };

  let xs = uniqSorted(boundsX, "x");
  let ys = uniqSorted(boundsY, "y");
  if (xs.length !== best.cols + 1) {
    xs = Array.from({ length: best.cols + 1 }, (_, i) =>
      Math.round((i * srcW) / best.cols)
    );
  }
  if (ys.length !== best.rows + 1) {
    ys = Array.from({ length: best.rows + 1 }, (_, i) =>
      Math.round((i * srcH) / best.rows)
    );
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Trim well past the gutter so adjacent panels never bleed into each other
  const cellW = Math.max(8, Math.round(srcW / best.cols));
  const cellH = Math.max(8, Math.round(srcH / best.rows));
  const insetX = Math.max(4, Math.round(cellW * 0.025));
  const insetY = Math.max(4, Math.round(cellH * 0.025));
  const tiles = [];

  for (let r = 0; r < best.rows; r++) {
    for (let c = 0; c < best.cols; c++) {
      const left = Math.min(srcW - 9, xs[c] + insetX);
      const top = Math.min(srcH - 9, ys[r] + insetY);
      const right = Math.max(left + 8, xs[c + 1] - insetX);
      const bottom = Math.max(top + 8, ys[r + 1] - insetY);
      const width = right - left;
      const height = bottom - top;
      const tilePath = path.join(
        outDir,
        `tile-${jobId}-${index}-${r}-${c}.png`
      );
      // Lossless PNG from the original pixels — no JPEG softness after crop
      await sharp(imagePath)
        .extract({ left, top, width, height })
        .png({ compressionLevel: 4 })
        .toFile(tilePath);
      tiles.push(tilePath);
    }
  }

  return tiles.length >= 2
    ? { tiles, rows: best.rows, cols: best.cols }
    : null;
}

/** Frontend already names split panels like `photo_1-2.png` — don't re-crop those. */
function looksLikePreSplitTile(filename = "") {
  return /_\d+-\d+\.(png|jpe?g|webp)$/i.test(filename) || /^tile-/i.test(filename);
}

/**
 * Expand any collage uploads into individual panel images.
 * Skips files the client already split so panels aren't chopped again.
 */
async function expandSlideshowImages(imageFiles, jobId) {
  const outDir = path.join(UPLOAD_DIR, `tiles-${jobId}`);
  const expanded = [];
  const generated = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (looksLikePreSplitTile(file.originalname || path.basename(file.path))) {
      expanded.push(file);
      continue;
    }
    try {
      const split = await detectAndSplitCollage(file.path, outDir, jobId, i);
      if (split?.tiles?.length) {
        for (const tilePath of split.tiles) {
          expanded.push({ path: tilePath, originalname: path.basename(tilePath) });
          generated.push(tilePath);
        }
      } else {
        expanded.push(file);
      }
    } catch (err) {
      console.warn("Collage split skipped:", err.message);
      expanded.push(file);
    }
  }

  return { images: expanded, generatedPaths: generated, tilesDir: outDir };
}

/**
 * Inspect a video file and return stream metadata used by filters.
 */
function probeMedia(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find((s) => s.codec_type === "video");
      const hasAudio = data.streams.some((s) => s.codec_type === "audio");
      if (!stream) return reject(new Error("No video stream found"));
      resolve({ width: stream.width, height: stream.height, hasAudio });
    });
  });
}

function probeVideo(inputPath) {
  return probeMedia(inputPath);
}

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const duration = Number(data.format?.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error("Could not read media duration"));
      }
      resolve(duration);
    });
  });
}

/**
 * Gentle Ken Burns camera moves — visible motion without heavy zoom stretch.
 */
const CINEMATIC_MOVES = [
  // Soft push-in
  {
    z: (f) => `1+0.12*(on/${f})`,
    x: () => `(iw-iw/zoom)/2`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Soft pull-out
  {
    z: (f) => `1.12-0.12*(on/${f})`,
    x: () => `(iw-iw/zoom)/2`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Drift right + light zoom
  {
    z: (f) => `1.05+0.08*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(on/${f})`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Drift left + light zoom
  {
    z: (f) => `1.05+0.08*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(1-on/${f})`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Rise
  {
    z: (f) => `1.06+0.06*(on/${f})`,
    x: () => `(iw-iw/zoom)/2`,
    y: (f) => `(ih-ih/zoom)*(1-on/${f})`,
  },
  // Descend
  {
    z: (f) => `1.06+0.06*(on/${f})`,
    x: () => `(iw-iw/zoom)/2`,
    y: (f) => `(ih-ih/zoom)*(on/${f})`,
  },
  // Diagonal NE
  {
    z: (f) => `1.04+0.1*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(on/${f})`,
    y: (f) => `(ih-ih/zoom)*(1-on/${f})`,
  },
  // Diagonal SW
  {
    z: (f) => `1.04+0.1*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(1-on/${f})`,
    y: (f) => `(ih-ih/zoom)*(on/${f})`,
  },
  // Mild punch
  {
    z: (f) => `1+0.14*(on/${f})`,
    x: () => `(iw-iw/zoom)/2`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Lateral drift (almost no extra zoom)
  {
    z: () => `1.08`,
    x: (f) => `(iw-iw/zoom)*(on/${f})`,
    y: () => `(ih-ih/zoom)/2`,
  },
  // Drift up
  {
    z: (f) => `1.06+0.06*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(0.35+0.3*(on/${f}))`,
    y: (f) => `(ih-ih/zoom)*(1-on/${f})`,
  },
  // Drift down
  {
    z: (f) => `1.06+0.06*(on/${f})`,
    x: (f) => `(iw-iw/zoom)*(0.65-0.3*(on/${f}))`,
    y: (f) => `(ih-ih/zoom)*(on/${f})`,
  },
];

/** Clear slide changes — left/right slides + soft dissolves (feels active). */
const XFADE_STYLES = [
  "slideleft",
  "slideright",
  "smoothleft",
  "smoothright",
  "dissolve",
  "fadeblack",
  "fade",
  "diagtl",
  "diagtr",
  "slidedown",
  "slideup",
];

/**
 * Full-bleed photo. Ken Burns only when animate=true (multiple slides).
 * Zoompan needs a larger source than the output (z>1), otherwise FFmpeg can hang.
 */
function buildCinematicSlideFilter(width, height, frames, index, { animate = true } = {}) {
  const fadeIn = Math.min(0.25, (frames / SLIDESHOW_FPS) * 0.12);
  const move = CINEMATIC_MOVES[index % CINEMATIC_MOVES.length];
  const even = (n) => n - (n % 2);
  // ~20% overscan is enough for our mild zooms; much cheaper than old 2× Lanczos
  const sw = even(Math.ceil(width * 1.2));
  const sh = even(Math.ceil(height * 1.2));

  return [
    "setsar=1",
    `scale=w=${sw}:h=${sh}:force_original_aspect_ratio=increase:flags=bilinear`,
    `crop=${sw}:${sh}`,
    `zoompan=z='${move.z(frames)}':x='${move.x(frames)}':y='${move.y(frames)}':d=${frames}:s=${width}x${height}:fps=${SLIDESHOW_FPS}`,
    "setsar=1",
    `setdar=${width}/${height}`,
    "eq=contrast=1.04:saturation=1.05",
    `fade=t=in:st=0:d=${fadeIn.toFixed(3)}`,
  ].join(",");
}

/** Even pixel size — required for yuv420p video frames. */
function evenDim(n) {
  return n - (n % 2);
}

/** 2px frame gutter — almost full-bleed so the border is not noticeable. */
function slideshowGutter(_width, _height) {
  return 2;
}

function hslToVisualizerHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const light = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `0x${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/** Three vivid, spaced hues — deep enough that yuv420 does not wash to white. */
function randomVisualizerColors() {
  const h0 = Math.floor(Math.random() * 360);
  const hues = [
    h0,
    (h0 + 38 + Math.random() * 44) % 360,
    (h0 + 168 + Math.random() * 70) % 360,
  ];
  return hues
    .map((h) =>
        hslToVisualizerHex(
        h,
        0.82 + Math.random() * 0.12,
        0.48 + Math.random() * 0.1
      )
    )
    .join("|");
}

/** Bottom spectrum overlay — ~38% of the frame so bars can bounce high. */
function slideshowVisualizerHeight(frameHeight) {
  return evenDim(
    Math.max(320, Math.min(480, Math.round(frameHeight * 0.38)))
  );
}

/** Inner photo box — full frame. Visualizer overlays the bottom later. */
function slideshowInnerBox(width, height, { visualizer = true } = {}) {
  const gutter = slideshowGutter(width, height);
  const vizH = visualizer ? slideshowVisualizerHeight(height) : 0;
  const innerW = evenDim(width - gutter * 2);
  const innerH = evenDim(height - gutter * 2);
  return {
    gutter,
    vizH,
    gap: 0,
    padX: gutter,
    padTop: gutter,
    padBottom: gutter,
    innerW,
    innerH: Math.max(2, innerH),
  };
}

/**
 * Full thumbnail sits inside the frame (contain, never cropped). Empty
 * space is a color-matched blur — no black bars, no cut text.
 */
async function prepareFramedStill(
  imagePath,
  outPath,
  width,
  height,
  { visualizer = true } = {}
) {
  const { padX, padTop, innerW, innerH } = slideshowInnerBox(width, height, {
    visualizer,
  });

  let dominant = { r: 22, g: 16, b: 24 };
  try {
    const stats = await sharp(imagePath).rotate().stats();
    if (stats.dominant) dominant = stats.dominant;
  } catch {
    // keep fallback wash
  }

  const wash = {
    r: Math.min(255, Math.round(dominant.r * 0.72 + 28)),
    g: Math.min(255, Math.round(dominant.g * 0.72 + 22)),
    b: Math.min(255, Math.round(dominant.b * 0.72 + 18)),
    alpha: 70,
  };

  const blurW = evenDim(Math.max(160, Math.round(width / 4)));
  const blurH = evenDim(Math.max(90, Math.round(height / 4)));
  const blurredSmall = await sharp(imagePath)
    .rotate()
    .resize(blurW, blurH, { fit: "cover", position: "centre" })
    .blur(22)
    .modulate({ brightness: 0.92, saturation: 1.35 })
    .toBuffer();

  const background = await sharp(blurredSmall)
    .resize(width, height, { fit: "fill" })
    .composite([
      {
        input: {
          create: {
            width,
            height,
            channels: 4,
            background: wash,
          },
        },
        blend: "over",
      },
    ])
    .toBuffer();

  const photo = await sharp(imagePath)
    .rotate()
    .resize({
      width: innerW,
      height: innerH,
      fit: "inside",
      kernel: sharp.kernel.lanczos3,
    })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();

  const fitted = await sharp(photo).metadata();
  const dw = evenDim(Number(fitted.width) || innerW);
  const dh = evenDim(Number(fitted.height) || innerH);

  const left = padX + Math.round((innerW - dw) / 2);
  const top = padTop + Math.round((innerH - dh) / 2);

  await sharp(background)
    .composite([{ input: photo, left, top }])
    .jpeg({ quality: 93, mozjpeg: true })
    .toFile(outPath);
}

/**
 * Full-bleed slide: photo fills the entire canvas (cover crop, no blur borders).
 */
function buildStaticSlideFilterGraph(width, height) {
  // Still was already cover-fitted by sharp (square pixels). Do not let
  // ffmpeg re-interpret JFIF density / SAR — that stretches faces.
  return [
    `[0:v]setsar=1,scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setdar=${width}/${height},fps=${SLIDESHOW_FPS}[vout]`,
  ].join(";");
}

/**
 * Optionally upscale small tiles with sharp, then render a slide clip.
 */
async function renderImageClip(
  imagePath,
  outputPath,
  durationSec,
  width,
  height,
  index,
  { animate = true, visualizer = true } = {}
) {
  const frames = Math.max(Math.round(durationSec * SLIDESHOW_FPS), 2);

  let inputPath = imagePath;
  let tempPrepared = null;

  try {
    tempPrepared = path.join(UPLOAD_DIR, `still-${uuidv4()}.jpg`);
    if (!animate) {
      await prepareFramedStill(imagePath, tempPrepared, width, height, {
        visualizer,
      });
    } else {
      const pipeline = sharp(imagePath).rotate();
      const meta = await sharp(imagePath).rotate().metadata();
      const srcW = meta.width || 0;
      const srcH = meta.height || 0;
      const targetLong = Math.max(width, height);
      if (srcW > 0 && srcH > 0 && (srcW < width * 0.7 || srcH < height * 0.7)) {
        await pipeline
          .resize({
            width: targetLong,
            height: targetLong,
            fit: "inside",
            kernel: sharp.kernel.cubic,
          })
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(tempPrepared);
      } else {
        await pipeline
          .jpeg({ quality: 92, mozjpeg: true })
          .toFile(tempPrepared);
      }
    }
    inputPath = tempPrepared;
  } catch (err) {
    console.warn("Still prepare skipped:", err.message);
    tempPrepared = null;
    inputPath = imagePath;
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (tempPrepared) cleanupFiles([tempPrepared]);
    };

    // Full-bleed cover — image fills the whole frame
    if (!animate) {
      ffmpeg(inputPath)
        .inputOptions(["-loop", "1"])
        .complexFilter(buildStaticSlideFilterGraph(width, height))
        .outputOptions([
          "-map",
          "[vout]",
          "-frames:v",
          String(frames),
          "-an",
          ...slideshowEncodeOpts({ bitrate: "8M", crf: 22, mode: "clip" }),
          "-tune",
          "stillimage",
          "-aspect",
          `${width}:${height}`,
          "-r",
          String(SLIDESHOW_FPS),
          "-movflags",
          "+faststart",
        ])
        .on("error", (err) => {
          cleanup();
          reject(err);
        })
        .on("end", () => {
          cleanup();
          resolve(outputPath);
        })
        .save(outputPath);
      return;
    }

    const filter = buildCinematicSlideFilter(width, height, frames, index, {
      animate: true,
    });

    // IMPORTANT: with zoompan, use -frames:v (not -t). -t + -loop 1 can hang forever.
    ffmpeg(inputPath)
      .inputOptions(["-loop", "1"])
      .videoFilters(filter)
      .outputOptions([
        "-frames:v",
        String(frames),
        "-an",
        ...slideshowEncodeOpts({ bitrate: "8M", crf: 22, mode: "clip" }),
        "-aspect",
        `${width}:${height}`,
        "-r",
        String(SLIDESHOW_FPS),
        "-movflags",
        "+faststart",
      ])
      .on("error", (err) => {
        cleanup();
        reject(err);
      })
      .on("end", () => {
        cleanup();
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

/**
 * Soft-crossfade clips into one continuous timeline so cuts never feel
 * like a PowerPoint — more like an edited music video.
 */
function assembleWithCrossfades(clipPaths, clipDurationSec, transitionSec, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (clipPaths.length === 1) {
      fs.promises
        .copyFile(clipPaths[0], outputPath)
        .then(() => resolve(outputPath))
        .catch(reject);
      return;
    }

    const cmd = ffmpeg();
    clipPaths.forEach((p) => cmd.input(p));

    const filters = [];
    let lastLabel = "0:v";

    for (let i = 1; i < clipPaths.length; i++) {
      const offset = Number((i * (clipDurationSec - transitionSec)).toFixed(3));
      const style = XFADE_STYLES[(i - 1) % XFADE_STYLES.length];
      const outLabel = i === clipPaths.length - 1 ? "vout" : `xf${i}`;
      filters.push(
        `[${lastLabel}][${i}:v]xfade=transition=${style}:duration=${transitionSec.toFixed(
          3
        )}:offset=${offset}[${outLabel}]`
      );
      lastLabel = outLabel;
    }

    cmd
      .complexFilter(filters)
      .outputOptions([
        "-map",
        "[vout]",
        "-an",
        ...slideshowEncodeOpts({ bitrate: "7M", crf: 22, mode: "clip" }),
        "-r",
        String(SLIDESHOW_FPS),
        "-movflags",
        "+faststart",
      ])
      .on("progress", (p) => onProgress && onProgress(p))
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * Join multiple audio files into one AAC track (stereo 44.1 kHz).
 * Mixed source formats are fine — filter concat re-encodes once.
 */
function concatAudioTracks(inputPaths, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!inputPaths.length) {
      return reject(new Error("No audio tracks to merge"));
    }

    if (inputPaths.length === 1) {
      return ffmpeg(inputPaths[0])
        .noVideo()
        .audioCodec("aac")
        .audioBitrate("192k")
        .audioFrequency(44100)
        .audioChannels(2)
        .on("progress", (p) => onProgress && onProgress(p))
        .on("error", reject)
        .on("end", () => resolve(outputPath))
        .save(outputPath);
    }

    const cmd = ffmpeg();
    inputPaths.forEach((p) => cmd.input(p));
    const labels = inputPaths.map((_, i) => `[${i}:a:0]`).join("");
    const filter = `${labels}concat=n=${inputPaths.length}:v=0:a=1[aout]`;

    cmd
      .complexFilter(filter)
      .outputOptions([
        "-map",
        "[aout]",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        "-ac",
        "2",
      ])
      .on("progress", (p) => onProgress && onProgress(p))
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * One track → use as-is. Several tracks → merge into one long AAC file.
 * Returns { path, generated } where generated is cleaned up after the job.
 */
async function resolveSlideshowAudio(audioFiles, jobId, onProgress) {
  if (audioFiles.length === 1) {
    return { path: audioFiles[0].path, generated: null };
  }
  const mergedPath = path.join(UPLOAD_DIR, `audio-merged-${jobId}.m4a`);
  await concatAudioTracks(
    audioFiles.map((f) => f.path),
    mergedPath,
    onProgress
  );
  return { path: mergedPath, generated: mergedPath };
}

function parseFfmpegTimemark(timemark) {
  if (!timemark || typeof timemark !== "string") return null;
  const parts = timemark.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Map ffmpeg progress into an absolute percent band using timemark (reliable for long jobs). */
function reportTimedProgress(onProgress, durationSec, startPct, endPct, p) {
  if (!onProgress) return;
  const t = parseFfmpegTimemark(p?.timemark);
  if (t != null && durationSec > 0) {
    const ratio = Math.min(1, Math.max(0, t / durationSec));
    onProgress({
      percent: startPct + ratio * (endPct - startPct),
      timemark: p.timemark,
    });
    return;
  }
  const pct = Number(p?.percent);
  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
    onProgress({
      percent: startPct + (pct / 100) * (endPct - startPct),
    });
  }
}

function runFfmpegSave(buildCmd) {
  return new Promise((resolve, reject) => {
    const cmd = buildCmd();
    cmd.on("error", reject).on("end", resolve);
  });
}

const PETAL_ASSETS_DIR = path.join(__dirname, "assets", "petals");
const PETAL_CACHE_VER = "v4";

/** Lit rose / blossom sprites — highlight + shade so they read as real petals. */
function petalSvgMarkup() {
  return [
    {
      name: "petal-blush",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">
        <defs>
          <linearGradient id="b1" x1="0.18" y1="0.04" x2="0.88" y2="1">
            <stop offset="0%" stop-color="#FFF6F8"/>
            <stop offset="32%" stop-color="#FFB3C7"/>
            <stop offset="68%" stop-color="#E11D74"/>
            <stop offset="100%" stop-color="#701A3A"/>
          </linearGradient>
          <radialGradient id="h1" cx="30%" cy="20%" r="48%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.78"/>
            <stop offset="42%" stop-color="#FFFFFF" stop-opacity="0.16"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="s1" x1="0.85" y1="0.1" x2="0.15" y2="1">
            <stop offset="0%" stop-color="#000" stop-opacity="0"/>
            <stop offset="100%" stop-color="#3F0A1C" stop-opacity="0.38"/>
          </linearGradient>
        </defs>
        <path d="M48 5C75 11 92 38 90 72C88 104 68 124 48 126C28 124 8 104 6 72C4 38 21 11 48 5Z" fill="url(#b1)"/>
        <path d="M48 5C75 11 92 38 90 72C88 104 68 124 48 126C28 124 8 104 6 72C4 38 21 11 48 5Z" fill="url(#h1)"/>
        <path d="M48 5C75 11 92 38 90 72C88 104 68 124 48 126C28 124 8 104 6 72C4 38 21 11 48 5Z" fill="url(#s1)"/>
        <path d="M48 18C52 54 52 90 48 116" fill="none" stroke="#ffffff66" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`,
    },
    {
      name: "petal-rose",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">
        <defs>
          <linearGradient id="b2" x1="0.2" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stop-color="#FFE4EC"/>
            <stop offset="40%" stop-color="#FB7185"/>
            <stop offset="100%" stop-color="#9F1239"/>
          </linearGradient>
          <radialGradient id="h2" cx="34%" cy="24%" r="46%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.7"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path d="M48 8C72 10 90 40 88 72C86 102 68 123 48 125C28 123 10 102 8 72C6 40 24 10 48 8Z" fill="url(#b2)"/>
        <path d="M48 8C72 10 90 40 88 72C86 102 68 123 48 125C28 123 10 102 8 72C6 40 24 10 48 8Z" fill="url(#h2)"/>
        <path d="M48 22C51 56 51 88 48 114" fill="none" stroke="#ffffff55" stroke-width="1.4"/>
      </svg>`,
    },
    {
      name: "petal-ivory",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">
        <defs>
          <linearGradient id="b3" x1="0.2" y1="0.05" x2="0.85" y2="1">
            <stop offset="0%" stop-color="#FFFFFF"/>
            <stop offset="45%" stop-color="#F4E6D0"/>
            <stop offset="100%" stop-color="#C4A484"/>
          </linearGradient>
          <radialGradient id="h3" cx="28%" cy="18%" r="50%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.85"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path d="M48 7C73 12 90 40 88 73C86 104 67 124 48 125C29 124 10 104 8 73C6 40 23 12 48 7Z" fill="url(#b3)"/>
        <path d="M48 7C73 12 90 40 88 73C86 104 67 124 48 125C29 124 10 104 8 73C6 40 23 12 48 7Z" fill="url(#h3)"/>
      </svg>`,
    },
    {
      name: "blossom-soft",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
        <defs>
          <radialGradient id="bp" cx="50%" cy="28%" r="72%">
            <stop offset="0%" stop-color="#FFF7FB"/>
            <stop offset="48%" stop-color="#FFB0C8"/>
            <stop offset="100%" stop-color="#BE185D"/>
          </radialGradient>
          <radialGradient id="bc" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#FFF3B0"/>
            <stop offset="100%" stop-color="#D97706"/>
          </radialGradient>
          <radialGradient id="bh" cx="36%" cy="32%" r="40%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g transform="translate(64 64)">
          <g transform="rotate(0)"><ellipse cx="0" cy="-21" rx="14" ry="28" fill="url(#bp)"/></g>
          <g transform="rotate(72)"><ellipse cx="0" cy="-21" rx="14" ry="28" fill="url(#bp)"/></g>
          <g transform="rotate(144)"><ellipse cx="0" cy="-21" rx="14" ry="28" fill="url(#bp)"/></g>
          <g transform="rotate(216)"><ellipse cx="0" cy="-21" rx="14" ry="28" fill="url(#bp)"/></g>
          <g transform="rotate(288)"><ellipse cx="0" cy="-21" rx="14" ry="28" fill="url(#bp)"/></g>
          <circle r="11" fill="url(#bc)"/>
          <circle r="36" fill="url(#bh)"/>
        </g>
      </svg>`,
    },
    {
      name: "petal-gold",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">
        <defs>
          <linearGradient id="b5" x1="0.15" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stop-color="#FFFBEB"/>
            <stop offset="40%" stop-color="#FBBF24"/>
            <stop offset="100%" stop-color="#B45309"/>
          </linearGradient>
          <radialGradient id="h5" cx="30%" cy="18%" r="48%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.72"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path d="M48 6C74 10 91 38 89 72C87 103 68 124 48 126C28 124 9 103 7 72C5 38 22 10 48 6Z" fill="url(#b5)"/>
        <path d="M48 6C74 10 91 38 89 72C87 103 68 124 48 126C28 124 9 103 7 72C5 38 22 10 48 6Z" fill="url(#h5)"/>
      </svg>`,
    },
  ];
}

async function ensurePetalPngs() {
  if (!fs.existsSync(PETAL_ASSETS_DIR)) {
    fs.mkdirSync(PETAL_ASSETS_DIR, { recursive: true });
  }
  const assets = petalSvgMarkup();
  const paths = [];
  for (const asset of assets) {
    const out = path.join(
      PETAL_ASSETS_DIR,
      `${PETAL_CACHE_VER}-${asset.name}.png`
    );
    if (!fs.existsSync(out)) {
      await sharp(Buffer.from(asset.svg))
        .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(out);
    }
    paths.push(out);
  }
  return paths;
}

/**
 * Deterministic falling-flower layout: mixed sizes, speeds and sway so the
 * rain looks continuous and never syncs into a grid.
 */
function buildFlowerRainSpecks(width, height, assetCount) {
  const perAsset = 4;
  const specks = [];
  for (let a = 0; a < assetCount; a++) {
    for (let k = 0; k < perAsset; k++) {
      const i = a * perAsset + k;
      const far = i % 3 === 0;
      const size = far ? 22 + ((i * 7) % 14) : 34 + ((i * 11) % 22);
      specks.push({
        asset: a,
        size,
        x0: Math.round(((i * 0.173 + a * 0.07) % 1) * width) - Math.round(size / 2),
        speed: Math.round(height * (far ? 0.038 + (i % 5) * 0.008 : 0.05 + (i % 6) * 0.01)),
        sway: 20 + (i * 11) % 32,
        period: (2.5 + (i % 5) * 0.65).toFixed(2),
        delay: Math.round((i * 97 + a * 53) % (height + 80)),
        phase: (i * 0.73).toFixed(2),
        alpha: far ? (0.4 + (i % 3) * 0.07).toFixed(2) : (0.58 + (i % 4) * 0.07).toFixed(2),
      });
    }
  }
  return specks;
}

function buildFlowerRainFilters(baseLabel, specks, petalInputOffset, height, outLabel = "vout") {
  const filters = [];
  const byAsset = new Map();
  for (const s of specks) {
    if (!byAsset.has(s.asset)) byAsset.set(s.asset, []);
    byAsset.get(s.asset).push(s);
  }

  const particles = [];
  for (const [asset, group] of byAsset) {
    const inIdx = petalInputOffset + asset;
    const splitPads = group.map((_, k) => `fs${asset}_${k}`);
    filters.push(
      `[${inIdx}:v]split=${group.length}${splitPads.map((p) => `[${p}]`).join("")}`
    );
    group.forEach((s, k) => {
      const pl = `fp${asset}_${k}`;
      filters.push(
        `[${splitPads[k]}]format=rgba,scale=${s.size}:${s.size}:flags=fast_bilinear,colorchannelmixer=aa=${s.alpha}[${pl}]`
      );
      particles.push({ ...s, pl });
    });
  }

  let cur = baseLabel;
  particles.forEach((p, i) => {
    const next = i === particles.length - 1 ? outLabel : `fl${i}`;
    const xExpr = `${p.x0}+${p.sway}*sin(2*PI*t/${p.period}+${p.phase})`;
    const yExpr = `mod(${p.speed}*t+${p.delay},${height}+h)-h`;
    filters.push(
      `[${cur}][${p.pl}]overlay=x='${xExpr}':y='${yExpr}'[${next}]`
    );
    cur = next;
  });

  return filters;
}

/**
 * Mux picture track with the song. When `loopVideo` is true the slide cycle
 * repeats until the audio ends (fast slideshow loop, not one slow pass).
 *
 * Visualizer = single-pass light advanced HUD (half-res color spectrum + wave)
 * encoded with VideoToolbox when available — avoids multi-hour CQT jobs.
 * Flowers = continuous rose / marigold rain over the full frame.
 */
async function muxSlideshowAudio(
  videoPath,
  audioPath,
  outputPath,
  durationSec,
  {
    loopVideo = false,
    visualizer = true,
    flowers = true,
    width = 1920,
    height = 1080,
    onProgress,
  } = {}
) {
  const commonAudio = [
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-t",
    durationSec.toFixed(3),
    "-shortest",
    "-movflags",
    "+faststart",
  ];

  if (!visualizer && !flowers) {
    if (onProgress) {
      onProgress({ percent: 88, stage: "muxing slides with music" });
    }
    await runFfmpegSave(() => {
      const cmd = ffmpeg();
      if (loopVideo) {
        cmd.input(videoPath).inputOptions(["-stream_loop", "-1"]);
      } else {
        cmd.input(videoPath);
      }
      return cmd
        .input(audioPath)
        .outputOptions([
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          ...commonAudio,
        ])
        .on("progress", (p) =>
          reportTimedProgress(onProgress, durationSec, 88, 99, p)
        )
        .save(outputPath);
    });
    return outputPath;
  }

  const petalPngs = flowers ? await ensurePetalPngs() : [];
  const specks = flowers
    ? buildFlowerRainSpecks(width, height, petalPngs.length)
    : [];

  const filters = [];
  let vLabel = "0:v";
  let audioMap = "1:a:0";

  if (visualizer) {
    const box = slideshowInnerBox(width, height, { visualizer: true });
    const dockW = evenDim(width);
    const dockH = box.vizH;
    filters.push(`[1:a]asplit=2[a_out][a_raw]`);
    // Log spectrum packs bass on the left — render half width, then mirror
    // so bars bounce across the full frame (not only the left side).
    const halfW = evenDim(Math.max(320, Math.round(dockW / 2)));
    const colors = randomVisualizerColors();
    filters.push(
      `color=c=black@0.32:s=${dockW}x${dockH}:r=${SLIDESHOW_FPS},format=yuva420p[grad]`
    );
    filters.push(
      `[a_raw]aformat=channel_layouts=mono,volume=1.85,showfreqs=s=${halfW}x${dockH}:mode=bar:ascale=sqrt:fscale=log:win_size=2048:overlap=0.92:averaging=1:colors=${colors}[freq]`
    );
    filters.push(
      `[freq]split[fl][fr];[fr]hflip[frf];[fl][frf]hstack=inputs=2[freqm]`
    );
    filters.push(
      `[freqm]scale=${dockW}:${dockH}:flags=fast_bilinear,colorkey=0x000000:0.08:0.2,format=yuva420p[bars]`
    );
    filters.push(
      `[0:v][grad]overlay=x=0:y=H-h[vfade]`
    );
    filters.push(
      `[vfade][bars]overlay=x=0:y=H-h:shortest=1[${flowers ? "vbars" : "vpre"}]`
    );
    vLabel = flowers ? "vbars" : "vpre";
    audioMap = "[a_out]";
  }

  if (flowers) {
    filters.push(
      ...buildFlowerRainFilters(vLabel, specks, 2, height, "vpre")
    );
  }

  filters.push(
    `[vpre]setsar=1,setdar=${width}/${height},format=yuv420p[vout]`
  );

  const stage = flowers
    ? visualizer
      ? "encoding with visualizer & flowers"
      : "encoding with falling flowers"
    : "encoding with visualizer";
  if (onProgress) {
    onProgress({ percent: 88, stage });
  }

  await runFfmpegSave(() => {
    const cmd = ffmpeg();
    if (loopVideo) {
      cmd.input(videoPath).inputOptions(["-stream_loop", "-1"]);
    } else {
      cmd.input(videoPath);
    }
    cmd.input(audioPath);
    for (const png of petalPngs) {
      cmd.input(png).inputOptions(["-loop", "1"]);
    }
    return cmd
      .complexFilter(filters.join(";"))
      .outputOptions([
        "-map",
        "[vout]",
        "-map",
        audioMap,
        ...slideshowEncodeOpts({ bitrate: "5M", crf: 23, mode: "final" }),
        "-aspect",
        `${width}:${height}`,
        ...commonAudio,
      ])
      .on("progress", (p) =>
        reportTimedProgress(onProgress, durationSec, 88, 99, p)
      )
      .save(outputPath);
  });

  return outputPath;
}

function pickSlideshowTransition() {
  return SLIDESHOW_XFADE_MIN + (SLIDESHOW_XFADE_MAX - SLIDESHOW_XFADE_MIN) * 0.5;
}

/** Visible hold + transition overlap → each clip length for xfade math. */
function slideshowClipDuration(transitionSec) {
  return SLIDESHOW_HOLD_SEC + transitionSec;
}

/**
 * Split a video into exactly `partsCount` equal-length pieces.
 * Stream-copies when no cover is applied; re-encodes when covering a region.
 */
function splitVideoIntoSegments(
  inputPath,
  partsDir,
  partsCount,
  durationSec,
  onProgress,
  options = {}
) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(partsDir)) {
        fs.mkdirSync(partsDir, { recursive: true });
      }
      const pattern = path.join(partsDir, "part_%03d.mp4");
      const cover = options.cover || null;
      const n = Math.max(SPLIT_PARTS_MIN, Math.min(SPLIT_PARTS_MAX, partsCount));
      const cuts = [];
      for (let i = 1; i < n; i++) {
        cuts.push(((durationSec * i) / n).toFixed(3));
      }
      const segmentTimes = cuts.join(",");
      const segmentOut = [
        "-f",
        "segment",
        "-segment_times",
        segmentTimes,
        "-reset_timestamps",
        "1",
        "-movflags",
        "+faststart",
      ];
      const encodeOut = [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-b:a",
        "192k",
        ...segmentOut,
      ];

      let cmd = ffmpeg(inputPath);

      if (cover && cover.mode === "image" && cover.imagePath) {
        const { x, y, w, h } = cover.region;
        cmd = ffmpeg()
          .input(inputPath)
          .input(cover.imagePath)
          .complexFilter([
            `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h}[stamp]`,
            `[0:v][stamp]overlay=${x}:${y}:format=auto[vout]`,
          ])
          .outputOptions(["-map", "[vout]", "-map", "0:a?", ...encodeOut]);
      } else if (cover && cover.mode === "blur") {
        cmd = cmd
          .complexFilter(buildCoverVideoFilter("blur", cover.region))
          .outputOptions(["-map", "[vout]", "-map", "0:a?", ...encodeOut]);
      } else if (cover && cover.mode === "text") {
        cmd = cmd
          .videoFilters(
            buildCoverVideoFilter("text", cover.region, {
              text: cover.text,
              bg: cover.bg,
              fontColor: cover.fontColor,
              fontScale: cover.fontScale,
            })
          )
          .outputOptions(encodeOut);
      } else {
        cmd = cmd.outputOptions([
          "-map",
          "0",
          "-c",
          "copy",
          ...segmentOut,
        ]);
      }

      cmd
        .on("progress", (p) => onProgress && onProgress(p))
        .on("error", reject)
        .on("end", () => {
          const parts = fs
            .readdirSync(partsDir)
            .filter((name) => /^part_\d+\.mp4$/i.test(name))
            .sort()
            .map((name) => path.join(partsDir, name));
          if (!parts.length) {
            reject(new Error("No segments were created"));
            return;
          }
          resolve(parts);
        })
        .save(pattern);
    } catch (err) {
      reject(err);
    }
  });
}

function zipFiles(filePaths, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 1 } });

    output.on("close", () => resolve(zipPath));
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }
    archive.finalize();
  });
}

/**
 * Compute a delogo rectangle for a known corner. The size is chosen to
 * comfortably cover the Grok-style watermark (logo icon + short text). FFmpeg
 * requires the rectangle to be strictly inside the frame, so we keep at least
 * a 2px margin from every edge.
 */
function calcWatermarkBox(width, height, position) {
  // Watermark is roughly ~17% of width and ~10% of height of typical Grok clips.
  // We slightly oversize the box so the entire logo is covered, including the
  // soft glow around it.
  const w = Math.max(60, Math.round(width * 0.18));
  const h = Math.max(28, Math.round(height * 0.11));
  const margin = Math.max(6, Math.round(width * 0.015));

  let x;
  let y;
  switch (position) {
    case "bottom-left":
      x = margin;
      y = height - h - margin;
      break;
    case "top-right":
      x = width - w - margin;
      y = margin;
      break;
    case "top-left":
      x = margin;
      y = margin;
      break;
    case "bottom-right":
    default:
      x = width - w - margin;
      y = height - h - margin;
      break;
  }

  // Clamp – delogo needs the rect strictly inside the frame (>= 1px border).
  x = Math.max(2, Math.min(x, width - w - 2));
  y = Math.max(2, Math.min(y, height - h - 2));
  return { x, y, w, h };
}

/**
 * Build moving delogo filters that track typical floating overlays like
 * "Visit - MicroTV.Top" (white outlined text drifting across the frame).
 * Returns an array of filter strings for fluent-ffmpeg.
 */
function buildFloatingTextDelogoFilter(width, height) {
  // Sized for a one-line promo string such as "Visit - MicroTV.Top".
  const bw = Math.max(140, Math.round(width * 0.58));
  const bh = Math.max(30, Math.round(height * 0.06));
  const maxX = width - bw - 2;
  const maxY = height - bh - 2;

  // Primary: Lissajous path across the middle of the frame.
  const x =
    `max(2\\,min(${maxX}\\,(w-${bw})/2+(w*0.30)*sin(2*PI*t/11)))`;
  const y =
    `max(2\\,min(${maxY}\\,(h-${bh})/2+(h*0.24)*sin(4*PI*t/11)))`;

  // Phase-offset second box increases catch rate for the moving text.
  const x2 =
    `max(2\\,min(${maxX}\\,(w-${bw})/2+(w*0.30)*sin(2*PI*t/11+1.4)))`;
  const y2 =
    `max(2\\,min(${maxY}\\,(h-${bh})/2+(h*0.24)*sin(4*PI*t/11+1.4)))`;

  // Static mid-frame box – catches the common resting spot from MicroTV clips.
  const sx = Math.max(2, Math.min(maxX, Math.round((width - bw) / 2)));
  const sy = Math.max(2, Math.min(maxY, Math.round(height * 0.52 - bh / 2)));

  return [
    `delogo=x='${x}':y='${y}':w=${bw}:h=${bh}:show=0`,
    `delogo=x='${x2}':y='${y2}':w=${bw}:h=${bh}:show=0`,
    `delogo=x=${sx}:y=${sy}:w=${bw}:h=${bh}:show=0`,
  ];
}

function resolveFontPath() {
  if (process.env.FFMPEG_FONT_PATH && fs.existsSync(process.env.FFMPEG_FONT_PATH)) {
    return process.env.FFMPEG_FONT_PATH;
  }
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function escapeDrawtext(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

function clampPct(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Map a user-drawn % box onto pixel coordinates inside the video frame. */
function parseCoverRegion(body, width, height) {
  const wPct = clampPct(body?.coverW, 4, 100);
  const hPct = clampPct(body?.coverH, 4, 100);
  const xPct = clampPct(body?.coverX, -100, 100);
  const yPct = clampPct(body?.coverY, -100, 100);
  let w = evenDim(Math.max(8, Math.round((wPct / 100) * width)));
  let h = evenDim(Math.max(8, Math.round((hPct / 100) * height)));
  let x = evenDim(Math.round((xPct / 100) * width));
  let y = evenDim(Math.round((yPct / 100) * height));
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  if (x < 2) {
    w = Math.max(8, w + x - 2);
    x = 2;
  }
  if (y < 2) {
    h = Math.max(8, h + y - 2);
    y = 2;
  }
  if (x + w > width - 2) w = Math.max(8, width - x - 2);
  if (y + h > height - 2) h = Math.max(8, height - y - 2);
  w = evenDim(Math.min(w, evenDim(width - 4)));
  h = evenDim(Math.min(h, evenDim(height - 4)));
  x = evenDim(Math.max(2, Math.min(x, width - w - 2)));
  y = evenDim(Math.max(2, Math.min(y, height - h - 2)));
  return { x, y, w, h, cx, cy };
}

function parseCoverMode(raw) {
  const mode = String(raw || "blur").toLowerCase();
  if (mode === "text" || mode === "image") return mode;
  return "blur";
}

function parseHexColor(raw, fallback = "111111") {
  const h = String(raw || "").replace("#", "").trim();
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : fallback;
}

function parseCoverFontScale(raw) {
  const n = Number(raw);
  if (n === 0.22 || n === 0.34 || n === 0.48) return n;
  return 0.34;
}

/**
 * Cover a user-placed rectangle: blur it, or stamp text / an image over it.
 */
function buildCoverVideoFilter(
  mode,
  region,
  {
    text = "",
    bg = "0x111111@0.88",
    fontColor = "0xFFFFFF",
    fontScale = 0.34,
  } = {}
) {
  const { x, y, w, h, cx, cy } = region;
  if (mode === "text") {
    const fontSize = Math.max(12, Math.round(Math.min(w, h) * fontScale));
    const fontPath = resolveFontPath();
    const fontOpt = fontPath ? `fontfile=${escapeFilterPath(fontPath)}:` : "";
    const label = escapeDrawtext(text.trim() || " ");
    const tx = Number.isFinite(cx) ? `${cx}-(tw/2)` : `${x}+(${w}-tw)/2`;
    const ty = Number.isFinite(cy) ? `${cy}-(th/2)` : `${y}+(${h}-th)/2`;
    const drawtext = `${fontOpt ? "drawtext=" + fontOpt : "drawtext="}text='${label}':x=${tx}:y=${ty}:fontsize=${fontSize}:fontcolor=${fontColor}:borderw=1:bordercolor=black@0.35`;
    if (!bg) return drawtext;
    return [
      `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${bg}:t=fill`,
      drawtext,
    ].join(",");
  }
  // blur: crop the box, soften, lay it back
  return [
    `[0:v]split[main][src]`,
    `[src]crop=${w}:${h}:${x}:${y},boxblur=14:2[blur]`,
    `[main][blur]overlay=${x}:${y}[vout]`,
  ];
}

/**
 * Build a drawtext filter that slowly moves the brand name across the frame in
 * a smooth figure-8 path so it stays visible but hard to crop out.
 */
function buildFloatingTextFilter(text, width, height) {
  const fontSize = Math.max(20, Math.round(Math.min(width, height) * 0.05));
  const fontPath = resolveFontPath();
  const fontOpt = fontPath ? `fontfile=${escapeFilterPath(fontPath)}:` : "";
  const label = escapeDrawtext(text.trim());

  // Lissajous-style motion – text keeps moving across the whole canvas.
  const x = `(w-tw)/2+(w/2.8)*sin(2*PI*t/14)`;
  const y = `(h-th)/2+(h/3.2)*sin(4*PI*t/14)`;

  return (
    `drawtext=${fontOpt}` +
    `text='${label}':` +
    `fontsize=${fontSize}:` +
    `fontcolor=white@0.42:` +
    `shadowcolor=black@0.55:shadowx=2:shadowy=2:` +
    `x='${x}':y='${y}'`
  );
}

/**
 * Normalise a single input video to a known codec, resolution & frame rate so
 * that concatenation works seamlessly.
 *
 * options.cover — user-placed box (percent) on the source frame:
 *   blur | text+background | image stamp, applied before scale/pad.
 */
async function normaliseClip(inputPath, outputPath, options = {}) {
  const target = options.target || LAYOUT_SIZES.landscape;
  const playbackSpeed = options.playbackSpeed || 1;
  const cover = options.cover || null;
  const { width: tw, height: th } = target;

  let srcW = tw;
  let srcH = th;
  let hasAudio = true;
  try {
    const meta = await probeMedia(inputPath);
    srcW = meta.width || tw;
    srcH = meta.height || th;
    hasAudio = meta.hasAudio !== false;
  } catch (err) {
    console.warn("probeVideo failed:", err.message);
  }

  const tail = [
    `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
    `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`,
    "setsar=1",
  ];
  if (options.addFloatingText && options.brandText?.trim()) {
    tail.push(buildFloatingTextFilter(options.brandText, tw, th));
  }
  if (playbackSpeed !== 1) {
    tail.push(`setpts=${(1 / playbackSpeed).toFixed(6)}*PTS`);
  }
  const tailStr = tail.join(",");

  const region = cover ? parseCoverRegion(cover, srcW, srcH) : null;

  return new Promise((resolve, reject) => {
    const outputOptions = [
      "-preset veryfast",
      "-crf 20",
      "-pix_fmt yuv420p",
      "-r 30",
      "-movflags +faststart",
    ];

    if (hasAudio) {
      outputOptions.push("-ar 44100", "-ac 2", "-b:a 192k");
    } else {
      outputOptions.push("-an");
    }

    let cmd;

    if (cover && cover.mode === "image" && cover.imagePath && region) {
      const { x, y, w, h } = region;
      cmd = ffmpeg()
        .input(inputPath)
        .input(cover.imagePath)
        .complexFilter([
          `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h}[stamp]`,
          `[0:v][stamp]overlay=${x}:${y}:format=auto[cov]`,
          `[cov]${tailStr}[vout]`,
        ])
        .outputOptions(["-map", "[vout]", ...(hasAudio ? ["-map", "0:a"] : ["-an"]), ...outputOptions]);
    } else if (cover && cover.mode === "blur" && region) {
      const { x, y, w, h } = region;
      cmd = ffmpeg(inputPath)
        .complexFilter([
          `[0:v]split[main][src]`,
          `[src]crop=${w}:${h}:${x}:${y},boxblur=14:2[blur]`,
          `[main][blur]overlay=${x}:${y}[cov]`,
          `[cov]${tailStr}[vout]`,
        ])
        .outputOptions(["-map", "[vout]", ...(hasAudio ? ["-map", "0:a"] : ["-an"]), ...outputOptions]);
    } else {
      const filters = [];
      if (cover && cover.mode === "text" && region) {
        filters.push(
          buildCoverVideoFilter("text", region, {
            text: cover.text,
            bg: cover.bg,
            fontColor: cover.fontColor,
            fontScale: cover.fontScale,
          })
        );
      }
      filters.push(tailStr);
      cmd = ffmpeg(inputPath)
        .videoFilters(filters.join(","))
        .outputOptions(outputOptions);
    }

    cmd.videoCodec("libx264");
    if (hasAudio) {
      cmd.audioCodec("aac");
      if (playbackSpeed !== 1) {
        cmd.audioFilters(`atempo=${playbackSpeed}`);
      }
    }

    cmd
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * Concatenate the already normalised clips using the FFmpeg `concat` demuxer.
 * Because every clip now shares the same codecs/params we can stream-copy and
 * the operation is fast.
 */
function concatClips(normalisedPaths, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(
      os.tmpdir(),
      `concat-${crypto.randomBytes(4).toString("hex")}.txt`
    );
    const listContent = normalisedPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listFile, listContent);

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy", "-movflags +faststart"])
      .on("progress", (p) => onProgress && onProgress(p))
      .on("error", (err) => {
        fs.promises.unlink(listFile).catch(() => {});
        reject(err);
      })
      .on("end", () => {
        fs.promises.unlink(listFile).catch(() => {});
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "video-merge-backend" });
});

function duetAudioChain(inputRef, outLabel, durationSec) {
  const d = durationSec.toFixed(3);
  return (
    `[${inputRef}]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
    `atrim=duration=${d},asetpts=PTS-STARTPTS,apad=whole_dur=${d}[${outLabel}]`
  );
}

function parseDuetFontSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 28;
  return Math.max(12, Math.min(120, Math.round(n)));
}

function parseDuetPercent(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(98, n));
}

function isFormFlagTrue(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return /^(true|1|yes|on)$/i.test(String(v ?? "").trim());
}

/** Drop audio from a muted clip so FFmpeg cannot leak the original track. */
function remuxWithoutAudio(inputPath) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir, `${parsed.name}-nosound${parsed.ext}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart"])
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

const DUET_FONT_FILES = {
  jakarta: [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  ],
  bebas: [
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
  ],
  playfair: [
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
  ],
  pacifico: [
    "/System/Library/Fonts/Supplemental/Brush Script.ttf",
    "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
  ],
  oswald: [
    "/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ],
  mono: [
    "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
  ],
  comic: [
    "/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf",
    "/System/Library/Fonts/Supplemental/ChalkboardSE.ttc",
  ],
  merri: [
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
  ],
};

function parseDuetFont(raw) {
  const id = String(raw || "jakarta").toLowerCase();
  return DUET_FONT_FILES[id] ? id : "jakarta";
}

function resolveDuetFontPath(fontId) {
  const list = DUET_FONT_FILES[parseDuetFont(fontId)] || DUET_FONT_FILES.jakarta;
  return list.find((p) => fs.existsSync(p)) || resolveFontPath();
}

function parseDuetOverlay(body) {
  const text = String(body?.overlayText || "").trim().slice(0, 120);
  if (!text) return null;
  const bgTransparent = String(body?.overlayBgTransparent || "") === "true";
  return {
    text,
    textColor: parseHexColor(body?.overlayTextColor, "ffffff"),
    bgColor: parseHexColor(body?.overlayBgColor, "111111"),
    bgTransparent,
    fontSize: parseDuetFontSize(body?.overlayFontSize),
    font: parseDuetFont(body?.overlayFont),
    x: parseDuetPercent(body?.overlayX, 50),
    y: parseDuetPercent(body?.overlayY, 50),
  };
}

function buildDuetTextOverlay(overlay) {
  if (!overlay?.text) return "";
  const fontPath = resolveDuetFontPath(overlay.font);
  const fontOpt = fontPath ? `fontfile=${escapeFilterPath(fontPath)}:` : "";
  const label = escapeDrawtext(overlay.text);
  const fontSize = parseDuetFontSize(overlay.fontSize);
  const fontColor = `0x${overlay.textColor || "ffffff"}`;
  const x = (parseDuetPercent(overlay.x, 50) / 100).toFixed(4);
  const y = (parseDuetPercent(overlay.y, 50) / 100).toFixed(4);
  const box = overlay.bgTransparent
    ? ""
    : `:box=1:boxcolor=0x${overlay.bgColor || "111111"}@0.88:boxborderw=${Math.max(10, Math.round(fontSize * 0.45))}`;
  return (
    `drawtext=${fontOpt}text='${label}':x=(w*${x})-(tw/2):y=(h*${y})-(th/2):` +
    `fontsize=${fontSize}:fontcolor=${fontColor}${box}:` +
    `borderw=1:bordercolor=black@0.35`
  );
}

function parseDuetSplitTop(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(22, Math.min(78, n));
}

function duetSplitHeights(splitTopPercent) {
  const usable = DUET_HEIGHT - DUET_BAR_H;
  const pct = parseDuetSplitTop(splitTopPercent);
  let topH = Math.round((usable * pct) / 100);
  topH = Math.max(2, Math.min(usable - 2, topH));
  if (topH % 2) topH += topH + 1 <= usable - 2 ? 1 : -1;
  return { topH, botH: usable - topH };
}

function resolveDuetPanes(body) {
  const usable = DUET_HEIGHT - DUET_BAR_H;
  let topH = Math.round(Number(body?.topH));
  let botH = Math.round(Number(body?.botH));
  if (Number.isFinite(topH) && Number.isFinite(botH) && topH >= 2 && botH >= 2) {
    if (topH % 2) topH += 1;
    if (botH % 2) botH += 1;
    if (topH + botH === usable) return { topH, botH };
    const scaled = Math.round((topH / (topH + botH)) * usable);
    topH = Math.max(2, Math.min(usable - 2, scaled));
    if (topH % 2) topH += topH + 1 <= usable - 2 ? 1 : -1;
    return { topH, botH: usable - topH };
  }
  return duetSplitHeights(body?.splitTop);
}

function parseDuetFit(raw) {
  return String(raw || "contain").toLowerCase() === "cover" ? "cover" : "contain";
}

function parseDuetPosY(raw, fallback = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function duetVideoChain(
  inputRef,
  outLabel,
  durationSec,
  padSec,
  paneH = DUET_PANE_H,
  fit = "contain",
  posY = 50
) {
  const d = durationSec.toFixed(3);
  const h = Math.max(2, Math.round(Number(paneH) || DUET_PANE_H));
  const yMul = (parseDuetPosY(posY) / 100).toFixed(4);
  const norm = `[${inputRef}]scale=iw*sar:ih:force_divisible_by=2,setsar=1`;
  const sized =
    fit === "cover"
      ? `${norm},scale=${DUET_WIDTH}:${h}:force_original_aspect_ratio=increase:flags=bilinear,` +
        `crop=${DUET_WIDTH}:${h}:(iw-${DUET_WIDTH})/2:(ih-${h})*${yMul}`
      : `${norm},scale=${DUET_WIDTH}:${h}:force_original_aspect_ratio=decrease:flags=bilinear,` +
        `pad=${DUET_WIDTH}:${h}:(ow-iw)/2:(oh-ih)*${yMul}:color=0x07080c`;
  const parts = [sized, "setsar=1", `fps=${DUET_FPS}`, "format=yuv420p"];
  if (padSec > 0.04) {
    parts.push(`tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`);
  }
  parts.push(`trim=duration=${d}`, "setpts=PTS-STARTPTS");
  return `${parts.join(",")}[${outLabel}]`;
}

function duetFullVideoChain(inputRef, outLabel, durationSec) {
  const d = durationSec.toFixed(3);
  return (
    `[${inputRef}]scale=iw*sar:ih:force_divisible_by=2,setsar=1,` +
    `scale=${DUET_WIDTH}:${DUET_HEIGHT}:force_original_aspect_ratio=increase:flags=bilinear,` +
    `crop=${DUET_WIDTH}:${DUET_HEIGHT},setsar=1,fps=${DUET_FPS},format=yuv420p,` +
    `trim=duration=${d},setpts=PTS-STARTPTS[${outLabel}]`
  );
}

function parseDuetLayout(raw) {
  return String(raw || "split").toLowerCase() === "circle" ? "circle" : "split";
}

function duetCircleChain(inputRef, outLabel, durationSec, padSec, size) {
  const d = durationSec.toFixed(3);
  const parts = [
    `[${inputRef}]scale=${size}:${size}:force_original_aspect_ratio=increase:flags=bilinear`,
    `crop=${size}:${size}`,
    `fps=${DUET_FPS}`,
    "format=rgba",
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2-1),255,0)'`,
  ];
  if (padSec > 0.04) {
    parts.push(`tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`);
  }
  parts.push(`trim=duration=${d}`, "setpts=PTS-STARTPTS");
  return `${parts.join(",")}[${outLabel}]`;
}

/**
 * Stack two clips in a 1080×1920 portrait frame (top / divider / bottom)
 * and mix audio from whichever sources the user left enabled.
 */
function renderDuet({
  topPath,
  bottomPath,
  topCustomAudioPath,
  bottomCustomAudioPath,
  useTopAudio,
  useBottomAudio,
  useTopCustom,
  useBottomCustom,
  topDuration,
  bottomDuration,
  overlay,
  overlayImagePath,
  layout,
  pipX,
  pipY,
  splitTop,
  paneTopH,
  paneBotH,
  topFit,
  bottomFit,
  topPosY,
  bottomPosY,
  outputPath,
  onProgress,
}) {
  const single = !bottomPath;
  const circle = !single && layout === "circle";
  const durationSec = Math.max(topDuration, bottomDuration || 0, 0.2);
  const textFilter = overlayImagePath ? "" : buildDuetTextOverlay(overlay);
  const x = (parseDuetPercent(overlay?.x, 50) / 100).toFixed(4);
  const y = (parseDuetPercent(overlay?.y, 50) / 100).toFixed(4);
  const px = (parseDuetPercent(pipX, 82) / 100).toFixed(4);
  const py = (parseDuetPercent(pipY, 89) / 100).toFixed(4);
  const useStamp = Boolean(overlayImagePath);
  const needPre = useStamp || Boolean(textFilter);
  const filters = [];

  if (single) {
    filters.push(duetFullVideoChain("0:v", needPre ? "vpre" : "v", durationSec));
  } else if (circle) {
    const outer = DUET_PIP_SIZE + DUET_PIP_RING * 2;
    const d = durationSec.toFixed(3);
    filters.push(duetFullVideoChain("0:v", "base", durationSec));
    filters.push(
      duetCircleChain(
        "1:v",
        "circ",
        durationSec,
        durationSec - bottomDuration,
        DUET_PIP_SIZE
      )
    );
    filters.push(
      `color=c=white:s=${outer}x${outer}:d=${d},format=rgba,geq=r='255':g='255':b='255':a='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2-1),255,0)'[ring]`,
      "[ring][circ]overlay=(W-w)/2:(H-h)/2:format=auto[pip]",
      `[base][pip]overlay=x=(main_w*${px})-(overlay_w/2):y=(main_h*${py})-(overlay_h/2):format=auto[${
        needPre ? "vpre" : "v"
      }]`
    );
  } else {
    const { topH, botH } = resolveDuetPanes({
      splitTop,
      topH: paneTopH,
      botH: paneBotH,
    });
    filters.push(
      duetVideoChain(
        "0:v",
        "top",
        durationSec,
        durationSec - topDuration,
        topH,
        parseDuetFit(topFit),
        topPosY
      ),
      duetVideoChain(
        "1:v",
        "bot",
        durationSec,
        durationSec - bottomDuration,
        botH,
        parseDuetFit(bottomFit),
        bottomPosY
      ),
      `color=c=0x2a2a2e:s=${DUET_WIDTH}x${DUET_BAR_H}:d=${durationSec.toFixed(3)},fps=${DUET_FPS},format=yuv420p[bar]`,
      needPre
        ? "[top][bar][bot]vstack=inputs=3[vpre]"
        : "[top][bar][bot]vstack=inputs=3[v]"
    );
  }

  let nextIndex = single ? 1 : 2;
  let overlayImageIndex = null;
  if (useStamp) overlayImageIndex = nextIndex++;
  if (useStamp) {
    filters.push(
      `[${overlayImageIndex}:v]format=rgba[stamp]`,
      `[vpre][stamp]overlay=x=(main_w*${x})-(overlay_w/2):y=(main_h*${y})-(overlay_h/2):format=auto[v]`
    );
  } else if (textFilter) {
    filters.push(`[vpre]${textFilter}[v]`);
  }

  let topCustomIndex = null;
  let bottomCustomIndex = null;
  if (useTopCustom && topCustomAudioPath) topCustomIndex = nextIndex++;
  if (useBottomCustom && bottomCustomAudioPath) bottomCustomIndex = nextIndex++;

  const audioLabels = [];
  if (useTopCustom && topCustomIndex != null) {
    filters.push(duetAudioChain(`${topCustomIndex}:a`, "a0", durationSec));
    audioLabels.push("[a0]");
  } else if (useTopAudio) {
    filters.push(duetAudioChain("0:a", "a0", durationSec));
    audioLabels.push("[a0]");
  }
  if (useBottomCustom && bottomCustomIndex != null) {
    filters.push(duetAudioChain(`${bottomCustomIndex}:a`, "a1", durationSec));
    audioLabels.push("[a1]");
  } else if (useBottomAudio) {
    filters.push(duetAudioChain("1:a", "a1", durationSec));
    audioLabels.push("[a1]");
  }

  const wantAudio = audioLabels.length > 0;
  if (wantAudio && audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}aresample=44100[a]`);
  } else if (wantAudio) {
    filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=2:normalize=1[a]`
    );
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(topPath);
    if (!single) cmd.input(bottomPath);
    if (overlayImageIndex != null) {
      cmd.input(overlayImagePath).inputOptions(["-loop", "1"]);
    }
    if (topCustomIndex != null) {
      cmd.input(topCustomAudioPath).inputOptions(["-stream_loop", "-1"]);
    }
    if (bottomCustomIndex != null) {
      cmd.input(bottomCustomAudioPath).inputOptions(["-stream_loop", "-1"]);
    }

    const audioOut = wantAudio
      ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100"]
      : ["-an"];

    cmd
      .complexFilter(filters)
      .outputOptions([
        "-map",
        "[v]",
        ...audioOut,
        ...slideshowEncodeOpts({ mode: "final", bitrate: "8M", crf: 20 }),
        "-t",
        durationSec.toFixed(3),
        "-movflags",
        "+faststart",
        "-dn",
        "-sn",
      ])
      .on("progress", (p) =>
        reportTimedProgress(onProgress, durationSec, 12, 99, p)
      )
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * POST /api/merge
 *   multipart/form-data with:
 *     videos:           video files (>=1 if cover/brand/speed, else >=2)
 *     coverOn:          "true" | "false" — cover a user-placed rectangle
 *     coverMode:        blur | text | image
 *     coverX/Y/W/H:     region in percent of the source frame
 *     coverText:        replacement text (mode=text)
 *     coverImage:       replacement image (mode=image)
 *     addFloatingText:  "true" | "false" (optional, default false)
 *     brandText:        company name shown as moving overlay (optional)
 *     playbackSpeed:    0.5 | 0.75 | 1 | 1.25 | 1.5 | 2 (optional, default 1)
 *
 *   The order of the uploaded files defines the order in the merged output.
 *
 * Response: { jobId, statusUrl, downloadUrl }
 */
app.post(
  "/api/merge",
  upload.fields([
    { name: "videos", maxCount: 20 },
    { name: "coverImage", maxCount: 1 },
  ]),
  async (req, res) => {
  const videoFiles = req.files?.videos || [];
  const coverImageFile = req.files?.coverImage?.[0];
  const coverOn = String(req.body?.coverOn ?? "false") === "true";
  const coverMode = parseCoverMode(req.body?.coverMode);
  const layoutRaw = (req.body?.layout || "auto").toString();
  const layout = VALID_LAYOUTS.has(layoutRaw) ? layoutRaw : "auto";
  const addFloatingText =
    req.body?.addFloatingText === "true" || req.body?.addFloatingText === true;
  const brandText = (req.body?.brandText || "").toString().trim().slice(0, 80);
  const playbackSpeed = parsePlaybackSpeed(req.body?.playbackSpeed);

  const uploadedPaths = [
    ...videoFiles.map((f) => f.path),
    coverImageFile?.path,
  ].filter(Boolean);

  if (addFloatingText && !brandText) {
    cleanupFiles(uploadedPaths);
    return res.status(400).json({
      error: "Please enter your company name for the floating watermark",
    });
  }
  if (coverOn && coverMode === "text" && !String(req.body?.coverText || "").trim()) {
    cleanupFiles(uploadedPaths);
    return res.status(400).json({
      error: "Enter the text that should cover the watermark",
    });
  }
  if (coverOn && coverMode === "image" && !coverImageFile) {
    cleanupFiles(uploadedPaths);
    return res.status(400).json({
      error: "Upload an image to place over the watermark",
    });
  }

  const minFiles =
    coverOn || addFloatingText || playbackSpeed !== 1 ? 1 : 2;

  if (videoFiles.length < minFiles) {
    cleanupFiles(uploadedPaths);
    return res.status(400).json({
      error:
        minFiles === 1
          ? "Please upload at least 1 video"
          : "Please upload at least 2 videos to merge",
    });
  }

  const cover = coverOn
    ? {
        mode: coverMode,
        coverX: req.body?.coverX,
        coverY: req.body?.coverY,
        coverW: req.body?.coverW,
        coverH: req.body?.coverH,
        text: String(req.body?.coverText || "").trim(),
        bg:
          String(req.body?.coverBgTransparent) === "true"
            ? null
            : `0x${parseHexColor(req.body?.coverBgColor, "111111")}@0.88`,
        fontColor: `0x${parseHexColor(req.body?.coverTextColor, "ffffff")}`,
        fontScale: parseCoverFontScale(req.body?.coverFontScale),
        imagePath: coverImageFile?.path || null,
      }
    : null;

  const jobId = uuidv4();
  clearOutputDir();
  clearUploadsDir(uploadedPaths);
  const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAMES.merge);
  const normalisedPaths = [];
  const singleVideo = videoFiles.length === 1;

  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    stage: cover
      ? "covering watermark"
      : addFloatingText
      ? "adding brand watermark"
      : "normalising",
    outputPath,
    downloadName: OUTPUT_NAMES.merge,
  });

  // Respond immediately so the client can start polling.
  res.json({
    jobId,
    statusUrl: `/api/status/${jobId}`,
    downloadUrl: `/api/download/${jobId}`,
  });

  try {
    // Resolve the target canvas size ONCE based on the first clip (in auto
    // mode) so that every clip in the merge gets the same target. Mixing
    // canvas sizes between clips would break concat.
    const target = await resolveLayout(layout, videoFiles[0].path);

    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      // If only one file, write the processed output straight to the final
      // path – no need for a separate concat pass.
      const normPath = singleVideo
        ? outputPath
        : path.join(UPLOAD_DIR, `norm-${jobId}-${i}.mp4`);

      await normaliseClip(file.path, normPath, {
        cover,
        target,
        addFloatingText,
        brandText,
        playbackSpeed,
      });

      if (!singleVideo) normalisedPaths.push(normPath);

      const job = jobs.get(jobId);
      if (job) {
        if (singleVideo) {
          job.progress = 95;
          job.stage = cover ? "covering watermark" : "processing video";
        } else {
          job.progress = Math.round(((i + 1) / videoFiles.length) * 70);
          job.stage = `${
            cover ? "covering" : "normalising"
          } clip ${i + 1}/${videoFiles.length}`;
        }
      }
    }

    if (!singleVideo) {
      const job = jobs.get(jobId);
      if (job) {
        job.stage = "merging";
        job.progress = 75;
      }

      await concatClips(normalisedPaths, outputPath, (p) => {
        const j = jobs.get(jobId);
        if (j && p.percent) {
          j.progress = Math.min(99, 75 + Math.round(p.percent * 0.25));
        }
      });
    }

    const finalJob = jobs.get(jobId);
    if (finalJob) {
      finalJob.status = "done";
      finalJob.progress = 100;
      finalJob.stage = "complete";
    }
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = err.message || "Processing failed";
    }
  } finally {
    cleanupFiles(uploadedPaths);
    cleanupFiles(normalisedPaths);
    clearUploadsDir();
  }
});

/**
 * POST /api/duet
 *   multipart/form-data with:
 *     videoTop:     first clip (required if videoBottom is missing)
 *     videoBottom:  second clip (optional — omit for a full-screen portrait)
 *     audioTop:     optional custom soundtrack for the top clip
 *     audioBottom:  optional custom soundtrack for the bottom clip
 *     muteTop:      "true" | "false"
 *     muteBottom:   "true" | "false"
 *
 *   Stacks both clips in a 1080×1920 portrait frame (TikTok / Reels duet).
 *   Duration follows the longer clip; the shorter one freezes on the last frame.
 *   Audio is mixed from whichever sources stay enabled.
 *
 * Response: { jobId, statusUrl, downloadUrl }
 */
app.post(
  "/api/duet",
  uploadDuet.fields([
    { name: "videoTop", maxCount: 1 },
    { name: "videoBottom", maxCount: 1 },
    { name: "audioTop", maxCount: 1 },
    { name: "audioBottom", maxCount: 1 },
    { name: "overlayImage", maxCount: 1 },
  ]),
  async (req, res) => {
    const topFile = req.files?.videoTop?.[0];
    const bottomFile = req.files?.videoBottom?.[0];
    const audioTopFile = req.files?.audioTop?.[0];
    const audioBottomFile = req.files?.audioBottom?.[0];
    const overlayImageFile = req.files?.overlayImage?.[0];
    const uploadedPaths = [
      topFile?.path,
      bottomFile?.path,
      audioTopFile?.path,
      audioBottomFile?.path,
      overlayImageFile?.path,
    ].filter(Boolean);

    if (!topFile && !bottomFile) {
      cleanupFiles(uploadedPaths);
      return res.status(400).json({
        error: "Upload at least one video",
      });
    }

    const muteTop = isFormFlagTrue(req.body?.muteTop);
    const muteBottom = isFormFlagTrue(req.body?.muteBottom);

    const jobId = uuidv4();
    clearOutputDir();
    clearUploadsDir(uploadedPaths);
    const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAMES.duet);

    jobs.set(jobId, {
      status: "processing",
      progress: 2,
      stage: "reading clips",
      outputPath,
      downloadName: OUTPUT_NAMES.duet,
    });

    res.json({
      jobId,
      statusUrl: `/api/status/${jobId}`,
      downloadUrl: `/api/download/${jobId}`,
    });

    try {
      const singleFile = topFile && bottomFile ? null : topFile || bottomFile;
      const topMeta = topFile ? await probeMedia(topFile.path) : null;
      const bottomMeta = bottomFile ? await probeMedia(bottomFile.path) : null;
      const topDuration = topFile ? await probeDuration(topFile.path) : 0;
      const bottomDuration = bottomFile
        ? await probeDuration(bottomFile.path)
        : 0;

      const job = jobs.get(jobId);
      if (job) {
        job.progress = 10;
        job.stage = singleFile
          ? "encoding portrait video"
          : "stacking portrait duet";
      }

      const soloIsTop = Boolean(topFile);
      const soloMuted = soloIsTop ? muteTop : muteBottom;
      const scratchPaths = [];
      async function pathForClip(file, muted, meta) {
        if (!file) return null;
        if (!muted || !meta?.hasAudio) return file.path;
        try {
          const silentPath = await remuxWithoutAudio(file.path);
          scratchPaths.push(silentPath);
          return silentPath;
        } catch {
          return file.path;
        }
      }
      const topRenderPath = singleFile
        ? await pathForClip(
            singleFile,
            soloMuted,
            soloIsTop ? topMeta : bottomMeta
          )
        : await pathForClip(topFile, muteTop, topMeta);
      const bottomRenderPath = singleFile
        ? null
        : await pathForClip(bottomFile, muteBottom, bottomMeta);
      uploadedPaths.push(...scratchPaths);

      await renderDuet({
        topPath: topRenderPath,
        bottomPath: bottomRenderPath,
        topCustomAudioPath: singleFile
          ? soloMuted
            ? null
            : (soloIsTop ? audioTopFile : audioBottomFile)?.path || null
          : muteTop
            ? null
            : audioTopFile?.path || null,
        bottomCustomAudioPath: singleFile
          ? null
          : muteBottom
            ? null
            : audioBottomFile?.path || null,
        useTopAudio: singleFile
          ? !soloMuted &&
            !(soloIsTop ? audioTopFile : audioBottomFile) &&
            Boolean((soloIsTop ? topMeta : bottomMeta)?.hasAudio)
          : !muteTop && !audioTopFile && Boolean(topMeta?.hasAudio),
        useBottomAudio: singleFile
          ? false
          : !muteBottom && !audioBottomFile && Boolean(bottomMeta?.hasAudio),
        useTopCustom: singleFile
          ? !soloMuted && Boolean(soloIsTop ? audioTopFile : audioBottomFile)
          : !muteTop && Boolean(audioTopFile),
        useBottomCustom: singleFile
          ? false
          : !muteBottom && Boolean(audioBottomFile),
        topDuration: singleFile
          ? soloIsTop
            ? topDuration
            : bottomDuration
          : topDuration,
        bottomDuration: singleFile ? 0 : bottomDuration,
        overlay: parseDuetOverlay(req.body),
        overlayImagePath: overlayImageFile?.path || null,
        layout: parseDuetLayout(req.body?.layout),
        pipX: parseDuetPercent(req.body?.pipX, 82),
        pipY: parseDuetPercent(req.body?.pipY, 89),
        splitTop: parseDuetSplitTop(req.body?.splitTop),
        paneTopH: req.body?.topH,
        paneBotH: req.body?.botH,
        topFit: parseDuetFit(req.body?.topFit),
        bottomFit: parseDuetFit(req.body?.bottomFit),
        topPosY: parseDuetPosY(req.body?.topPosY),
        bottomPosY: parseDuetPosY(req.body?.bottomPosY),
        outputPath,
        onProgress: (p) => {
          const j = jobs.get(jobId);
          if (j && Number.isFinite(p?.percent)) {
            j.progress = Math.min(99, Math.round(p.percent));
            j.stage = "encoding duet";
          }
        },
      });

      const done = jobs.get(jobId);
      if (done) {
        done.status = "done";
        done.progress = 100;
        done.stage = "complete";
      }
    } catch (err) {
      console.error(`Duet job ${jobId} failed:`, err);
      const job = jobs.get(jobId);
      if (job) {
        job.status = "error";
        job.error = err.message || "Duet processing failed";
      }
    } finally {
      cleanupFiles(uploadedPaths);
      clearUploadsDir();
    }
  }
);

/**
 * POST /api/split
 *   multipart/form-data with:
 *     video:       single video file
 *     parts:       how many equal parts (2–80, default 2)
 *     coverOn:     "true" | "false" — cover a user-placed rectangle
 *     coverMode:   blur | text | image
 *     coverX/Y/W/H: region in percent of the frame
 *     coverText:   replacement text (mode=text)
 *     coverImage:  replacement image file (mode=image)
 *
 *   Splits the upload into N equal parts and returns a ZIP of the parts.
 *
 * Response: { jobId, statusUrl, downloadUrl }
 */
app.post(
  "/api/split",
  uploadSplit.fields([
    { name: "video", maxCount: 1 },
    { name: "coverImage", maxCount: 1 },
  ]),
  async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const coverImageFile = req.files?.coverImage?.[0];
  if (!videoFile) {
    cleanupFiles([coverImageFile?.path].filter(Boolean));
    return res.status(400).json({ error: "Please upload one video to split" });
  }

  const partsCount = parseSplitPartCount(req.body?.parts);
  const coverOn = String(req.body?.coverOn ?? "false") === "true";
  const coverMode = parseCoverMode(req.body?.coverMode);

  if (coverOn && coverMode === "text" && !String(req.body?.coverText || "").trim()) {
    cleanupFiles([videoFile.path, coverImageFile?.path].filter(Boolean));
    return res.status(400).json({ error: "Enter the text that should cover the watermark" });
  }
  if (coverOn && coverMode === "image" && !coverImageFile) {
    cleanupFiles([videoFile.path]);
    return res.status(400).json({ error: "Upload an image to place over the watermark" });
  }

  const jobId = uuidv4();
  clearOutputDir();
  clearUploadsDir([videoFile.path, coverImageFile?.path].filter(Boolean));
  const partsDir = path.join(UPLOAD_DIR, `split-${jobId}`);
  const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAMES.split);
  let partPaths = [];

  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    stage: "probing",
    outputPath,
    downloadName: OUTPUT_NAMES.split,
  });

  res.json({
    jobId,
    statusUrl: `/api/status/${jobId}`,
    downloadUrl: `/api/download/${jobId}`,
  });

  try {
    const duration = await probeDuration(videoFile.path);
    let cover = null;
    if (coverOn) {
      const { width, height } = await probeMedia(videoFile.path);
      cover = {
        mode: coverMode,
        region: parseCoverRegion(req.body, width, height),
        text: String(req.body?.coverText || "").trim(),
        bg:
          String(req.body?.coverBgTransparent) === "true"
            ? null
            : `0x${parseHexColor(req.body?.coverBgColor, "111111")}@0.88`,
        fontColor: `0x${parseHexColor(req.body?.coverTextColor, "ffffff")}`,
        fontScale: parseCoverFontScale(req.body?.coverFontScale),
        imagePath: coverImageFile?.path || null,
      };
    }

    const jobProbe = jobs.get(jobId);
    if (jobProbe) {
      jobProbe.stage = cover
        ? `covering watermark · ${partsCount} parts`
        : `splitting into ${partsCount} parts`;
      jobProbe.progress = 5;
      jobProbe.parts = partsCount;
    }

    partPaths = await splitVideoIntoSegments(
      videoFile.path,
      partsDir,
      partsCount,
      duration,
      (p) => {
        const j = jobs.get(jobId);
        if (j && p.percent) {
          j.progress = Math.min(80, 5 + Math.round(p.percent * 0.75));
          j.stage = cover ? "covering & splitting" : "splitting";
        }
      },
      { cover }
    );

    const jobZip = jobs.get(jobId);
    if (jobZip) {
      jobZip.stage = "zipping";
      jobZip.progress = 85;
      jobZip.parts = partPaths.length;
    }

    await zipFiles(partPaths, outputPath);

    const finalJob = jobs.get(jobId);
    if (finalJob) {
      finalJob.status = "done";
      finalJob.progress = 100;
      finalJob.stage = "complete";
      finalJob.parts = partPaths.length;
    }
  } catch (err) {
    console.error(`Split job ${jobId} failed:`, err);
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = err.message || "Split failed";
    }
  } finally {
    cleanupFiles(
      [videoFile.path, coverImageFile?.path, ...partPaths].filter(Boolean)
    );
    fs.promises.rm(partsDir, { recursive: true, force: true }).catch(() => {});
    clearUploadsDir();
  }
});

/**
 * POST /api/slideshow
 *   multipart/form-data with:
 *     audio:       1–50 MP3 / audio files (merged end-to-end into one track)
 *     images:      1–100 still images (JPG, PNG, WebP…)
 *     layout:      auto | landscape | portrait | square (default auto)
 *     visualizer:  "true" | "false" (default true) — bottom audio bars
 *     flowers:     "true" | "false" (default true) — falling rose / marigold rain
 *
 *   Builds a cinematic music video: fitted slides (blur fill + sharp photo),
 *   soft crossfades, looping until the (merged) song ends, then audio mux
 *   (optional bottom visualizer + flower rain).
 *
 * Response: { jobId, statusUrl, downloadUrl }
 */
app.post(
  "/api/slideshow",
  uploadSlideshow.fields([
    { name: "audio", maxCount: 50 },
    { name: "images", maxCount: 100 },
  ]),
  async (req, res) => {
    const audioFiles = req.files?.audio || [];
    const imageFiles = req.files?.images || [];
    const uploadedPaths = [
      ...audioFiles.map((f) => f.path),
      ...imageFiles.map((f) => f.path),
    ];

    if (audioFiles.length < 1) {
      cleanupFiles(uploadedPaths);
      return res.status(400).json({ error: "Please upload an MP3 / audio file" });
    }
    if (imageFiles.length < 1) {
      cleanupFiles(uploadedPaths);
      return res
        .status(400)
        .json({ error: "Please upload at least one image" });
    }

    const layoutRaw = (req.body?.layout || "auto").toString();
    const layout = SLIDESHOW_LAYOUTS.has(layoutRaw) ? layoutRaw : "auto";
    const visualizer = String(req.body?.visualizer ?? "true") !== "false";
    const flowers = String(req.body?.flowers ?? "true") !== "false";

    const jobId = uuidv4();
    clearOutputDir();
    clearUploadsDir(uploadedPaths);
    const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAMES.music);
    const clipPaths = [];
    let concatPath = null;
    let mergedAudioPath = null;
    let generatedTilePaths = [];
    let tilesDir = null;

    jobs.set(jobId, {
      status: "processing",
      progress: 0,
      stage:
        audioFiles.length > 1
          ? `merging ${audioFiles.length} music tracks`
          : "probing audio",
      outputPath,
      downloadName: OUTPUT_NAMES.music,
    });

    res.json({
      jobId,
      statusUrl: `/api/status/${jobId}`,
      downloadUrl: `/api/download/${jobId}`,
    });

    try {
      const resolvedAudio = await resolveSlideshowAudio(
        audioFiles,
        jobId,
        (p) => {
          const j = jobs.get(jobId);
          if (j && p.percent) {
            j.progress = Math.min(6, Math.round(p.percent * 0.06));
            j.stage = `merging ${audioFiles.length} music tracks`;
          }
        }
      );
      const audioPath = resolvedAudio.path;
      mergedAudioPath = resolvedAudio.generated;

      const audioDuration = await probeDuration(audioPath);

      const jobSplit = jobs.get(jobId);
      if (jobSplit) {
        jobSplit.stage = "checking collage panels";
        jobSplit.progress = 7;
      }

      // Safety net: if a grid collage was uploaded whole, split panels here
      // so portrait cover-crop never shows two photos stacked with a line.
      const expanded = await expandSlideshowImages(imageFiles, jobId);
      const slideImages = expanded.images;
      generatedTilePaths = expanded.generatedPaths;
      tilesDir = expanded.tilesDir;
      const n = slideImages.length;

      const { width, height } = await resolveSlideshowLayout(
        layout,
        slideImages.map((f) => f.path)
      );
      // Snappy fixed hold (~2.8s) + soft blend — then LOOP the full set
      // until the song ends (not one slow pass stretched to audio length).
      const transitionSec = n < 2 ? 0 : pickSlideshowTransition();
      const clipDuration = slideshowClipDuration(transitionSec);

      const jobProbe = jobs.get(jobId);
      if (jobProbe) {
        jobProbe.stage = `filming ${n} slides (~${SLIDESHOW_HOLD_SEC}s each, looping)`;
        jobProbe.progress = 8;
      }

      // Framed slides (gutter + color-matched blur fill)
      let slidesDone = 0;
      const slideClipPaths = await mapPool(
        slideImages,
        SLIDESHOW_ENCODE_CONCURRENCY,
        async (img, i) => {
          const clipPath = path.join(UPLOAD_DIR, `slide-${jobId}-${i}.mp4`);
          await renderImageClip(
            img.path,
            clipPath,
            clipDuration,
            width,
            height,
            i,
            { animate: false, visualizer }
          );
          slidesDone += 1;
          const j = jobs.get(jobId);
          if (j) {
            j.progress = Math.round(8 + (slidesDone / n) * 62);
            j.stage =
              n === 1
                ? "preparing still image"
                : `filming slide ${slidesDone}/${n}`;
          }
          return clipPath;
        }
      );
      clipPaths.push(...slideClipPaths);

      const jobMerge = jobs.get(jobId);
      if (jobMerge) {
        jobMerge.stage = "blending slide cycle";
        jobMerge.progress = 72;
      }

      concatPath = path.join(UPLOAD_DIR, `slide-concat-${jobId}.mp4`);
      await assembleWithCrossfades(
        clipPaths,
        clipDuration,
        transitionSec,
        concatPath,
        (p) => {
          const j = jobs.get(jobId);
          if (j && p.percent) {
            j.progress = Math.min(90, 72 + Math.round(p.percent * 0.15));
          }
        }
      );

      const jobAudio = jobs.get(jobId);
      if (jobAudio) {
        jobAudio.stage = flowers
          ? visualizer
            ? "muxing slides with music & flowers"
            : "muxing slides with falling flowers"
          : visualizer
            ? "muxing slides with music"
            : audioFiles.length > 1
              ? "looping slides with merged music"
              : "looping slides with music";
        jobAudio.progress = 88;
      }

      await muxSlideshowAudio(
        concatPath,
        audioPath,
        outputPath,
        audioDuration,
        {
          loopVideo: true,
          visualizer,
          flowers,
          width,
          height,
          onProgress: (p) => {
            const j = jobs.get(jobId);
            if (!j) return;
            if (p?.stage) j.stage = p.stage;
            const pct = Number(p?.percent);
            if (Number.isFinite(pct) && pct >= 0) {
              j.progress = Math.min(99, Math.max(88, Math.round(pct)));
            }
          },
        }
      );

      const finalJob = jobs.get(jobId);
      if (finalJob) {
        finalJob.status = "done";
        finalJob.progress = 100;
        finalJob.stage = "complete";
      }
    } catch (err) {
      console.error(`Slideshow job ${jobId} failed:`, err);
      const job = jobs.get(jobId);
      if (job) {
        job.status = "error";
        job.error = err.message || "Slideshow failed";
      }
    } finally {
      const toClean = [...uploadedPaths, ...clipPaths, ...generatedTilePaths];
      if (concatPath && !clipPaths.includes(concatPath)) {
        toClean.push(concatPath);
      }
      if (mergedAudioPath) toClean.push(mergedAudioPath);
      cleanupFiles(toClean);
      if (tilesDir) {
        fs.promises.rm(tilesDir, { recursive: true, force: true }).catch(() => {});
      }
      clearUploadsDir();
    }
  }
);

const TRANSCRIBE_CHUNK_SEC = 12 * 60;
const TRANSCRIBE_PROMPT =
  "Transcribe exactly what is spoken, word for word. Do not summarize or paraphrase. Keep the original spoken language. Add punctuation and paragraph breaks only.";

function extractSpeechAudio(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("libmp3lame")
      .audioBitrate("64k");
    if (Number.isFinite(start) && start > 0) cmd = cmd.setStartTime(start);
    if (Number.isFinite(duration) && duration > 0) cmd = cmd.setDuration(duration);
    cmd
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

function probeHasAudio(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      resolve((data.streams || []).some((s) => s.codec_type === "audio"));
    });
  });
}

function parseTranscriptLanguage(raw) {
  const v = String(raw || "auto").toLowerCase();
  if (v === "hi" || v === "en") return v;
  return "auto";
}

async function transcribeWithOpenAI(audioPath, { language } = {}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Add OPENAI_API_KEY to backend/.env to transcribe videos.");
  }

  async function call(model, responseFormat) {
    const buf = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), "speech.mp3");
    form.append("model", model);
    form.append("response_format", responseFormat);
    form.append("prompt", TRANSCRIBE_PROMPT);
    if (language && language !== "auto") form.append("language", language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw;
      try {
        msg = JSON.parse(raw)?.error?.message || raw;
      } catch {
        // keep raw
      }
      const err = new Error(msg || `Transcription failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return responseFormat === "text" ? { text: raw } : JSON.parse(raw);
  }

  try {
    const data = await call("gpt-4o-transcribe", "json");
    return {
      text: String(data.text || "").trim(),
      language: data.language || language || "",
      segments: Array.isArray(data.segments) ? data.segments : [],
      model: "gpt-4o-transcribe",
    };
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    const data = await call("whisper-1", "verbose_json");
    return {
      text: String(data.text || "").trim(),
      language: data.language || language || "",
      segments: Array.isArray(data.segments) ? data.segments : [],
      model: "whisper-1",
    };
  }
}

async function transcribeVideoFile(videoPath, { language, onProgress } = {}) {
  const hasAudio = await probeHasAudio(videoPath);
  if (!hasAudio) {
    throw new Error("This video has no audio to transcribe.");
  }

  const duration = await probeDuration(videoPath).catch(() => 0);
  onProgress?.(18, "extracting audio");

  const chunks = [];
  if (duration > TRANSCRIBE_CHUNK_SEC + 20) {
    let t = 0;
    while (t < duration - 0.05) {
      const len = Math.min(TRANSCRIBE_CHUNK_SEC, duration - t);
      const chunkPath = path.join(
        UPLOAD_DIR,
        `zyvom-chunk-${String(chunks.length + 1).padStart(2, "0")}.mp3`
      );
      await extractSpeechAudio(videoPath, chunkPath, t, len);
      chunks.push({ path: chunkPath, offset: t });
      t += len;
    }
  } else {
    const audioPath = path.join(UPLOAD_DIR, "zyvom-speech-latest.mp3");
    await extractSpeechAudio(videoPath, audioPath);
    chunks.push({ path: audioPath, offset: 0 });
  }

  const parts = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(
        32 + Math.round((i / chunks.length) * 60),
        chunks.length > 1
          ? `transcribing ${i + 1}/${chunks.length}`
          : "transcribing"
      );
      const result = await transcribeWithOpenAI(chunks[i].path, { language });
      parts.push({ ...result, offset: chunks[i].offset });
    }
  } finally {
    cleanupFiles(chunks.map((c) => c.path));
  }

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!text) {
    throw new Error("No speech was detected in this video.");
  }

  const segments = parts.flatMap((p) =>
    (p.segments || [])
      .map((s) => ({
        start: Number(s.start || 0) + p.offset,
        end: Number(s.end || 0) + p.offset,
        text: String(s.text || "").trim(),
      }))
      .filter((s) => s.text)
  );

  return {
    text,
    language: parts[0]?.language || "",
    segments,
    model: parts[0]?.model || "",
    duration,
  };
}

const IMPORT_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];

function parseImportUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return null;
  }
  return parsed.toString();
}

function formatBytesLabel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function safeDownloadName(title, ext = "mp4") {
  const base =
    String(title || "video")
      .replace(/[^\w\s.-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "video";
  return `${base}.${ext}`;
}

function qualitySelector(height) {
  return [
    `bv*[height=${height}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height=${height}]+ba`,
    `b[height=${height}][ext=mp4]`,
    `b[height=${height}]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
  ].join("/");
}

function buildImportQualities(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const byHeight = new Map();

  for (const f of formats) {
    const height = Number(f.height);
    if (!Number.isFinite(height) || height < 144) continue;
    if (!f.vcodec || f.vcodec === "none") continue;
    const hasAudio = Boolean(f.acodec && f.acodec !== "none");
    const ext = String(f.ext || "").toLowerCase();
    const score =
      (hasAudio ? 80 : 0) +
      (ext === "mp4" ? 25 : ext === "webm" ? 8 : 0) +
      (Number(f.tbr) || Number(f.vbr) || 0) / 80;
    const prev = byHeight.get(height);
    if (!prev || score > prev.score) {
      byHeight.set(height, {
        height,
        filesize: f.filesize || f.filesize_approx || null,
        score,
      });
    }
  }

  const qualities = [];
  const used = new Set();
  for (const h of IMPORT_HEIGHTS) {
    if (!byHeight.has(h) || used.has(h)) continue;
    used.add(h);
    const q = byHeight.get(h);
    qualities.push({
      id: String(h),
      label: `${h}p`,
      height: h,
      ext: "mp4",
      sizeLabel: formatBytesLabel(q.filesize),
      selector: qualitySelector(h),
    });
  }

  for (const [h, q] of [...byHeight.entries()].sort((a, b) => b[0] - a[0])) {
    if (used.has(h)) continue;
    used.add(h);
    qualities.push({
      id: String(h),
      label: `${h}p`,
      height: h,
      ext: "mp4",
      sizeLabel: formatBytesLabel(q.filesize),
      selector: qualitySelector(h),
    });
  }

  qualities.sort((a, b) => b.height - a.height);

  const rec =
    qualities.find((q) => q.height === 720) ||
    qualities.find((q) => q.height <= 1080) ||
    qualities[0];

  if (rec) {
    qualities.unshift({
      ...rec,
      id: "recommended",
      label: "Recommended",
      note: `${rec.height}p MP4`,
      recommended: true,
    });
  }

  return qualities;
}

async function probeImportUrl(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
    ffmpegLocation: ffmpegPath,
  });
  const qualities = buildImportQualities(info);
  if (!qualities.length) {
    throw new Error("No downloadable MP4 qualities were found for this URL.");
  }
  return {
    title: String(info.title || "Video"),
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || "",
    duration: Number(info.duration) || 0,
    qualities,
  };
}

function pythonTarget(pathname) {
  return new URL(pathname, PYTHON_API);
}

function proxyJsonToPython(req, res, pathname) {
  const target = pythonTarget(pathname);
  const payload = JSON.stringify(req.body || {});
  const up = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (incoming) => {
      res.status(incoming.statusCode || 502);
      incoming.pipe(res);
    }
  );
  up.on("error", () => {
    res.status(503).json({
      error:
        "Python backend is not running. In backend-python run ./start.sh",
    });
  });
  up.write(payload);
  up.end();
}

function proxyRawToPython(req, res, pathname) {
  const target = pythonTarget(pathname);
  const headers = { ...req.headers, host: `${target.hostname}:${target.port}` };
  delete headers.connection;
  const up = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname,
      method: req.method,
      headers,
    },
    (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
    }
  );
  up.on("error", () => {
    if (!res.headersSent) {
      res.status(503).json({
        error:
          "Python backend is not running. In backend-python run ./start.sh",
      });
    }
  });
  req.pipe(up);
}

app.post("/api/import/info", (req, res) => {
  proxyJsonToPython(req, res, "/api/import/info");
});

app.post("/api/import/transcript", (req, res) => {
  proxyJsonToPython(req, res, "/api/import/transcript");
});

app.post("/api/import/download", (req, res) => {
  proxyJsonToPython(req, res, "/api/import/download");
});

app.post("/api/transcribe", (req, res) => {
  proxyRawToPython(req, res, "/api/transcribe");
});

const MEME_CATEGORY_HINTS = {
  comedy: "funny interactions, jokes, punchlines, roasting, awkward comedy",
  suspense: "curiosity, tension, unexpected reveals, wait-for-it moments",
  attitude: "powerful dialogue, swag, dominance, attitude lines",
  emotional: "sad, crying, heartfelt, family, breakup, relatable moments",
  twist: "plot twists, shocking statements, sudden turns",
  comment: "lines people will quote in comments, debate bait, one-liners",
  standalone: "self-contained scenes that work without movie context",
  hook: "scroll-stopping first seconds, Reels or Shorts openers",
  roast: "insults, clapbacks, savage replies, argument wins",
  motivation: "speeches, comeback, confidence, advice that hits hard",
  romance: "flirting, love confession, chemistry, couple tension",
  cringe: "awkward silence, second-hand embarrassment, uncomfortable comedy",
  song: "ONLY full sung picturized songs / gaane — verses, chorus, musical numbers. Never spoken dialogue, romance talk, or background score",
};

const CATEGORY_READ = {
  comedy: {
    words: [
      "haha", "hahaha", "lol", "joke", "funny", "comedy", "hasna", "has raha",
      "mazak", "pagal", "idiot", "stupid", "bakwas", "natak", "abe", "abey",
    ],
    re: /haha|lol|joke|mazak|has(na| raha| rahi)?|pagal|idiot|funny|comedy|bakwas|abe[y]?|arey yaar|kya bakwas/i,
  },
  suspense: {
    words: ["kya hua", "kaun", "wait", "secret", "pata", "sach", "reveal", "kyun", "khatra", "dar"],
    re: /kya hua|kaun hai|secret|pata chal|sach kya|kyun|khatra|intezaar|wait|reveal/i,
  },
  attitude: {
    words: ["main hoon", "samajh", "baap", "don", "power", "takat", "dekh lena", "meri baat"],
    re: /main hoon|samajh|baap|don|takat|dekh lena|meri baat|attitude|power/i,
  },
  emotional: {
    words: ["rona", "aansu", "maa", "papa", "sorry", "yaad", "toot", "please", "chhod"],
    re: /rona|ro raha|aansu|maa|papa|sorry|yaad|dil toot|please|chhod|dukh/i,
  },
  twist: {
    words: ["sach yeh", "dhoka", "asal", "asli", "twist", "pata tha", "nahi wo"],
    re: /sach yeh|dhoka|asal|asli|twist|pata tha|nahi wo|surprise/i,
  },
  comment: {
    words: ["yaar", "bhai", "suno", "yaad rakh", "ek baat", "yaad"],
    re: /yaad rakh|ek baat|suno|yaar|bhai|line/i,
  },
  standalone: {
    words: ["isliye", "kyunki", "matlab", "seedhi baat", "asli baat"],
    re: /isliye|kyunki|matlab|seedhi baat|asli baat|samajh lo/i,
  },
  hook: {
    words: ["dekho", "suno", "wait", "abhi", "yeh"],
    re: /dekho|suno|wait|abhi|shuru/i,
  },
  roast: {
    words: ["bewakoof", "nalayak", "idiot", "shut", "chup", "harami", "besharam", "gira"],
    re: /bewakoof|nalayak|idiot|shut up|chup|harami|besharam|gira hua/i,
  },
  motivation: {
    words: ["himmat", "sapna", "haar", "jeet", "mehnat", "dream", "himmat na"],
    re: /himmat|sapna|haar|jeet|mehnat|dream|himmat na haar|mehnat kar/i,
  },
  romance: {
    words: ["pyaar", "ishq", "dil", "jaan", "love", "kiss", "mohabbat", "sanam"],
    re: /pyaar|ishq|mohabbat|sanam|jaan|love|kiss|dil/i,
  },
  cringe: {
    words: ["awkward", "sorry", "arey", "uff", "oye", "sharminda"],
    re: /awkward|sorry|arey|uff|oye|sharminda|sharam/i,
  },
};

const SONG_MUSIC_MARK =
  /♪|♫|\[?\s*(music|song|singing|sangeet|संगीत|गाना|गायन|chorus|instrumental)\s*\]?/i;
const SONG_LYRIC_FILLER =
  /\b(la+\s*la+|na+\s*na+|ho+\s*o+|oh+\s*oh+|yeah+|o+h+|aah+|hmm+|o meri|o sajna|dilruba)\b/i;

function normalizeLyricLine(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function segmentEnd(seg) {
  const start = Number(seg?.start) || 0;
  const end = Number(seg?.end) || 0;
  return end > start ? end : start;
}

function rangesOverlap(a, b, pad = 0) {
  return a.start < b.end + pad && b.start < a.end + pad;
}

function mergeSongRegions(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item.start <= last.end + 24) {
      last.end = Math.max(last.end, item.end);
      if ((item.score || 0) > (last.score || 0)) {
        last.title = item.title || last.title;
        last.reason = item.reason || last.reason;
        last.score = item.score;
        last.source = item.source || last.source;
      }
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

function transcriptSlice(segments, start, end) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => {
      const t = Number(s.start) || 0;
      return t >= start - 2 && t <= end + 2;
    })
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

function lyricScore(text) {
  const raw = String(text || "").trim();
  if (!raw) return 0;
  const words = normalizeLyricLine(raw).split(" ").filter(Boolean);
  if (words.length < 6) return SONG_MUSIC_MARK.test(raw) ? 4 : 0;
  let score = 0;
  if (SONG_MUSIC_MARK.test(raw)) score += 5;
  if (SONG_LYRIC_FILLER.test(raw)) score += 3;
  const grams = new Map();
  for (let i = 0; i <= words.length - 4; i += 1) {
    const gram = words.slice(i, i + 4).join(" ");
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  score += Math.min(6, [...grams.values()].filter((n) => n >= 2).length);
  const lines = raw.split(/[\n.!?।]+/).map((s) => s.trim()).filter(Boolean);
  const short = lines.filter((line) => line.split(/\s+/).length <= 8).length;
  if (lines.length >= 4 && short / lines.length >= 0.6) score += 2;
  return score;
}

function dialogueScore(text) {
  const raw = String(text || "");
  const talk = raw.match(
    /\b(kya|kyun|kyon|aap|tum|hai na|theek|matlab|lekin|magar|please|sorry|suno|dekho|bata|kaun|kyunki)\b/gi
  );
  const questions = raw.match(/\?|क्या|क्यों/g);
  return (talk?.length || 0) + (questions?.length || 0);
}

function normalizeSongSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || "").trim(),
    }))
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start);
}

function lyricLineOverlap(a, b) {
  const left = new Set(
    normalizeLyricLine(a)
      .split(" ")
      .filter((w) => w.length > 2)
  );
  const right = normalizeLyricLine(b)
    .split(" ")
    .filter((w) => w.length > 2);
  if (left.size < 2 || right.length < 2) return 0;
  return right.filter((w) => left.has(w)).length;
}

function isLyricSeg(seg) {
  const text = String(seg?.text || "");
  if (SONG_MUSIC_MARK.test(text) || SONG_LYRIC_FILLER.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 8 && lyricScore(text) >= 2 && dialogueScore(text) <= 1;
}

function expandSongAroundIndexes(segs, indexes, duration) {
  if (!indexes.length) return null;
  const maxEnd = duration && duration > 1 ? duration : segmentEnd(segs[segs.length - 1]);
  let lo = Math.min(...indexes);
  let hi = Math.max(...indexes);
  while (lo > 0 && isLyricSeg(segs[lo - 1])) lo -= 1;
  while (hi < segs.length - 1 && isLyricSeg(segs[hi + 1])) hi += 1;
  const start = Math.max(0, segs[lo].start - 8);
  const end = Math.min(maxEnd, segmentEnd(segs[hi]) + 12);
  if (end - start < 40) return null;
  return {
    start,
    end,
    title: segs[indexes[0]].text.slice(0, 60),
    reason: "Lyric line found in the transcript — full sung section.",
    score: 6,
    source: "title",
  };
}

function locateSongsByTitle(rawMoments, segments, duration) {
  const segs = normalizeSongSegments(segments);
  if (!segs.length) return [];
  const found = [];
  const seen = new Set();
  for (const item of Array.isArray(rawMoments) ? rawMoments : []) {
    const title = String(item.title || "").trim();
    const needle = normalizeLyricLine(title);
    if (needle.split(" ").length < 2) continue;
    const hits = [];
    segs.forEach((seg, i) => {
      const body = normalizeLyricLine(seg.text);
      if (!body) return;
      if (
        body.includes(needle) ||
        needle.includes(body) ||
        lyricLineOverlap(title, seg.text) >= 2
      ) {
        hits.push(i);
      }
    });
    if (!hits.length) continue;
    const clusters = [];
    let bucket = [hits[0]];
    for (let i = 1; i < hits.length; i += 1) {
      if (segs[hits[i]].start - segs[hits[i - 1]].start <= 200) {
        bucket.push(hits[i]);
      } else {
        clusters.push(bucket);
        bucket = [hits[i]];
      }
    }
    clusters.push(bucket);
    for (const group of clusters) {
      const region = expandSongAroundIndexes(segs, group, duration);
      if (!region) continue;
      const key = `${Math.round(region.start / 15)}:${Math.round(region.end / 15)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      region.title = title.slice(0, 80) || region.title;
      found.push(region);
    }
  }
  return mergeSongRegions(found);
}

function detectSongRegions(segments, duration) {
  const segs = normalizeSongSegments(segments);
  if (!segs.length) return [];

  const regions = [];
  const maxEnd = duration && duration > 1 ? duration : segmentEnd(segs[segs.length - 1]);

  for (let i = 0; i < segs.length - 1; i += 1) {
    const gapStart = segmentEnd(segs[i]);
    const gapEnd = segs[i + 1].start;
    const gap = gapEnd - gapStart;
    if (gapStart < 40) continue;
    if (gap >= 70 && gap <= 480) {
      regions.push({
        start: gapStart,
        end: gapEnd,
        title: "Song",
        reason: "Captions stop mid-film — picturized songs are often missing from dialogue captions.",
        score: Math.min(6, gap / 50),
        source: "gap",
      });
    }
  }

  const phraseTimes = new Map();
  for (const seg of segs) {
    const key = normalizeLyricLine(seg.text);
    if (key.split(" ").length < 3) continue;
    if (!phraseTimes.has(key)) phraseTimes.set(key, []);
    phraseTimes.get(key).push(seg.start);
  }
  for (const [phrase, times] of phraseTimes) {
    for (let i = 1; i < times.length; i += 1) {
      const span = times[i] - times[i - 1];
      if (span < 10 || span > 240) continue;
      regions.push({
        start: Math.max(0, times[i - 1] - 20),
        end: Math.min(maxEnd, times[i] + 50),
        title: phrase.slice(0, 60),
        reason: "Same lyric line repeats — chorus of a sung song.",
        score: 5,
        source: "chorus",
      });
    }
  }

  let cluster = [];
  const flushCluster = () => {
    if (cluster.length < 4) {
      cluster = [];
      return;
    }
    const start = cluster[0].start;
    const end = segmentEnd(cluster[cluster.length - 1]);
    if (end - start >= 50) {
      regions.push({
        start,
        end,
        title: cluster[0].text.slice(0, 60),
        reason: "Lyric-like sung lines in a row.",
        score: Math.min(5, cluster.length / 4),
        source: "lyrics",
      });
    }
    cluster = [];
  };
  for (const seg of segs) {
    if (isLyricSeg(seg)) cluster.push(seg);
    else flushCluster();
  }
  flushCluster();

  return mergeSongRegions(regions).filter((r) => r.end - r.start >= 40);
}

function scoreSegmentForCategory(seg, category) {
  const text = String(seg?.text || "");
  if (!text.trim()) return 0;
  if (category === "song") return lyricScore(text);
  const cues = CATEGORY_READ[category] || CATEGORY_READ.standalone;
  const body = text.toLowerCase();
  let score = 0;
  for (const word of cues.words) {
    if (body.includes(word)) score += 1;
  }
  if (cues.re && cues.re.test(text)) score += 2;
  return score;
}

function skipBounds(duration, category) {
  const total = Number(duration) || 0;
  if (category === "hook") return { skipStart: 0, skipEnd: total || 24 * 60 * 60 };
  const skipStart =
    category === "song"
      ? total > 8 * 60
        ? 40
        : 10
      : total > 20 * 60
        ? 120
        : total > 8 * 60
          ? 75
          : 20;
  const skipEnd = total > 20 * 60 ? Math.max(skipStart + 60, total - 80) : total || 24 * 60 * 60;
  return { skipStart, skipEnd };
}

function dropIntroMoments(moments, duration, category) {
  const { skipStart, skipEnd } = skipBounds(duration, category);
  return (Array.isArray(moments) ? moments : []).filter((item) => {
    const start = Number(item.start) || 0;
    const end = Number(item.end) || 0;
    if (end <= start) return false;
    if (end > skipEnd + 20 && end - skipEnd > (end - start) * 0.5) return false;
    if (category === "song" && end - start >= 50 && start >= 25) return true;
    return start >= skipStart && end <= skipEnd + 1;
  });
}

function clusterCategoryHits(hits, duration, { gap, pad, minLen, maxLen, limit }) {
  if (!hits.length) return [];
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const groups = [];
  let bucket = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = segmentEnd(bucket[bucket.length - 1]);
    if (sorted[i].start - prevEnd <= gap) bucket.push(sorted[i]);
    else {
      groups.push(bucket);
      bucket = [sorted[i]];
    }
  }
  groups.push(bucket);
  const maxEnd = duration && duration > 1 ? duration : 24 * 60 * 60;
  return groups
    .map((group) => {
      const score = group.reduce((n, item) => n + (item.score || 1), 0);
      const start = Math.max(0, group[0].start - pad);
      let end = Math.min(maxEnd, segmentEnd(group[group.length - 1]) + pad);
      if (end - start < minLen) end = Math.min(maxEnd, start + minLen);
      if (end - start > maxLen) end = start + maxLen;
      return {
        start,
        end,
        title: String(group[0].text || "Moment").trim().slice(0, 60),
        reason: "Category match in the transcript.",
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start);
}

function readTranscriptByCategory(segments, category, duration) {
  const { skipStart, skipEnd } = skipBounds(duration, category);
  if (category === "song") {
    return detectSongRegions(segments, duration).filter(
      (r) => r.start >= skipStart && r.end <= skipEnd + 1
    );
  }
  const segs = normalizeSongSegments(segments).filter(
    (seg) => seg.start >= skipStart && seg.start <= skipEnd
  );
  if (!segs.length) return [];
  const hits = segs
    .map((seg) => ({ ...seg, score: scoreSegmentForCategory(seg, category) }))
    .filter((seg) => seg.score >= 1);
  const windows = clusterCategoryHits(hits, duration, {
    gap: 40,
    pad: 22,
    minLen: 25,
    maxLen: 180,
    limit: category === "hook" ? 8 : 12,
  });
  if (category === "hook") {
    const opening = {
      start: 0,
      end: Math.min(duration && duration > 1 ? duration : 90, 90),
      title: segs[0].text.slice(0, 60),
      reason: "Opening seconds — hook category reads the start first.",
      score: 5,
    };
    return mergeSongRegions([opening, ...windows]).slice(0, 8);
  }
  return dropIntroMoments(windows, duration, category);
}

function formatCategoryWindows(windows, segments) {
  const segs = normalizeSongSegments(segments);
  return windows
    .map((window, i) => {
      const lines = segs
        .filter((seg) => seg.start >= window.start - 1 && seg.start <= window.end + 1)
        .map((seg) => `[${seg.start.toFixed(1)}] ${seg.text}`)
        .join("\n");
      return `### WINDOW ${i + 1} ${window.start.toFixed(1)}-${window.end.toFixed(1)}\n${
        lines || window.title
      }`;
    })
    .join("\n\n");
}

function formatMemeClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function compactTimedTranscript(segments, maxChars = 48000, duration = 0, category = "") {
  const { skipStart, skipEnd } = skipBounds(duration, category);
  const segs = normalizeSongSegments(segments).filter(
    (seg) => seg.start >= skipStart && seg.start <= skipEnd
  );
  if (!segs.length) return "";
  const span = Math.max(1, segs[segs.length - 1].start - segs[0].start);
  const bucketSec = span > 90 * 60 ? 15 * 60 : 10 * 60;
  const buckets = new Map();
  for (const seg of segs) {
    const key = Math.floor((seg.start - segs[0].start) / bucketSec);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(seg);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const perBucket = Math.max(30, Math.floor(maxChars / 90 / Math.max(keys.length, 1)));
  const parts = [];
  for (const key of keys) {
    const list = buckets.get(key);
    const step = Math.max(1, Math.ceil(list.length / perBucket));
    const lines = [];
    for (let i = 0; i < list.length; i += step) {
      lines.push(`[${list[i].start.toFixed(1)}] ${list[i].text}`);
    }
    parts.push(
      `## PART ${key + 1} ${formatMemeClock(list[0].start)}-${formatMemeClock(list[list.length - 1].start)}\n${lines.join("\n")}`
    );
  }
  return parts.join("\n\n").slice(0, maxChars);
}

function snapMomentsToWindows(rawMoments, windows, duration, song) {
  const clipped = clipMemeMoments(rawMoments, duration, { song });
  if (!windows.length) return clipped;
  const snapped = [];
  for (const moment of clipped) {
    const window = windows.find((item) => rangesOverlap(moment, item, 15));
    if (!window) continue;
    snapped.push({
      start: Math.max(window.start, moment.start),
      end: Math.min(window.end, moment.end > moment.start ? moment.end : window.end),
      title: moment.title || window.title,
      reason: moment.reason || window.reason,
    });
  }
  if (snapped.length) return clipMemeMoments(snapped, duration, { song });
  return clipMemeMoments(windows, duration, { song });
}

function isHallucinatedSongTime(start, end) {
  const s = Number(start) || 0;
  const e = Number(end) || 0;
  if (Math.abs(s - 12.4) < 0.2 && Math.abs(e - 148) < 1.5) return true;
  if (Math.abs(s - 148) < 1.5 && Math.abs(e - 360) < 1.5) return true;
  if (Math.abs(s - 12.4) < 0.2 && Math.abs(e - 360) < 1.5) return true;
  return false;
}

function refineSongMoments(rawMoments, segments, duration) {
  const located = locateSongsByTitle(rawMoments, segments, duration);
  const regions = detectSongRegions(segments, duration);
  const fromGpt = clipMemeMoments(
    (Array.isArray(rawMoments) ? rawMoments : []).filter(
      (item) => !isHallucinatedSongTime(item.start, item.end)
    ),
    duration,
    { song: true }
  );
  const kept = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || isHallucinatedSongTime(item.start, item.end)) return;
    const key = `${Math.round(item.start / 20)}:${Math.round(item.end / 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(item);
  };
  for (const item of located) add(item);
  for (const moment of fromGpt) {
    const len = moment.end - moment.start;
    if (len < 40 || len > 480) continue;
    const slice = transcriptSlice(segments, moment.start, moment.end);
    const lyrics = lyricScore(slice);
    const talk = dialogueScore(slice);
    const region = regions.find((r) => rangesOverlap(moment, r, 25));
    if (region) {
      add({
        start: region.start,
        end: region.end,
        title: moment.title || region.title,
        reason: moment.reason || region.reason,
      });
      continue;
    }
    if (lyrics >= 2 && lyrics >= talk - 1) add(moment);
    else if (len >= 70 && talk <= 5 && moment.start >= 30) add(moment);
  }
  for (const region of regions) add(region);
  return clipMemeMoments(kept, duration, { song: true });
}

function clipMemeMoments(rawMoments, duration, { song = false } = {}) {
  const maxEnd = duration && duration > 1 ? duration : 24 * 60 * 60;
  const minLen = song ? 40 : 25;
  const pad = song ? 90 : 75;
  const maxLen = song ? 480 : 360;
  const limit = song ? 25 : 24;
  const moments = [];
  for (const item of Array.isArray(rawMoments) ? rawMoments : []) {
    const start = Math.max(0, Number(item.start) || 0);
    let end = Math.min(maxEnd, Number(item.end) || 0);
    if (end - start < minLen) {
      if (song && start > 0) end = Math.min(maxEnd, start + pad);
      else if (song) continue;
      else end = Math.min(maxEnd, start + pad);
    }
    if (end - start > maxLen) end = start + maxLen;
    if (end <= start) continue;
    moments.push({
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      title: String(item.title || (song ? "Song" : "Moment")).trim().slice(0, 80),
      reason: String(item.reason || "").trim().slice(0, 180),
    });
  }
  moments.sort((a, b) => a.start - b.start);
  return moments.slice(0, limit);
}

function fallbackMemeMoments(transcript, category, duration, segments) {
  if (category === "song") {
    const moments = refineSongMoments([], segments, duration);
    if (!moments.length) {
      throw new Error(
        "Is video mein sung gaana clearly nahi mila. Dialogue / romance scenes song nahi maane jaate."
      );
    }
    return moments;
  }
  const timed = Array.isArray(segments) && segments.length
    ? segments
    : String(transcript || "")
        .split(/(?<=[.!?।])\s+/)
        .map((text, i) => ({ start: i * 12, end: i * 12 + 10, text }));
  const moments = clipMemeMoments(
    readTranscriptByCategory(timed, category, duration),
    duration,
    { song: false }
  );
  if (!moments.length) {
    throw new Error("No matching moments found. Try another category.");
  }
  return moments;
}

const memeAnalyzeCache = new Map();
const memeAnalyzeInflight = new Map();
const MEME_ANALYZE_CACHE_MS = 30 * 60 * 1000;

function memeAnalyzeCacheKey(transcript, category) {
  return crypto
    .createHash("sha1")
    .update(`cat-read-v4\n${category}\n${transcript}`)
    .digest("hex");
}

async function analyzeMemeMomentsWithOpenAI({
  transcript,
  category,
  duration,
  segments,
  force = false,
}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const cat = MEME_CATEGORY_HINTS[category] ? category : "standalone";
  const hint = MEME_CATEGORY_HINTS[cat];
  const isSong = cat === "song";
  const windows = readTranscriptByCategory(segments, cat, duration);
  const categoryText = formatCategoryWindows(windows, segments);
  const localMoments = dropIntroMoments(
    clipMemeMoments(windows, duration, { song: isSong }),
    duration,
    cat
  );
  const cacheKey = memeAnalyzeCacheKey(
    `${String(transcript || "").slice(0, 8000)}\n${windows.length}`,
    cat
  );
  const cached = memeAnalyzeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MEME_ANALYZE_CACHE_MS) {
    return { moments: cached.moments, source: "cache" };
  }
  const pending = memeAnalyzeInflight.get(cacheKey);
  if (pending) return pending;

  const bodyText = compactTimedTranscript(segments, 48000, duration, cat);
  const source =
    (isSong ? categoryText || bodyText : bodyText || categoryText) ||
    String(transcript || "").trim().slice(0, 12000);
  if (!source) {
    if (localMoments.length) {
      memeAnalyzeCache.set(cacheKey, { moments: localMoments, at: Date.now() });
      return { moments: localMoments, source: "local" };
    }
    throw new Error(
      isSong
        ? "Is video mein sung gaana clearly nahi mila. Dialogue / romance scenes song nahi maane jaate."
        : "No matching moments found. Try another category."
    );
  }
  if (source.length < 20) {
    throw new Error("Transcript is too short to find moments.");
  }

  if (!apiKey) {
    return {
      moments: fallbackMemeMoments(source, cat, duration, segments),
      source: "local",
    };
  }

  const work = (async () => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: isSong ? 0.1 : 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: isSong
              ? "You extract only full SUNG songs from a movie transcript. Spoken dialogue is never a song. Reply with JSON only."
              : `You extract only '${cat}' scenes from a movie transcript. Skip introduction, logos, and credits. Reply with JSON only.`,
          },
          {
            role: "user",
            content: [
              isSong
                ? `Extract every full sung song / picturized gaana. ${hint}.`
                : `Category '${cat}': ${hint}.`,
              "Skip movie introduction, studio logos, title cards, and end credits.",
              "The transcript covers the FULL movie in labeled PARTS. Find matching scenes in EVERY part — beginning, middle, and end. Do not only pick from the first 20-30 minutes.",
              "List every qualifying scene across the whole film, not just 2 or 3.",
              isSong
                ? 'Return ONLY valid JSON: {"moments":[{"start":0,"end":0,"title":"<lyric line from transcript>","reason":"sung verse or chorus"}]}'
                : 'Return ONLY valid JSON: {"moments":[{"start":0,"end":0,"title":"...","reason":"..."}]}',
              "Rules:",
              isSong
                ? "- a song is SUNG lyrics: verses, chorus, rhyme, repetition, ♪, [Music], musical number"
                : "- list every full scene that truly matches this category, in time order",
              isSong
                ? "- NEVER return spoken dialogue, romance talk, comedy, emotional speeches, or background score without singing"
                : "- each clip is the FULL scene: usually 60 to 180 seconds, can be up to 360 seconds. NEVER make every clip 15 seconds",
              isSong
                ? "- title MUST be an exact lyric line copied from the transcript, not a guessed song name"
                : "- start/end must be seconds from the transcript timestamps, never invented examples",
              isSong
                ? "- start/end must be the real song times from the transcript PARTS, usually 70 to 360 seconds each"
                : "- ignore introduction and any scene that does not match this category",
              isSong
                ? "- if you are not sure it is sung, omit it"
                : "- stay inside the video duration if given",
              "- stay inside the video duration if given",
              "- use the timestamps in the transcript; do not invent far-off times",
              "- title is short; reason is one line",
              isSong && windows.length
                ? `LIKELY SONG WINDOWS (repeated lyrics / mid-film caption gaps). Use lyric text from these windows:\n${windows
                    .map(
                      (r) =>
                        `- ${r.start.toFixed(1)}-${r.end.toFixed(1)}: ${r.title || r.reason}`
                    )
                    .join("\n")}`
                : "",
              `Video duration seconds: ${duration || "unknown"}`,
              `Skip anything before ${skipBounds(duration, cat).skipStart} seconds (introduction).`,
              "",
              "TRANSCRIPT:",
              source.slice(0, 48000),
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw;
      try {
        msg = JSON.parse(raw)?.error?.message || raw;
      } catch {
        // keep raw
      }
      throw new Error(msg || `OpenAI analyze failed (${res.status})`);
    }
    let data;
    try {
      data = JSON.parse(raw);
      data = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch {
      throw new Error("Could not parse meme moments.");
    }
    const moments = dropIntroMoments(
      isSong
        ? refineSongMoments(data.moments, segments, duration)
        : clipMemeMoments(data.moments, duration, { song: false }),
      duration,
      cat
    );
    if (!moments.length) {
      throw new Error(
        isSong
          ? "Is video mein sung gaana clearly nahi mila. Dialogue / romance scenes song nahi maane jaate."
          : "No matching moments found. Try another category."
      );
    }
    memeAnalyzeCache.set(cacheKey, { moments, at: Date.now() });
    return { moments, source: "openai" };
  })();

  memeAnalyzeInflight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    memeAnalyzeInflight.delete(cacheKey);
  }
}

app.post("/api/meme/analyze", async (req, res) => {
  try {
    const category = String(req.body?.category || "comedy");
    const result = await analyzeMemeMomentsWithOpenAI({
      transcript: String(req.body?.transcript || ""),
      category,
      duration: Number(req.body?.duration) || 0,
      segments: Array.isArray(req.body?.segments) ? req.body.segments : [],
      force: Boolean(req.body?.force),
    });
    res.json({
      moments: result.moments,
      category,
      source: result.source,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not find moments." });
  }
});

function cutClipRange(inputPath, outputPath, start, end) {
  const dur = Math.max(0.4, Number(end) - Number(start));
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(Math.max(0, Number(start) || 0))
      .setDuration(dur)
      .outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
      ])
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

app.post("/api/meme/split", uploadMeme.single("video"), async (req, res) => {
  const videoFile = req.file;
  if (!videoFile) {
    return res.status(400).json({ error: "Upload the source video to split." });
  }
  let moments = [];
  try {
    moments = JSON.parse(String(req.body?.moments || "[]"));
  } catch {
    moments = [];
  }
  moments = (Array.isArray(moments) ? moments : [])
    .map((m) => ({
      start: Number(m.start),
      end: Number(m.end),
      title: String(m.title || "clip"),
    }))
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start)
    .slice(0, 20);
  if (!moments.length) {
    cleanupFiles([videoFile.path]);
    return res.status(400).json({ error: "No clip durations to split." });
  }

  const jobId = uuidv4();
  clearOutputDir();
  clearUploadsDir([videoFile.path]);
  const outputPath = path.join(OUTPUT_DIR, OUTPUT_NAMES.meme);
  jobs.set(jobId, {
    status: "processing",
    progress: 8,
    stage: "splitting",
    outputPath,
    downloadName: OUTPUT_NAMES.meme,
    clips: [],
  });
  res.json({
    jobId,
    statusUrl: `/api/status/${jobId}`,
    downloadUrl: `/api/download/${jobId}`,
  });

  try {
    const clipPaths = [];
    const clips = [];
    for (let i = 0; i < moments.length; i++) {
      const m = moments[i];
      const name = `zyvom-meme-${String(i + 1).padStart(2, "0")}.mp4`;
      const out = path.join(OUTPUT_DIR, name);
      const job = jobs.get(jobId);
      if (job) {
        job.progress = 10 + Math.round((i / moments.length) * 70);
        job.stage = `cutting ${i + 1}/${moments.length}`;
      }
      await cutClipRange(videoFile.path, out, m.start, m.end);
      clipPaths.push(out);
      const safeTitle = String(m.title || `clip-${i + 1}`)
        .replace(/[^\w\s.-]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 40) || `clip-${i + 1}`;
      clips.push({
        index: i + 1,
        title: m.title,
        start: m.start,
        end: m.end,
        file: name,
        downloadUrl: `/api/download/${jobId}/${i + 1}`,
        downloadName: `${safeTitle}.mp4`,
      });
    }
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver("zip", { zlib: { level: 1 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      clipPaths.forEach((p) => archive.file(p, { name: path.basename(p) }));
      archive.finalize();
    });
    const job = jobs.get(jobId);
    if (job) {
      job.status = "done";
      job.progress = 100;
      job.stage = "complete";
      job.parts = moments.length;
      job.clips = clips;
    }
  } catch (err) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = err.message || "Split failed";
    }
  } finally {
    cleanupFiles([videoFile.path]);
    clearUploadsDir();
  }
});

app.get("/api/status/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) {
    return res.json({
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      error: job.error,
      parts: job.parts,
      transcript: job.transcript || null,
      segments: job.segments || null,
      language: job.language || null,
      downloadUrl:
        job.status === "done" && job.outputPath
          ? `/api/download/${req.params.jobId}`
          : null,
      downloadName: job.downloadName || null,
      clips: job.status === "done" ? job.clips || [] : [],
    });
  }
  try {
    const up = await fetch(`${PYTHON_API}/api/status/${req.params.jobId}`);
    const data = await up.json().catch(() => ({}));
    return res.status(up.status).json(data);
  } catch {
    return res.status(404).json({ error: "Job not found" });
  }
});

function sendDownload(res, filePath, name) {
  return res.download(filePath, name, (err) => {
    if (!err) return;
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    console.error("Download error:", err);
  });
}

app.get("/api/download/:jobId/:clipIndex", (req, res) => {
  const job = jobs.get(req.params.jobId);
  const idx = Number(req.params.clipIndex);
  const clip = (job?.clips || []).find((c) => c.index === idx);
  if (!job || !clip) {
    return res.status(404).json({ error: "Clip not found" });
  }
  if (job.status !== "done") {
    return res.status(409).json({ error: "Job not finished yet" });
  }
  const filePath = path.join(OUTPUT_DIR, clip.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Clip file missing" });
  }
  return sendDownload(res, filePath, clip.downloadName || clip.file);
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) {
    if (job.status !== "done") {
      return res.status(409).json({ error: "Job not finished yet" });
    }
    if (!fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: "Output file missing" });
    }
    const downloadName =
      job.downloadName ||
      `video-${req.params.jobId}${path.extname(job.outputPath) || ".mp4"}`;
    return sendDownload(res, job.outputPath, downloadName);
  }
  proxyRawToPython(req, res, `/api/download/${req.params.jobId}`);
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "Transcript is too long to send. Try a shorter clip.",
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Video merger backend running on http://localhost:${PORT}`);
  console.log(`Python import/transcribe proxy: ${PYTHON_API}`);
  console.log(
    process.env.OPENAI_API_KEY
      ? "OpenAI key loaded from backend/.env — used only for Find moments (gpt-4o-mini) after a transcript exists, or Transcribe if no YouTube captions"
      : "OPENAI_API_KEY missing in backend/.env — Meme Finder will use local keyword fallback"
  );
  console.log(
    `Slideshow encoder: ${
      USE_H264_VIDEOTOOLBOX ? "h264_videotoolbox (GPU)" : "libx264 ultrafast"
    }, slide concurrency=${SLIDESHOW_ENCODE_CONCURRENCY}`
  );
});
