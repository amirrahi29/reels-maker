import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const STATUS_POLL_MS = 1000;
const COVER_FONT_SCALES = [
  { id: 0.22, label: "S" },
  { id: 0.34, label: "M" },
  { id: 0.48, label: "L" },
];

function hexToRgba(hex, alpha = 0.88) {
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(17, 17, 17, ${alpha})`;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function CoverTextStyleFields({
  idPrefix,
  text,
  setText,
  textColor,
  setTextColor,
  bgColor,
  setBgColor,
  bgTransparent,
  setBgTransparent,
  fontScale,
  setFontScale,
  disabled,
}) {
  return (
    <div className="cover-text-tools">
      <div className="brand-field">
        <label className="field-label" htmlFor={`${idPrefix}CoverText`}>
          Cover text
        </label>
        <input
          id={`${idPrefix}CoverText`}
          className="brand-input"
          type="text"
          maxLength={80}
          placeholder="Your channel name"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="cover-style-row">
        <label className="cover-color-field">
          <span className="field-label">Font color</span>
          <span className="cover-color-picker">
            <input
              type="color"
              value={textColor}
              onChange={(e) => setTextColor(e.target.value)}
              disabled={disabled}
              aria-label="Font color"
            />
            <span className="cover-color-hex">{textColor}</span>
          </span>
        </label>
        <div className="cover-color-field">
          <span className="field-label">Background</span>
          <div className="cover-bg-tools">
            <span className={`cover-color-picker${bgTransparent ? " is-disabled" : ""}`}>
              <input
                type="color"
                value={bgColor}
                onChange={(e) => {
                  setBgColor(e.target.value);
                  setBgTransparent(false);
                }}
                disabled={disabled || bgTransparent}
                aria-label="Background color"
              />
              <span className="cover-color-hex">
                {bgTransparent ? "None" : bgColor}
              </span>
            </span>
            <button
              type="button"
              className={`speed-btn ${bgTransparent ? "speed-btn--active" : ""}`}
              onClick={() => setBgTransparent(!bgTransparent)}
              disabled={disabled}
            >
              Transparent
            </button>
          </div>
        </div>
        <div className="cover-color-field">
          <span className="field-label">Size</span>
          <div className="cover-modes" role="radiogroup" aria-label="Font size">
            {COVER_FONT_SCALES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`speed-btn ${fontScale === opt.id ? "speed-btn--active" : ""}`}
                onClick={() => setFontScale(opt.id)}
                disabled={disabled}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const CATEGORY_KEEP_RE = {
  comedy: /haha|lol|joke|mazak|has|pagal|idiot|funny|comedy|bakwas|abe/i,
  suspense: /kya hua|kaun|secret|pata|sach|kyun|wait|khatra/i,
  attitude: /main hoon|samajh|baap|don|takat|dekh lena|attitude|power/i,
  emotional: /rona|aansu|maa|papa|sorry|yaad|toot|please|chhod/i,
  twist: /sach yeh|dhoka|asal|asli|twist|pata tha/i,
  comment: /yaad rakh|ek baat|suno|yaar|bhai/i,
  standalone: /isliye|kyunki|matlab|seedhi baat|asli baat/i,
  hook: /dekho|suno|wait|abhi|shuru/i,
  roast: /bewakoof|nalayak|idiot|chup|harami|besharam/i,
  motivation: /himmat|sapna|haar|jeet|mehnat|dream/i,
  romance: /pyaar|ishq|mohabbat|sanam|jaan|love|kiss|dil/i,
  cringe: /awkward|sorry|arey|uff|oye|sharminda/i,
  song: /♪|♫|\[?\s*(music|song|singing|sangeet|संगीत|गाना|गायन|chorus)\s*\]?|\b(la+\s*la+|na+\s*na+|ho+\s*o+|oh+\s*oh+)\b/i,
};

function pickEvenIndexes(indexes, limit) {
  if (indexes.length <= limit) return indexes;
  if (limit <= 1) return [indexes[0]];
  return Array.from({ length: limit }, (_, i) =>
    indexes[Math.round((i / (limit - 1)) * (indexes.length - 1))]
  );
}

function sampleMemeSegments(segs, category) {
  const compact = (Array.isArray(segs) ? segs : [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || "").trim(),
    }))
    .filter((s) => s.text);
  const maxSegs = 2500;
  if (compact.length <= maxSegs) return compact;
  const keepRe = CATEGORY_KEEP_RE[category] || CATEGORY_KEEP_RE.standalone;
  const hits = [];
  compact.forEach((s, i) => {
    if (keepRe.test(s.text)) hits.push(i);
    if (category === "song" && s.text.split(/\s+/).length <= 6) hits.push(i);
  });
  const even = pickEvenIndexes(
    compact.map((_, i) => i),
    maxSegs
  );
  const hitBudget = Math.min(900, Math.floor(maxSegs * 0.35));
  const picked = new Set([...even, ...pickEvenIndexes(hits, hitBudget)]);
  return [...picked].sort((a, b) => a - b).map((i) => compact[i]);
}

const MEME_CATEGORIES = [
  { id: "comedy", label: "😂 Comedy / funny" },
  { id: "suspense", label: "😱 Curiosity / suspense" },
  { id: "attitude", label: "🔥 Powerful dialogue" },
  { id: "emotional", label: "❤️ Emotional / relatable" },
  { id: "twist", label: "🤯 Twist / shock" },
  { id: "comment", label: "💬 Comment-bait line" },
  { id: "standalone", label: "🎯 Standalone scene" },
  { id: "hook", label: "🪝 Viral hook" },
  { id: "roast", label: "👏 Roast / clapback" },
  { id: "motivation", label: "💪 Motivation" },
  { id: "romance", label: "💕 Romance" },
  { id: "cringe", label: "👀 Awkward / cringe" },
  { id: "song", label: "🎵 Song / gaane" },
];

const TABS = [
  {
    id: "merge",
    label: "Merge Multiple Videos",
    hint: "Join clips into one export",
    kicker: "Pipeline",
    title: "Merge Multiple Videos",
    desc: "Join clips into one master export with watermark and brand controls.",
  },
  {
    id: "duet",
    label: "Duet Videos",
    hint: "Stack two clips, portrait",
    kicker: "Create",
    title: "Duet Videos",
    desc: "Upload two clips — one on top, one below — then export a portrait duet. Mute either track or drop in your own sound.",
  },
  {
    id: "split",
    label: "Split Video",
    hint: "Cut into the parts you choose",
    kicker: "Pipeline",
    title: "Split Video",
    desc: "Upload a long video, enter how many parts you want, and download a ZIP.",
  },
  {
    id: "music",
    label: "Make Video with Music",
    hint: "Slideshows with audio",
    kicker: "Create",
    title: "Make Video with Music",
    desc: "Build framed slideshows with tracks, visualizer, and flower rain.",
  },
  {
    id: "meme",
    label: "Meme Finder",
    hint: "Find viral scenes by category",
    kicker: "Create",
    title: "Meme Finder",
    desc: "Upload a video, pick comedy, emotion, or another vibe, and get the exact durations that can go viral.",
  },
  {
    id: "downloader",
    label: "Video Downloader",
    hint: "YouTube, Instagram, and more",
    kicker: "Import",
    title: "Video Downloader",
    desc: "Paste a YouTube, Instagram, Facebook, or LinkedIn link, pick a quality, preview it, then save the MP4.",
  },
];

function NavIcon({ id }) {
  const common = {
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    "aria-hidden": true,
  };
  if (id === "merge") {
    return (
      <svg {...common}>
        <path
          d="M7 7h6v6H7V7Zm4 4h6v6h-6v-6Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === "split") {
    return (
      <svg {...common}>
        <path
          d="M4 7h7M13 7h7M4 17h7M13 17h7M12 4v16"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "downloader") {
    return (
      <svg {...common}>
        <path
          d="M12 4v10m0 0-3.5-3.5M12 14l3.5-3.5M5 18h14"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === "duet") {
    return (
      <svg {...common}>
        <rect
          x="6"
          y="3.5"
          width="12"
          height="7.5"
          rx="1.4"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect
          x="6"
          y="13"
          width="12"
          height="7.5"
          rx="1.4"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    );
  }
  if (id === "meme") {
    return (
      <svg {...common}>
        <path
          d="M5 6.5h14v8.5H9.2L5 18.5V6.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M8.5 10h7M8.5 13h4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M8 16V8l10 4-10 4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M5 6v12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const LAYOUTS = [
  {
    id: "auto",
    title: "Auto",
    hint: "First clip",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "landscape",
    title: "Landscape",
    hint: "1280×720",
    icon: <span className="layout-shape layout-shape--landscape" />,
  },
  {
    id: "portrait",
    title: "Portrait",
    hint: "720×1280",
    icon: <span className="layout-shape layout-shape--portrait" />,
  },
  {
    id: "square",
    title: "Square",
    hint: "1080×1080",
    icon: <span className="layout-shape layout-shape--square" />,
  },
];

const MUSIC_LAYOUTS = LAYOUTS.map((l) => {
  if (l.id === "auto") return { ...l, hint: "Photo ratio · 1080p" };
  if (l.id === "landscape") return { ...l, hint: "1920×1080" };
  if (l.id === "portrait") return { ...l, hint: "1080×1920" };
  if (l.id === "square") return { ...l, hint: "1080×1080" };
  return l;
});

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function pollStatus(id, { setProgress, setStage, setParts }) {
  while (true) {
    const res = await fetch(`/api/status/${id}`);
    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();
    if (typeof data.progress === "number") setProgress(data.progress);
    if (data.stage) setStage(data.stage);
    if (typeof data.parts === "number" && setParts) setParts(data.parts);
    if (data.status === "done") return data;
    if (data.status === "error") {
      throw new Error(data.error || "Processing failed");
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
  }
}

const COLLAGE_GRID_PRESETS = [
  { id: "auto", label: "Auto detect" },
  { id: "off", label: "Off (keep as-is)" },
  { id: "2x2", label: "2 × 2" },
  { id: "2x3", label: "2 × 3" },
  { id: "2x4", label: "2 × 4" },
  { id: "2x5", label: "2 × 5" },
  { id: "3x2", label: "3 × 2" },
  { id: "3x3", label: "3 × 3" },
  { id: "3x4", label: "3 × 4" },
  { id: "3x5", label: "3 × 5" },
  { id: "4x2", label: "4 × 2" },
  { id: "4x3", label: "4 × 3" },
  { id: "4x4", label: "4 × 4" },
  { id: "4x5", label: "4 × 5" },
  { id: "5x2", label: "5 × 2" },
  { id: "5x3", label: "5 × 3" },
  { id: "5x4", label: "5 × 4" },
  { id: "1x2", label: "1 × 2" },
  { id: "1x3", label: "1 × 3" },
  { id: "1x4", label: "1 × 4" },
  { id: "1x5", label: "1 × 5" },
  { id: "2x1", label: "2 × 1" },
  { id: "3x1", label: "3 × 1" },
  { id: "4x1", label: "4 × 1" },
  { id: "5x1", label: "5 × 1" },
];

function parseGridId(id) {
  if (!id || id === "auto" || id === "off") return null;
  const m = /^(\d+)x(\d+)$/.exec(id);
  if (!m) return null;
  return { rows: Number(m[1]), cols: Number(m[2]) };
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Detect a regular collage grid via seam edge-energy (works for black or
 * white gutters), then crop each cell into its own JPEG File.
 * Returns null when the image does not look like a multi-panel collage.
 */
async function splitCollageFile(file, forcedGrid = null) {
  const bitmap = await createImageBitmap(file);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // Downscale for fast detection, then map seams back to full res.
  const maxDetect = 900;
  const scale = Math.min(1, maxDetect / Math.max(srcW, srcH));
  const dw = Math.max(2, Math.round(srcW * scale));
  const dh = Math.max(2, Math.round(srcH * scale));

  const detectCanvas = document.createElement("canvas");
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  const dctx = detectCanvas.getContext("2d", { willReadFrequently: true });
  dctx.drawImage(bitmap, 0, 0, dw, dh);
  const { data } = dctx.getImageData(0, 0, dw, dh);

  const lum = new Float32Array(dw * dh);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = luminance(data[p], data[p + 1], data[p + 2]);
  }

  const ve = new Float32Array(dw);
  for (let x = 1; x < dw - 1; x++) {
    let s = 0;
    for (let y = 0; y < dh; y++) {
      const i = y * dw + x;
      s += Math.abs(lum[i + 1] - lum[i - 1]);
    }
    ve[x] = s / dh;
  }

  const he = new Float32Array(dh);
  for (let y = 1; y < dh - 1; y++) {
    let s = 0;
    for (let x = 0; x < dw; x++) {
      s += Math.abs(lum[(y + 1) * dw + x] - lum[(y - 1) * dw + x]);
    }
    he[y] = s / dw;
  }

  const median = (arr, from, to) => {
    const slice = Array.from(arr.slice(from, to)).sort((a, b) => a - b);
    return slice[Math.floor(slice.length / 2)] || 1;
  };
  const medV = median(ve, 8, dw - 8);
  const medH = median(he, 8, dh - 8);
  const med = (medV + medH) / 2;

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
      const ideal = Math.round((i * dw) / cols);
      vSeams.push(bestSeam(ve, ideal, dw, Math.max(6, Math.round(dw * 0.02))));
    }
    for (let i = 1; i < rows; i++) {
      const ideal = Math.round((i * dh) / rows);
      hSeams.push(bestSeam(he, ideal, dh, Math.max(6, Math.round(dh * 0.02))));
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
      ratio: avgE / Math.max(med, 1),
      minRatio: minE / Math.max(med, 1),
      vSeams: vSeams.map((s) => s.pos),
      hSeams: hSeams.map((s) => s.pos),
      cells: rows * cols,
    };
  };

  let chosen = null;
  if (forcedGrid) {
    chosen = scoreGrid(forcedGrid.rows, forcedGrid.cols);
    // Forced split always proceeds even if seams are weak — use equal cuts
    // when detection confidence is low.
    if (!chosen || chosen.minRatio < 2) {
      chosen = {
        rows: forcedGrid.rows,
        cols: forcedGrid.cols,
        vSeams: Array.from({ length: forcedGrid.cols - 1 }, (_, i) =>
          Math.round(((i + 1) * dw) / forcedGrid.cols)
        ),
        hSeams: Array.from({ length: forcedGrid.rows - 1 }, (_, i) =>
          Math.round(((i + 1) * dh) / forcedGrid.rows)
        ),
        cells: forcedGrid.rows * forcedGrid.cols,
      };
    }
  } else {
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
      // Strong seams only — avoid chopping a normal photo.
      if (scored.minRatio < 4.5 || scored.ratio < 5.5) continue;
      if (
        !best ||
        scored.cells > best.cells ||
        (scored.cells === best.cells && scored.avgE > best.avgE)
      ) {
        best = scored;
      }
    }
    chosen = best;
  }

  if (!chosen || chosen.cells < 2) {
    bitmap.close?.();
    return null;
  }

  const toSrc = (v, full) => Math.round(v / scale);
  const xs = [0, ...chosen.vSeams.map((v) => toSrc(v, srcW)), srcW]
    .map((v, i, arr) => {
      if (i === 0) return 0;
      if (i === arr.length - 1) return srcW;
      return Math.min(srcW - 1, Math.max(1, v));
    })
    .filter((v, i, arr) => i === 0 || v > arr[i - 1]);
  const ys = [0, ...chosen.hSeams.map((v) => toSrc(v, srcH)), srcH]
    .map((v, i, arr) => {
      if (i === 0) return 0;
      if (i === arr.length - 1) return srcH;
      return Math.min(srcH - 1, Math.max(1, v));
    })
    .filter((v, i, arr) => i === 0 || v > arr[i - 1]);

  // Ensure we have the expected number of boundaries; fall back to equal split.
  const needX = chosen.cols + 1;
  const needY = chosen.rows + 1;
  const boundsX =
    xs.length === needX
      ? xs
      : Array.from({ length: needX }, (_, i) => Math.round((i * srcW) / chosen.cols));
  const boundsY =
    ys.length === needY
      ? ys
      : Array.from({ length: needY }, (_, i) => Math.round((i * srcH) / chosen.rows));

  // Trim well past the gutter so the previous/next panel never bleeds in
  const cellW = Math.max(8, Math.round(srcW / chosen.cols));
  const cellH = Math.max(8, Math.round(srcH / chosen.rows));
  const insetX = Math.max(4, Math.round(cellW * 0.025));
  const insetY = Math.max(4, Math.round(cellH * 0.025));
  const cropCanvas = document.createElement("canvas");
  const cctx = cropCanvas.getContext("2d");
  const base = file.name.replace(/\.[^.]+$/, "") || "slide";
  const tiles = [];

  for (let r = 0; r < chosen.rows; r++) {
    for (let c = 0; c < chosen.cols; c++) {
      const x0 = Math.min(srcW - 9, boundsX[c] + insetX);
      const y0 = Math.min(srcH - 9, boundsY[r] + insetY);
      const x1 = Math.max(x0 + 8, boundsX[c + 1] - insetX);
      const y1 = Math.max(y0 + 8, boundsY[r + 1] - insetY);
      const tw = x1 - x0;
      const th = y1 - y0;
      cropCanvas.width = tw;
      cropCanvas.height = th;
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";
      cctx.clearRect(0, 0, tw, th);
      cctx.drawImage(bitmap, x0, y0, tw, th, 0, 0, tw, th);
      // PNG keeps split panels sharp (JPEG was softening them)
      const blob = await new Promise((resolve) =>
        cropCanvas.toBlob(resolve, "image/png")
      );
      if (!blob) continue;
      const name = `${base}_${r + 1}-${c + 1}.png`;
      tiles.push(new File([blob], name, { type: "image/png" }));
    }
  }

  bitmap.close?.();
  if (tiles.length < 2) return null;
  return { files: tiles, rows: chosen.rows, cols: chosen.cols };
}

function IconUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 14l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ProgressBlock({ active, progress, stage, error }) {
  return (
    <>
      {(active || progress > 0) && (
        <div className="progress-wrap">
          <div className="progress-row">
            <span className="progress-label">
              {stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : "Working"}
            </span>
            <span className="progress-value">{progress}%</span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.max(2, progress)}%` }} />
          </div>
        </div>
      )}
      {error && <div className="alert alert--error">{error}</div>}
    </>
  );
}

function Dropzone({
  dragOver,
  setDragOver,
  onFiles,
  multiple,
  title,
  subtitle,
  disabled,
  inputRef,
  accept = "video/*",
  kind = "video",
}) {
  const kindLabel =
    kind === "audio" ? "audio" : kind === "image" ? "image" : "video";
  return (
    <div
      className={`dropzone ${dragOver ? "dropzone--over" : ""} ${
        disabled ? "dropzone--disabled" : ""
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="dropzone-icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path
            d="M12 15V5m0 0-3.5 3.5M12 5l3.5 3.5M5 18h14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="dropzone-copy">
        <p className="dropzone-title">
          <span>Choose file{multiple ? "s" : ""}</span> or drag {kindLabel}
          {multiple ? "s" : ""} here
        </p>
        <p className="dropzone-sub">{subtitle || title}</p>
      </div>
    </div>
  );
}

function MergeTab() {
  const [clips, setClips] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [merging, setMerging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [coverOn, setCoverOn] = useState(false);
  const [coverMode, setCoverMode] = useState("blur");
  const [coverBox, setCoverBox] = useState({ x: 70, y: 78, w: 26, h: 16 });
  const [coverText, setCoverText] = useState("");
  const [coverTextColor, setCoverTextColor] = useState("#ffffff");
  const [coverBgColor, setCoverBgColor] = useState("#111111");
  const [coverBgTransparent, setCoverBgTransparent] = useState(false);
  const [coverFontScale, setCoverFontScale] = useState(0.34);
  const [coverImage, setCoverImage] = useState(null);
  const [layout, setLayout] = useState("auto");
  const [addFloatingText, setAddFloatingText] = useState(false);
  const [brandText, setBrandText] = useState("Reals Maker");
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const fileInputRef = useRef(null);
  const coverImageRef = useRef(null);
  const mergeVideoRef = useRef(null);
  const dragItemId = useRef(null);

  useEffect(() => {
    return () => {
      clips.forEach((c) => URL.revokeObjectURL(c.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalSize = useMemo(
    () => clips.reduce((s, c) => s + c.file.size, 0),
    [clips]
  );

  function addFiles(fileList) {
    const arr = Array.from(fileList).filter((f) => f.type.startsWith("video/"));
    if (!arr.length) return;
    const next = arr.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,
      file,
      url: URL.createObjectURL(file),
    }));
    setClips((prev) => [...prev, ...next]);
    setDownloadUrl("");
    setError("");
  }

  function removeClip(id) {
    setClips((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((c) => c.id !== id);
    });
  }

  function moveClip(id, dir) {
    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(newIdx, 0, item);
      return next;
    });
  }

  function onDragStart(id) {
    dragItemId.current = id;
  }

  function onDragOverItem(e, overId) {
    e.preventDefault();
    const draggedId = dragItemId.current;
    if (!draggedId || draggedId === overId) return;
    setClips((prev) => {
      const from = prev.findIndex((c) => c.id === draggedId);
      const to = prev.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function clearAll() {
    clips.forEach((c) => URL.revokeObjectURL(c.url));
    setClips([]);
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
  }

  const minClips =
    coverOn || addFloatingText || playbackSpeed !== 1 ? 1 : 2;
  const isMergeMode = clips.length > 1;

  async function handleMerge() {
    if (clips.length < minClips) {
      setError(
        minClips === 1
          ? "Add at least one video to continue."
          : "Add at least two videos, or enable watermark or brand options."
      );
      return;
    }
    if (addFloatingText && !brandText.trim()) {
      setError("Enter your company name for the brand watermark.");
      return;
    }
    if (coverOn && coverMode === "text" && !coverText.trim()) {
      setError("Enter the text that should cover the watermark.");
      return;
    }
    if (coverOn && coverMode === "image" && !coverImage) {
      setError("Upload an image to place over the watermark.");
      return;
    }

    setError("");
    setDownloadUrl("");
    setMerging(true);
    setProgress(2);
    setStage("uploading");

    try {
      const form = new FormData();
      clips.forEach((c) => form.append("videos", c.file, c.file.name));
      form.append("coverOn", coverOn ? "true" : "false");
      form.append("coverMode", coverMode);
      form.append("coverX", String(coverBox.x));
      form.append("coverY", String(coverBox.y));
      form.append("coverW", String(coverBox.w));
      form.append("coverH", String(coverBox.h));
      form.append("coverText", coverText.trim());
      form.append("coverTextColor", coverTextColor);
      form.append("coverBgColor", coverBgColor);
      form.append("coverBgTransparent", coverBgTransparent ? "true" : "false");
      form.append("coverFontScale", String(coverFontScale));
      if (coverOn && coverMode === "image" && coverImage) {
        form.append("coverImage", coverImage, coverImage.name);
      }
      form.append("layout", layout);
      form.append("addFloatingText", addFloatingText ? "true" : "false");
      form.append("brandText", brandText.trim());
      form.append("playbackSpeed", String(playbackSpeed));

      const res = await fetch("/api/merge", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }

      const { jobId: id, downloadUrl: url } = await res.json();
      setJobId(id);
      setProgress(8);
      setStage("processing");
      await pollStatus(id, { setProgress, setStage });

      setDownloadUrl(url);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      setError(err.message || "Something went wrong");
      setStage("");
    } finally {
      setMerging(false);
    }
  }

  const actionLabel = merging
    ? "Processing…"
    : coverOn && addFloatingText && !isMergeMode
    ? "Process video"
    : coverOn && isMergeMode
    ? "Cover & merge"
    : addFloatingText && !isMergeMode
    ? "Apply brand mark"
    : addFloatingText && isMergeMode
    ? "Brand & merge"
    : "Merge videos";

  return (
    <>
      <section className="workspace-section">
        <Dropzone
          dragOver={dragOver}
          setDragOver={setDragOver}
          onFiles={addFiles}
          multiple
          subtitle="MP4, MOV, WebM, MKV · max 500 MB each"
          disabled={merging}
          inputRef={fileInputRef}
        />
      </section>

      {clips.length > 0 && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Queue</h2>
            <div className="clips-head-actions">
              <span className="clips-meta">
                <strong>{clips.length}</strong> clip{clips.length !== 1 && "s"} ·{" "}
                {formatSize(totalSize)}
              </span>
              <button className="btn btn-ghost" onClick={clearAll} disabled={merging}>
                Clear
              </button>
            </div>
          </div>

          <ul className="clips">
            {clips.map((c, i) => (
              <li
                key={c.id}
                className="clip"
                draggable={!merging}
                onDragStart={() => onDragStart(c.id)}
                onDragOver={(e) => onDragOverItem(e, c.id)}
                onDragEnd={() => (dragItemId.current = null)}
              >
                <span className="clip-order">{String(i + 1).padStart(2, "0")}</span>
                <video
                  src={c.url}
                  className="clip-thumb"
                  muted
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => {
                    e.currentTarget.playbackRate = playbackSpeed;
                    e.currentTarget.play().catch(() => {});
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.pause();
                    e.currentTarget.currentTime = 0;
                  }}
                />
                <div className="clip-info">
                  <div className="clip-name" title={c.file.name}>
                    {c.file.name}
                  </div>
                  <div className="clip-meta">{formatSize(c.file.size)}</div>
                </div>
                <div className="clip-actions">
                  <button
                    className="icon-btn"
                    onClick={() => moveClip(c.id, -1)}
                    disabled={i === 0 || merging}
                    aria-label="Move up"
                    title="Move up"
                  >
                    <IconUp />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => moveClip(c.id, 1)}
                    disabled={i === clips.length - 1 || merging}
                    aria-label="Move down"
                    title="Move down"
                  >
                    <IconDown />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => removeClip(c.id)}
                    disabled={merging}
                    aria-label="Remove"
                    title="Remove"
                  >
                    <IconClose />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="workspace-section">
        <h2 className="section-title">Export settings</h2>

        <div className="settings">
          <div className="setting-row">
            <div className="setting-main">
              <span className="setting-label">Cover watermark</span>
              <span className="setting-desc">
                Place a box anywhere on the first clip, then blur that spot
                or cover it with text or an image.
              </span>
            </div>
            <div className="setting-control">
              <label className={`toggle ${coverOn ? "toggle--on" : ""}`}>
                <input
                  type="checkbox"
                  checked={coverOn}
                  onChange={(e) => setCoverOn(e.target.checked)}
                  disabled={merging}
                />
                <span className="toggle-track">
                  <span className="toggle-thumb" />
                </span>
              </label>
            </div>
          </div>

          {coverOn && (
            <>
              <div className="setting-row setting-row--stack">
                <div className="setting-main">
                  <span className="setting-label">Cover style</span>
                  <span className="setting-desc">
                    Blur hides the mark. Text or image replaces it.
                  </span>
                </div>
                <div className="cover-modes" role="radiogroup" aria-label="Cover style">
                  {[
                    { id: "blur", label: "Blur" },
                    { id: "text", label: "Text + background" },
                    { id: "image", label: "Image" },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`speed-btn ${coverMode === opt.id ? "speed-btn--active" : ""}`}
                      onClick={() => setCoverMode(opt.id)}
                      disabled={merging}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {coverMode === "text" && (
                <CoverTextStyleFields
                  idPrefix="merge"
                  text={coverText}
                  setText={setCoverText}
                  textColor={coverTextColor}
                  setTextColor={setCoverTextColor}
                  bgColor={coverBgColor}
                  setBgColor={setCoverBgColor}
                  bgTransparent={coverBgTransparent}
                  setBgTransparent={setCoverBgTransparent}
                  fontScale={coverFontScale}
                  setFontScale={setCoverFontScale}
                  disabled={merging}
                />
              )}
              {coverMode === "image" && (
                <div className="brand-field">
                  <span className="field-label">Cover image</span>
                  <div className="cover-image-row">
                    <input
                      ref={coverImageRef}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        const img = e.target.files?.[0];
                        if (img) setCoverImage(img);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={merging}
                      onClick={() => coverImageRef.current?.click()}
                    >
                      {coverImage ? "Change image" : "Upload image"}
                    </button>
                    {coverImage && (
                      <span className="clip-meta">{coverImage.name}</span>
                    )}
                  </div>
                </div>
              )}
              {clips[0] && (
                <div className="merge-cover-preview">
                  <CoverBoxEditor
                    videoRef={mergeVideoRef}
                    src={clips[0].url}
                    box={coverBox}
                    setBox={setCoverBox}
                    disabled={merging}
                    mode={coverMode}
                    text={coverText}
                    textColor={coverTextColor}
                    bgColor={coverBgColor}
                    bgTransparent={coverBgTransparent}
                    fontScale={coverFontScale}
                    imageFile={coverImage}
                  />
                  <p className="section-hint cover-hint">
                    Text and image show live on the video. Drag to place,
                    corner to resize. Same spot on every clip.
                  </p>
                </div>
              )}
            </>
          )}

          <div className="setting-row setting-row--stack">
            <div className="setting-row" style={{ padding: 0, border: "none" }}>
              <div className="setting-main">
                <span className="setting-label">Floating brand text (optional)</span>
                <span className="setting-desc">
                  Enable to show your company name moving over the video.
                </span>
              </div>
              <div className="setting-control">
                <label className={`toggle ${addFloatingText ? "toggle--on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={addFloatingText}
                    onChange={(e) => setAddFloatingText(e.target.checked)}
                    disabled={merging}
                  />
                  <span className="toggle-track">
                    <span className="toggle-thumb" />
                  </span>
                </label>
              </div>
            </div>

            {addFloatingText && (
              <div className="brand-field">
                <label className="field-label" htmlFor="brandText">
                  Company name
                </label>
                <input
                  id="brandText"
                  type="text"
                  className="brand-input"
                  placeholder="Reals Maker"
                  value={brandText}
                  onChange={(e) => setBrandText(e.target.value)}
                  disabled={merging}
                  maxLength={80}
                />
              </div>
            )}
          </div>

          <div className="setting-row setting-row--stack">
            <div className="setting-main">
              <span className="setting-label">Playback speed</span>
              <span className="setting-desc">
                Slow down or speed up the exported video. Preview uses the same speed on hover.
              </span>
            </div>
            <div className="speed-grid" role="radiogroup" aria-label="Playback speed">
              {PLAYBACK_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={`speed-btn ${
                    playbackSpeed === speed ? "speed-btn--active" : ""
                  }`}
                  onClick={() => setPlaybackSpeed(speed)}
                  disabled={merging}
                  role="radio"
                  aria-checked={playbackSpeed === speed}
                >
                  {speed === 1 ? "1×" : `${speed}×`}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row setting-row--stack">
            <div className="setting-main">
              <span className="setting-label">Output format</span>
              <span className="setting-desc">Resolution and orientation of the final export.</span>
            </div>
            <div className="layout-grid" role="radiogroup" aria-label="Output layout">
              {LAYOUTS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`layout-card ${layout === opt.id ? "layout-card--active" : ""}`}
                  onClick={() => setLayout(opt.id)}
                  disabled={merging}
                  role="radio"
                  aria-checked={layout === opt.id}
                >
                  <span className="layout-icon">{opt.icon}</span>
                  <span className="layout-name">{opt.title}</span>
                  <span className="layout-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-section">
        <ProgressBlock
          active={merging}
          progress={progress}
          stage={stage}
          error={error}
        />

        <div
          className={`action-bar${
            merging || progress > 0 || error ? " action-bar--spaced" : ""
          }`}
        >
          <button
            className="btn btn-primary"
            onClick={handleMerge}
            disabled={merging || clips.length < minClips}
          >
            {actionLabel}
          </button>

          {downloadUrl && !merging && (
            <a
              className="btn btn-success"
              href={downloadUrl}
              download="zyvom-latest.mp4"
            >
              Download MP4
            </a>
          )}
        </div>
      </section>
    </>
  );
}

function CoverBoxEditor({
  videoRef,
  src,
  onLoadedMetadata,
  box,
  setBox,
  disabled,
  mode = "blur",
  text = "",
  textColor = "#ffffff",
  bgColor = "#111111",
  bgTransparent = false,
  fontScale = 0.34,
  imageFile = null,
}) {
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const [, setTick] = useState(0);
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setTick((n) => n + 1));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!imageFile) {
      setImageUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(imageFile);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  function contentRect() {
    const video = videoRef.current;
    const wrap = wrapRef.current;
    if (!video || !wrap || !video.videoWidth) return null;
    const wr = wrap.getBoundingClientRect();
    const vr = video.getBoundingClientRect();
    const scale = Math.min(vr.width / video.videoWidth, vr.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    return {
      left: vr.left - wr.left + (vr.width - width) / 2,
      top: vr.top - wr.top + (vr.height - height) / 2,
      width,
      height,
    };
  }

  function clampBox(next) {
    const w = Math.max(4, Math.min(100, next.w));
    const h = Math.max(4, Math.min(100, next.h));
    return {
      w,
      h,
      x: Math.max(-w + 3, Math.min(97, next.x)),
      y: Math.max(-h + 3, Math.min(97, next.y)),
    };
  }

  function onPointerDown(e, dragMode) {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = contentRect();
    if (!rect) return;
    drag.current = {
      mode: dragMode,
      startX: e.clientX,
      startY: e.clientY,
      box: { ...box },
      rect,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  useEffect(() => {
    function onPointerMove(e) {
      if (!drag.current) return;
      const { mode: dragMode, startX, startY, box: start, rect } = drag.current;
      const dx = ((e.clientX - startX) / rect.width) * 100;
      const dy = ((e.clientY - startY) / rect.height) * 100;
      const next = { ...start };
      if (dragMode === "move") {
        next.x = start.x + dx;
        next.y = start.y + dy;
      } else {
        next.w = start.w + dx;
        next.h = start.h + dy;
      }
      setBox(clampBox(next));
    }

    function onPointerUp() {
      drag.current = null;
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [setBox]);

  const rect = contentRect();
  const previewFontPx = rect
    ? Math.max(
        10,
        Math.round(
          Math.min((box.w / 100) * rect.width, (box.h / 100) * rect.height) *
            fontScale
        )
      )
    : 16;

  return (
    <div className="cover-stage" ref={wrapRef}>
      <video
        ref={videoRef}
        src={src}
        className="split-preview split-preview--contain"
        muted
        playsInline
        preload="metadata"
        controls
        onLoadedMetadata={(e) => {
          onLoadedMetadata?.(e);
          setTick((n) => n + 1);
        }}
      />
      {rect && (
        <div
          className={`cover-box cover-box--${mode}${
            mode === "text" && bgTransparent ? " cover-box--text-clear" : ""
          }${disabled ? " cover-box--off" : ""}`}
          style={{
            left: rect.left + (box.x / 100) * rect.width,
            top: rect.top + (box.y / 100) * rect.height,
            width: (box.w / 100) * rect.width,
            height: (box.h / 100) * rect.height,
            ...(mode === "text"
              ? {
                  background: bgTransparent
                    ? "transparent"
                    : hexToRgba(bgColor, 0.88),
                }
              : {}),
          }}
          onPointerDown={(e) => onPointerDown(e, "move")}
        >
          {mode === "image" && imageUrl && (
            <img src={imageUrl} alt="" className="cover-box-image" draggable={false} />
          )}
          {mode === "text" && (
            <span
              className="cover-box-text"
              style={{ color: textColor, fontSize: previewFontPx }}
            >
              {text.trim() || "Your text"}
            </span>
          )}
          {mode === "blur" && <span className="cover-box-frost" />}
          {mode === "image" && !imageUrl && (
            <span className="cover-box-empty">Upload an image</span>
          )}
          <span className="cover-box-label">
            {mode === "text" ? "Text" : mode === "image" ? "Image" : "Blur"}
          </span>
          <button
            type="button"
            className="cover-handle"
            aria-label="Resize cover box"
            onPointerDown={(e) => onPointerDown(e, "resize")}
          />
        </div>
      )}
    </div>
  );
}

function SplitTab() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [parts, setParts] = useState(0);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [partCount, setPartCount] = useState(2);
  const [coverOn, setCoverOn] = useState(false);
  const [coverMode, setCoverMode] = useState("blur");
  const [coverBox, setCoverBox] = useState({ x: 70, y: 78, w: 26, h: 16 });
  const [coverText, setCoverText] = useState("");
  const [coverTextColor, setCoverTextColor] = useState("#ffffff");
  const [coverBgColor, setCoverBgColor] = useState("#111111");
  const [coverBgTransparent, setCoverBgTransparent] = useState(false);
  const [coverFontScale, setCoverFontScale] = useState(0.34);
  const [coverImage, setCoverImage] = useState(null);
  const fileInputRef = useRef(null);
  const coverImageRef = useRef(null);
  const videoRef = useRef(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const safeParts = Math.max(2, Math.min(80, Number.parseInt(partCount, 10) || 2));
  const partLengthSec = duration > 0 ? duration / safeParts : 0;

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
    setDuration(0);
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
    setParts(0);
    setCoverImage(null);
  }

  function addFile(fileList) {
    const video = Array.from(fileList).find((f) => f.type.startsWith("video/"));
    if (!video) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(video);
    setFile(video);
    setPreviewUrl(url);
    setDuration(0);
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
    setParts(0);
  }

  async function handleSplit() {
    if (!file) {
      setError("Upload a video to split.");
      return;
    }
    if (safeParts < 2) {
      setError("Enter at least 2 parts.");
      return;
    }
    if (coverOn && coverMode === "text" && !coverText.trim()) {
      setError("Enter the text that should cover the watermark.");
      return;
    }
    if (coverOn && coverMode === "image" && !coverImage) {
      setError("Upload an image to place over the watermark.");
      return;
    }

    setError("");
    setDownloadUrl("");
    setSplitting(true);
    setProgress(2);
    setStage("uploading");
    setParts(0);

    try {
      const form = new FormData();
      form.append("video", file, file.name);
      form.append("parts", String(safeParts));
      form.append("coverOn", coverOn ? "true" : "false");
      form.append("coverMode", coverMode);
      form.append("coverX", String(coverBox.x));
      form.append("coverY", String(coverBox.y));
      form.append("coverW", String(coverBox.w));
      form.append("coverH", String(coverBox.h));
      form.append("coverText", coverText.trim());
      form.append("coverTextColor", coverTextColor);
      form.append("coverBgColor", coverBgColor);
      form.append("coverBgTransparent", coverBgTransparent ? "true" : "false");
      form.append("coverFontScale", String(coverFontScale));
      if (coverOn && coverMode === "image" && coverImage) {
        form.append("coverImage", coverImage, coverImage.name);
      }

      const res = await fetch("/api/split", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }

      const { jobId: id, downloadUrl: url } = await res.json();
      setJobId(id);
      setProgress(8);
      setStage("processing");
      await pollStatus(id, { setProgress, setStage, setParts });

      setDownloadUrl(url);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      setError(err.message || "Something went wrong");
      setStage("");
    } finally {
      setSplitting(false);
    }
  }

  return (
    <>
      <section className="workspace-section">
          <div className="split-intro">
            <h2 className="section-title">Split video</h2>
            <p className="section-hint">
              Upload one video, type how many parts you want, then download a ZIP.
            </p>
          </div>
          <Dropzone
            dragOver={dragOver}
            setDragOver={setDragOver}
            onFiles={addFile}
            multiple={false}
            subtitle="MP4, MOV, WebM, MKV · max 2 GB"
            disabled={splitting}
            inputRef={fileInputRef}
          />
        </section>

        <section className="workspace-section">
          <h2 className="section-title">Split settings</h2>
          <div className="settings">
            <div className="setting-row">
              <div className="setting-main">
                <span className="setting-label">Number of parts</span>
                <span className="setting-desc">
                  Video is cut into this many equal pieces (2–80).
                </span>
              </div>
              <div className="setting-control">
                <input
                  className="brand-input parts-input"
                  type="number"
                  min={2}
                  max={80}
                  step={1}
                  value={partCount}
                  onChange={(e) => setPartCount(e.target.value)}
                  disabled={splitting}
                  aria-label="Number of parts"
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-main">
                <span className="setting-label">Cover watermark</span>
                <span className="setting-desc">
                  Draw a box on the video, then blur that spot or cover it
                  with text or an image.
                </span>
              </div>
              <div className="setting-control">
                <label className={`toggle ${coverOn ? "toggle--on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={coverOn}
                    onChange={(e) => setCoverOn(e.target.checked)}
                    disabled={splitting}
                  />
                  <span className="toggle-track">
                    <span className="toggle-thumb" />
                  </span>
                </label>
              </div>
            </div>
            {coverOn && (
              <>
                <div className="setting-row setting-row--stack">
                  <div className="setting-main">
                    <span className="setting-label">Cover style</span>
                    <span className="setting-desc">
                      Blur hides the mark. Text or image replaces it.
                    </span>
                  </div>
                  <div className="cover-modes" role="radiogroup" aria-label="Cover style">
                    {[
                      { id: "blur", label: "Blur" },
                      { id: "text", label: "Text + background" },
                      { id: "image", label: "Image" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`speed-btn ${coverMode === opt.id ? "speed-btn--active" : ""}`}
                        onClick={() => setCoverMode(opt.id)}
                        disabled={splitting}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                {coverMode === "text" && (
                  <CoverTextStyleFields
                    idPrefix="split"
                    text={coverText}
                    setText={setCoverText}
                    textColor={coverTextColor}
                    setTextColor={setCoverTextColor}
                    bgColor={coverBgColor}
                    setBgColor={setCoverBgColor}
                    bgTransparent={coverBgTransparent}
                    setBgTransparent={setCoverBgTransparent}
                    fontScale={coverFontScale}
                    setFontScale={setCoverFontScale}
                    disabled={splitting}
                  />
                )}
                {coverMode === "image" && (
                  <div className="brand-field">
                    <span className="field-label">Cover image</span>
                    <div className="cover-image-row">
                      <input
                        ref={coverImageRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const img = e.target.files?.[0];
                          if (img) setCoverImage(img);
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={splitting}
                        onClick={() => coverImageRef.current?.click()}
                      >
                        {coverImage ? "Change image" : "Upload image"}
                      </button>
                      {coverImage && (
                        <span className="clip-meta">{coverImage.name}</span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {file && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Source</h2>
            <button className="btn btn-ghost" onClick={clearFile} disabled={splitting}>
              Clear
            </button>
          </div>

          <div className={`split-source${coverOn ? " split-source--cover" : ""}`}>
            {coverOn ? (
              <>
                <CoverBoxEditor
                  videoRef={videoRef}
                  src={previewUrl}
                  onLoadedMetadata={(e) =>
                    setDuration(e.currentTarget.duration || 0)
                  }
                  box={coverBox}
                  setBox={setCoverBox}
                  disabled={splitting}
                  mode={coverMode}
                  text={coverText}
                  textColor={coverTextColor}
                  bgColor={coverBgColor}
                  bgTransparent={coverBgTransparent}
                  fontScale={coverFontScale}
                  imageFile={coverImage}
                />
                <p className="section-hint cover-hint">
                  Text and image show live on the video. Drag to place,
                  corner to resize.
                </p>
              </>
            ) : (
              <video
                src={previewUrl}
                className="split-preview"
                muted
                playsInline
                preload="metadata"
                controls
                onLoadedMetadata={(e) =>
                  setDuration(e.currentTarget.duration || 0)
                }
              />
            )}
            <div className="split-meta">
              <div className="clip-name" title={file.name}>
                {file.name}
              </div>
              <div className="clip-meta">
                {formatSize(file.size)}
                {duration > 0 && <> · {formatDuration(duration)}</>}
              </div>
              {duration > 0 && (
                <p className="split-estimate">
                  Will create <strong>{safeParts}</strong> part
                  {safeParts !== 1 ? "s" : ""}
                  {partLengthSec > 0 && (
                    <> · about <strong>{formatDuration(partLengthSec)}</strong> each</>
                  )}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="workspace-section">
        <ProgressBlock
          active={splitting}
          progress={progress}
          stage={
            parts > 0 && stage === "complete"
              ? `complete · ${parts} parts`
              : stage
          }
          error={error}
        />

        <div
          className={`action-bar${
            splitting || progress > 0 || error ? " action-bar--spaced" : ""
          }`}
        >
          <button
            className="btn btn-primary"
            onClick={handleSplit}
            disabled={splitting || !file}
          >
            {splitting ? "Splitting…" : `Split into ${safeParts} parts`}
          </button>

          {downloadUrl && !splitting && (
            <a
              className="btn btn-success"
              href={downloadUrl}
              download="zyvom-split-latest.zip"
            >
              Download ZIP{parts > 0 ? ` (${parts} parts)` : ""}
            </a>
          )}
        </div>
      </section>
    </>
  );
}

function MusicTab() {
  const [audios, setAudios] = useState([]);
  const [images, setImages] = useState([]);
  const [audioDragOver, setAudioDragOver] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [layout, setLayout] = useState("auto");
  const [collageGrid, setCollageGrid] = useState("auto");
  const [audioVisualizer, setAudioVisualizer] = useState(true);
  const [fallingFlowers, setFallingFlowers] = useState(true);
  const [splitNote, setSplitNote] = useState("");
  const audioInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const dragAudioId = useRef(null);
  const dragImageId = useRef(null);

  useEffect(() => {
    return () => {
      audios.forEach((a) => URL.revokeObjectURL(a.url));
      images.forEach((img) => URL.revokeObjectURL(img.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isAudioFile(file) {
    return (
      file.type.startsWith("audio/") ||
      /\.(mp3|m4a|aac|wav|ogg|flac|wma)$/i.test(file.name)
    );
  }

  function isImageFile(file) {
    return (
      file.type.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name)
    );
  }

  function fileToQueueItem(file) {
    return {
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,
      file,
      url: URL.createObjectURL(file),
    };
  }

  function reorderQueue(setter, dragRef) {
    return {
      onDragStart(id) {
        dragRef.current = id;
      },
      onDragOverItem(e, overId) {
        e.preventDefault();
        const draggedId = dragRef.current;
        if (!draggedId || draggedId === overId) return;
        setter((prev) => {
          const from = prev.findIndex((c) => c.id === draggedId);
          const to = prev.findIndex((c) => c.id === overId);
          if (from < 0 || to < 0) return prev;
          const next = [...prev];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          return next;
        });
      },
      moveItem(id, dir) {
        setter((prev) => {
          const idx = prev.findIndex((c) => c.id === id);
          if (idx < 0) return prev;
          const newIdx = idx + dir;
          if (newIdx < 0 || newIdx >= prev.length) return prev;
          const next = [...prev];
          const [item] = next.splice(idx, 1);
          next.splice(newIdx, 0, item);
          return next;
        });
      },
      removeItem(id) {
        setter((prev) => {
          const target = prev.find((c) => c.id === id);
          if (target) URL.revokeObjectURL(target.url);
          return prev.filter((c) => c.id !== id);
        });
      },
    };
  }

  const audioQueue = reorderQueue(setAudios, dragAudioId);
  const imageQueue = reorderQueue(setImages, dragImageId);

  function addAudio(fileList) {
    const arr = Array.from(fileList).filter(isAudioFile);
    if (!arr.length) return;
    const next = arr.map(fileToQueueItem);
    setAudios((prev) => [...prev, ...next].slice(0, 50));
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
  }

  function clearAudios() {
    audios.forEach((a) => URL.revokeObjectURL(a.url));
    setAudios([]);
    setDownloadUrl("");
    setError("");
  }

  async function addImages(fileList) {
    const arr = Array.from(fileList).filter(isImageFile);
    if (!arr.length) return;

    setError("");
    setDownloadUrl("");
    setSplitNote("");

    // Off = never crop. Otherwise try detecting a grid on EACH file:
    // normal photos stay as-is; collage grids become separate panels.
    if (collageGrid === "off") {
      const next = arr.map(fileToQueueItem);
      setImages((prev) => [...prev, ...next].slice(0, 100));
      return;
    }

    setSplitting(true);
    try {
      const forced = parseGridId(collageGrid);
      const expanded = [];
      const notes = [];

      for (const file of arr) {
        try {
          const split = await splitCollageFile(file, forced);
          if (split?.files?.length) {
            expanded.push(...split.files);
            notes.push(
              `${file.name} → ${split.rows}×${split.cols} (${split.files.length} panels)`
            );
          } else {
            expanded.push(file);
          }
        } catch {
          expanded.push(file);
        }
      }

      const next = expanded.map(fileToQueueItem);
      setImages((prev) => [...prev, ...next].slice(0, 100));
      if (notes.length) {
        setSplitNote(notes.join(" · "));
      }
    } finally {
      setSplitting(false);
    }
  }

  function clearImages() {
    images.forEach((img) => URL.revokeObjectURL(img.url));
    setImages([]);
    setDownloadUrl("");
    setError("");
    setSplitNote("");
  }

  async function handleCreate() {
    if (audios.length < 1) {
      setError("Upload at least one MP3 / audio track.");
      return;
    }
    if (images.length < 1) {
      setError("Add at least one image for the slideshow.");
      return;
    }

    setError("");
    setDownloadUrl("");
    setCreating(true);
    setProgress(2);
    setStage("uploading");

    try {
      const form = new FormData();
      audios.forEach((a) => form.append("audio", a.file, a.file.name));
      images.forEach((img) => form.append("images", img.file, img.file.name));
      form.append("layout", layout);
      form.append("visualizer", audioVisualizer ? "true" : "false");
      form.append("flowers", fallingFlowers ? "true" : "false");

      const res = await fetch("/api/slideshow", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }

      const { jobId: id, downloadUrl: url } = await res.json();
      setJobId(id);
      setProgress(8);
      setStage("processing");
      await pollStatus(id, { setProgress, setStage });

      setDownloadUrl(url);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      setError(err.message || "Something went wrong");
      setStage("");
    } finally {
      setCreating(false);
    }
  }

  const busy = creating || splitting;
  const audioTotalSize = audios.reduce((s, a) => s + a.file.size, 0);

  return (
    <>
      <section className="workspace-section">
        <div className="split-intro">
          <h2 className="section-title">Music video</h2>
          <p className="section-hint">
            कई गाने अपलोड करो — सब एक लंबी ट्रैक में मर्ज हो जाएंगे। इमेजेस:
            सिंगल फोटो भी चलेगी, या कई फोटो / कोलॉज (ऑटो स्प्लिट)। स्लाइड्स मर्ज्ड
            म्यूजिक खत्म होने तक लूप होंगी।
          </p>
        </div>

        <div className="music-upload-grid">
          <div className="music-upload-block">
            <h3 className="music-upload-label">1. Music tracks</h3>
            <Dropzone
              dragOver={audioDragOver}
              setDragOver={setAudioDragOver}
              onFiles={addAudio}
              multiple
              accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
              kind="audio"
              subtitle="Multiple MP3s merge into one · max 100 MB each"
              disabled={busy}
              inputRef={audioInputRef}
            />
          </div>

          <div className="music-upload-block">
            <h3 className="music-upload-label">2. Images</h3>
            <Dropzone
              dragOver={imageDragOver}
              setDragOver={setImageDragOver}
              onFiles={addImages}
              multiple
              accept="image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp"
              kind="image"
              subtitle={
                splitting
                  ? "Detecting collage panels…"
                  : "Single photo OK · many photos as-is · collage auto-crops"
              }
              disabled={busy}
              inputRef={imageInputRef}
            />
          </div>
        </div>
      </section>

      {audios.length > 0 && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Music queue</h2>
            <div className="clips-head-actions">
              <span className="clips-meta">
                <strong>{audios.length}</strong> track
                {audios.length !== 1 && "s"}
                {audios.length > 1 ? " · will merge in this order" : ""}
                {" · "}
                {formatSize(audioTotalSize)}
              </span>
              <button
                className="btn btn-ghost"
                onClick={clearAudios}
                disabled={busy}
                type="button"
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="clips">
            {audios.map((track, i) => (
              <li
                key={track.id}
                className="clip"
                draggable={!busy}
                onDragStart={() => audioQueue.onDragStart(track.id)}
                onDragOver={(e) => audioQueue.onDragOverItem(e, track.id)}
                onDragEnd={() => (dragAudioId.current = null)}
              >
                <span className="clip-order">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="clip-thumb clip-thumb--audio" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                    <path
                      d="M9 18V6l12-2v12"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.8" />
                    <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </div>
                <div className="clip-info">
                  <div className="clip-name" title={track.file.name}>
                    {track.file.name}
                  </div>
                  <div className="clip-meta">{formatSize(track.file.size)}</div>
                  <audio src={track.url} controls preload="metadata" />
                </div>
                <div className="clip-actions">
                  <button
                    className="icon-btn"
                    onClick={() => audioQueue.moveItem(track.id, -1)}
                    disabled={i === 0 || busy}
                    aria-label="Move up"
                    title="Move up"
                    type="button"
                  >
                    <IconUp />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => audioQueue.moveItem(track.id, 1)}
                    disabled={i === audios.length - 1 || busy}
                    aria-label="Move down"
                    title="Move down"
                    type="button"
                  >
                    <IconDown />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => audioQueue.removeItem(track.id)}
                    disabled={busy}
                    aria-label="Remove"
                    title="Remove"
                    type="button"
                  >
                    <IconClose />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {images.length > 0 && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Image queue</h2>
            <div className="clips-head-actions">
              <span className="clips-meta">
                <strong>{images.length}</strong> image
                {images.length !== 1 && "s"}
              </span>
              <button
                className="btn btn-ghost"
                onClick={clearImages}
                disabled={busy}
                type="button"
              >
                Clear
              </button>
            </div>
          </div>

          {splitNote && <p className="section-hint collage-note">{splitNote}</p>}

          <ul className="clips">
            {images.map((img, i) => (
              <li
                key={img.id}
                className="clip"
                draggable={!busy}
                onDragStart={() => imageQueue.onDragStart(img.id)}
                onDragOver={(e) => imageQueue.onDragOverItem(e, img.id)}
                onDragEnd={() => (dragImageId.current = null)}
              >
                <span className="clip-order">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <img
                  src={img.url}
                  alt=""
                  className="clip-thumb clip-thumb--image"
                />
                <div className="clip-info">
                  <div className="clip-name" title={img.file.name}>
                    {img.file.name}
                  </div>
                  <div className="clip-meta">{formatSize(img.file.size)}</div>
                </div>
                <div className="clip-actions">
                  <button
                    className="icon-btn"
                    onClick={() => imageQueue.moveItem(img.id, -1)}
                    disabled={i === 0 || busy}
                    aria-label="Move up"
                    title="Move up"
                    type="button"
                  >
                    <IconUp />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => imageQueue.moveItem(img.id, 1)}
                    disabled={i === images.length - 1 || busy}
                    aria-label="Move down"
                    title="Move down"
                    type="button"
                  >
                    <IconDown />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => imageQueue.removeItem(img.id)}
                    disabled={busy}
                    aria-label="Remove"
                    title="Remove"
                    type="button"
                  >
                    <IconClose />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="workspace-section">
        <h2 className="section-title">Export settings</h2>
        <div className="settings">
          <div className="setting-row">
            <div className="setting-main">
              <span className="setting-label">Collage auto-crop</span>
              <span className="setting-desc">
                Single photo: stays as one slide. Collage grid: split into
                panels. Multiple separate photos: never cropped. Use 2×4 etc. if
                Auto misses the grid, or Off to keep files untouched.
              </span>
            </div>
            <div className="setting-control">
              <select
                className="brand-input collage-select"
                value={collageGrid}
                onChange={(e) => setCollageGrid(e.target.value)}
                disabled={busy}
                aria-label="Collage grid"
              >
                {COLLAGE_GRID_PRESETS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-main">
              <span className="setting-label">Audio visualizer</span>
              <span className="setting-desc">
                Full thumbnail fits the frame — nothing is cropped.
                Tall smooth spectrum bars overlay the bottom of the photo.
              </span>
            </div>
            <div className="setting-control">
              <label
                className={`toggle ${audioVisualizer ? "toggle--on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={audioVisualizer}
                  onChange={(e) => setAudioVisualizer(e.target.checked)}
                  disabled={busy}
                />
                <span className="toggle-track">
                  <span className="toggle-thumb" />
                </span>
              </label>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-main">
              <span className="setting-label">Falling flowers</span>
              <span className="setting-desc">
                Soft lit rose and marigold rain — light, depth, and glow
                over the framed photo.
              </span>
            </div>
            <div className="setting-control">
              <label
                className={`toggle ${fallingFlowers ? "toggle--on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={fallingFlowers}
                  onChange={(e) => setFallingFlowers(e.target.checked)}
                  disabled={busy}
                />
                <span className="toggle-track">
                  <span className="toggle-thumb" />
                </span>
              </label>
            </div>
          </div>

          <div className="setting-row setting-row--stack">
            <div className="setting-main">
              <span className="setting-label">Output format</span>
              <span className="setting-desc">
                Canvas size. Auto matches the photo ratio so nothing
                stretches. Photos fit inside the frame and loop with the song.
              </span>
            </div>
            <div className="layout-grid" role="radiogroup" aria-label="Output layout">
              {MUSIC_LAYOUTS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`layout-card ${
                    layout === opt.id ? "layout-card--active" : ""
                  }`}
                  onClick={() => setLayout(opt.id)}
                  disabled={busy}
                  role="radio"
                  aria-checked={layout === opt.id}
                >
                  <span className="layout-icon">{opt.icon}</span>
                  <span className="layout-name">{opt.title}</span>
                  <span className="layout-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-section">
        <ProgressBlock
          active={creating || splitting}
          progress={splitting ? 15 : progress}
          stage={splitting ? "splitting collage" : stage}
          error={error}
        />

        <div
          className={`action-bar${
            creating || splitting || progress > 0 || error
              ? " action-bar--spaced"
              : ""
          }`}
        >
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={busy || audios.length < 1 || images.length < 1}
            type="button"
          >
            {creating
              ? "Creating…"
              : splitting
                ? "Splitting…"
                : audios.length > 1
                  ? "Merge music & create video"
                  : "Create music video"}
          </button>

          {downloadUrl && !creating && (
            <a
              className="btn btn-success"
              href={downloadUrl}
              download="zyvom-music-latest.mp4"
            >
              Download MP4
            </a>
          )}
        </div>
      </section>
    </>
  );
}

function isVideoFile(file) {
  return (
    file.type.startsWith("video/") ||
    /\.(mp4|m4v|mov|mkv|webm|avi|3gp|ogv|ts|flv|wmv)$/i.test(file.name)
  );
}

function isAudioTrack(file) {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|m4a|aac|wav|ogg|flac|wma)$/i.test(file.name)
  );
}

function fileToMediaItem(file) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
      .toString(36)
      .slice(2, 7)}`,
    file,
    url: URL.createObjectURL(file),
  };
}

const DUET_FONTS = [
  { id: "jakarta", label: "Modern", family: '"Plus Jakarta Sans", sans-serif' },
  { id: "bebas", label: "Bold", family: '"Bebas Neue", sans-serif' },
  { id: "playfair", label: "Elegant", family: '"Playfair Display", serif' },
  { id: "pacifico", label: "Script", family: '"Pacifico", cursive' },
  { id: "oswald", label: "Poster", family: '"Oswald", sans-serif' },
  { id: "mono", label: "Mono", family: '"Roboto Mono", monospace' },
  { id: "comic", label: "Fun", family: '"Comic Neue", cursive' },
  { id: "merri", label: "Serif", family: '"Merriweather", serif' },
];

const DUET_LAYOUTS = [
  { id: "split", title: "Split", hint: "Drag the line" },
  { id: "circle", title: "Circle", hint: "Full + pip" },
];

const DUET_SPLIT_MIN = 22;
const DUET_SPLIT_MAX = 78;
const DUET_FRAME_W = 1080;
const DUET_FRAME_H = 1920;
const DUET_BAR_PX = 4;

function clampDuetSplit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(DUET_SPLIT_MIN, Math.min(DUET_SPLIT_MAX, n));
}

function duetSplitLayout(splitTopPercent) {
  const usable = DUET_FRAME_H - DUET_BAR_PX;
  const pct = clampDuetSplit(splitTopPercent);
  let topH = Math.round((usable * pct) / 100);
  topH = Math.max(2, Math.min(usable - 2, topH));
  if (topH % 2) topH += topH + 1 <= usable - 2 ? 1 : -1;
  const botH = usable - topH;
  return {
    topH,
    botH,
    topPct: (topH / DUET_FRAME_H) * 100,
    barPct: (DUET_BAR_PX / DUET_FRAME_H) * 100,
    botPct: (botH / DUET_FRAME_H) * 100,
  };
}

function splitTopFromStageY(clientY, rect) {
  if (!rect?.height) return 50;
  const y = ((clientY - rect.top) / rect.height) * DUET_FRAME_H;
  const usable = DUET_FRAME_H - DUET_BAR_PX;
  const topH = Math.max(2, Math.min(usable - 2, y - DUET_BAR_PX / 2));
  return clampDuetSplit((topH / usable) * 100);
}

const DUET_PIP_CORNERS = [
  { id: "tl", label: "Top left", x: 18, y: 11 },
  { id: "tr", label: "Top right", x: 82, y: 11 },
  { id: "bl", label: "Bottom left", x: 18, y: 89 },
  { id: "br", label: "Bottom right", x: 82, y: 89 },
];

const DUET_EMOJIS = [
  "😀", "😂", "🤣", "😍", "😘", "😎", "🤩", "🥳", "😇", "🤗",
  "😏", "😜", "🤪", "😭", "😡", "🔥", "❤️", "💕", "💯", "✨",
  "⭐", "🎉", "👏", "🙌", "👍", "🙏", "💪", "👀", "🎶", "🎵",
  "🎬", "📸", "🌈", "☀️", "🌙", "⚡", "💥", "🌸", "🌹", "🦋",
  "👑", "💎", "🏆", "🎯", "📌", "💬", "📍", "🇮🇳", "✌️", "🤝",
];

function duetFontFamily(id) {
  return (DUET_FONTS.find((f) => f.id === id) || DUET_FONTS[0]).family;
}

function defaultDuetOverlay() {
  return {
    text: "",
    textColor: "#ffffff",
    bgColor: "#111111",
    bgTransparent: false,
    fontSize: 28,
    font: "jakarta",
    x: 50,
    y: 50,
  };
}

async function renderDuetCaptionPng(overlay) {
  const text = overlay.text.trim();
  if (!text) return null;
  try {
    await document.fonts.ready;
  } catch {
    // continue with fallback fonts
  }
  const family = duetFontFamily(overlay.font);
  const size = Math.max(24, Math.round(overlay.fontSize * 1.05));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `800 ${size}px ${family}`;
  const width = ctx.measureText(text).width;
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.32);
  canvas.width = Math.max(8, Math.ceil(width + padX * 2));
  canvas.height = Math.max(8, Math.ceil(size * 1.4 + padY * 2));
  const draw = canvas.getContext("2d");
  draw.font = `800 ${size}px ${family}`;
  draw.textAlign = "center";
  draw.textBaseline = "middle";
  if (!overlay.bgTransparent) {
    draw.fillStyle = hexToRgba(overlay.bgColor, 0.88);
    const r = Math.max(6, Math.round(size * 0.22));
    const w = canvas.width;
    const h = canvas.height;
    draw.beginPath();
    draw.moveTo(r, 0);
    draw.arcTo(w, 0, w, h, r);
    draw.arcTo(w, h, 0, h, r);
    draw.arcTo(0, h, 0, 0, r);
    draw.arcTo(0, 0, w, 0, r);
    draw.closePath();
    draw.fill();
  }
  draw.fillStyle = overlay.textColor || "#ffffff";
  draw.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) return null;
  return new File([blob], "duet-caption.png", { type: "image/png" });
}

function DuetTextFields({ overlay, setOverlay, disabled }) {
  const inputRef = useRef(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  function patch(next) {
    setOverlay((prev) => ({ ...prev, ...next }));
  }

  function insertEmoji(emoji) {
    const el = inputRef.current;
    const value = overlay.text || "";
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${emoji}${value.slice(end)}`.slice(
      0,
      120
    );
    patch({ text: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = Math.min(next.length, start + emoji.length);
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="duet-text-tools">
      <div className="brand-field">
        <label className="field-label" htmlFor="duetOverlayText">
          On-video text
        </label>
        <div className="duet-text-input-row">
          <input
            ref={inputRef}
            id="duetOverlayText"
            className="brand-input"
            type="text"
            maxLength={120}
            placeholder="Type here, pick a font, add emoji, then drag"
            value={overlay.text}
            onChange={(e) => patch({ text: e.target.value })}
            disabled={disabled}
            style={{ fontFamily: duetFontFamily(overlay.font) }}
          />
          <button
            type="button"
            className={`btn btn-ghost duet-emoji-toggle${
              emojiOpen ? " duet-emoji-toggle--on" : ""
            }`}
            onClick={() => setEmojiOpen((v) => !v)}
            disabled={disabled}
            aria-expanded={emojiOpen}
            aria-label="Emoji picker"
          >
            😊
          </button>
        </div>
      </div>
      {emojiOpen && (
        <div className="duet-emoji-grid" role="listbox" aria-label="Emojis">
          {DUET_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="duet-emoji-btn"
              onClick={() => insertEmoji(emoji)}
              disabled={disabled}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <div className="cover-color-field">
        <span className="field-label">Font style</span>
        <div className="duet-font-grid" role="radiogroup" aria-label="Font style">
          {DUET_FONTS.map((font) => (
            <button
              key={font.id}
              type="button"
              className={`speed-btn duet-font-btn${
                overlay.font === font.id ? " speed-btn--active" : ""
              }`}
              style={{ fontFamily: font.family }}
              onClick={() => patch({ font: font.id })}
              disabled={disabled}
              role="radio"
              aria-checked={overlay.font === font.id}
            >
              {font.label}
            </button>
          ))}
        </div>
      </div>
      <div className="cover-style-row">
        <label className="cover-color-field">
          <span className="field-label">Text color</span>
          <span className="cover-color-picker">
            <input
              type="color"
              value={overlay.textColor}
              onChange={(e) => patch({ textColor: e.target.value })}
              disabled={disabled}
              aria-label="Text color"
            />
            <span className="cover-color-hex">{overlay.textColor}</span>
          </span>
        </label>
        <div className="cover-color-field">
          <span className="field-label">Background</span>
          <div className="cover-bg-tools">
            <span
              className={`cover-color-picker${
                overlay.bgTransparent ? " is-disabled" : ""
              }`}
            >
              <input
                type="color"
                value={overlay.bgColor}
                onChange={(e) =>
                  patch({ bgColor: e.target.value, bgTransparent: false })
                }
                disabled={disabled || overlay.bgTransparent}
                aria-label="Background color"
              />
              <span className="cover-color-hex">
                {overlay.bgTransparent ? "None" : overlay.bgColor}
              </span>
            </span>
            <button
              type="button"
              className={`speed-btn ${
                overlay.bgTransparent ? "speed-btn--active" : ""
              }`}
              onClick={() => patch({ bgTransparent: !overlay.bgTransparent })}
              disabled={disabled}
            >
              Transparent
            </button>
          </div>
        </div>
        <label className="cover-color-field">
          <span className="field-label">Font size · {overlay.fontSize}px</span>
          <input
            type="range"
            className="duet-font-range"
            min={16}
            max={72}
            step={1}
            value={overlay.fontSize}
            onChange={(e) => patch({ fontSize: Number(e.target.value) })}
            disabled={disabled}
            aria-label="Font size"
          />
        </label>
      </div>
    </div>
  );
}

function DuetTab() {
  const [top, setTop] = useState(null);
  const [bottom, setBottom] = useState(null);
  const [topAudio, setTopAudio] = useState(null);
  const [bottomAudio, setBottomAudio] = useState(null);
  const [muteTop, setMuteTop] = useState(false);
  const [muteBottom, setMuteBottom] = useState(false);
  const [overlay, setOverlay] = useState(defaultDuetOverlay);
  const [layout, setLayout] = useState("split");
  const [pipCorner, setPipCorner] = useState("br");
  const [pipX, setPipX] = useState(82);
  const [pipY, setPipY] = useState(89);
  const [splitTop, setSplitTop] = useState(50);
  const [topFit, setTopFit] = useState("contain");
  const [bottomFit, setBottomFit] = useState("contain");
  const [topPosY, setTopPosY] = useState(50);
  const [bottomPosY, setBottomPosY] = useState(50);
  const [topDragOver, setTopDragOver] = useState(false);
  const [bottomDragOver, setBottomDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const topInputRef = useRef(null);
  const bottomInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (top) URL.revokeObjectURL(top.url);
      if (bottom) URL.revokeObjectURL(bottom.url);
      if (topAudio) URL.revokeObjectURL(topAudio.url);
      if (bottomAudio) URL.revokeObjectURL(bottomAudio.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function markDirty() {
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
  }

  function replaceSlot(setter, current, file) {
    if (current) URL.revokeObjectURL(current.url);
    setter(fileToMediaItem(file));
    markDirty();
  }

  function setTopFromList(fileList) {
    const file = Array.from(fileList).find(isVideoFile);
    if (file) replaceSlot(setTop, top, file);
  }

  function setBottomFromList(fileList) {
    const file = Array.from(fileList).find(isVideoFile);
    if (file) replaceSlot(setBottom, bottom, file);
  }

  function setTopAudioFromList(fileList) {
    const file = Array.from(fileList).find(isAudioTrack);
    if (file) replaceSlot(setTopAudio, topAudio, file);
  }

  function setBottomAudioFromList(fileList) {
    const file = Array.from(fileList).find(isAudioTrack);
    if (file) replaceSlot(setBottomAudio, bottomAudio, file);
  }

  function clearSlot(which) {
    if (which === "top" && top) {
      URL.revokeObjectURL(top.url);
      setTop(null);
    }
    if (which === "bottom" && bottom) {
      URL.revokeObjectURL(bottom.url);
      setBottom(null);
    }
    if (which === "topAudio" && topAudio) {
      URL.revokeObjectURL(topAudio.url);
      setTopAudio(null);
    }
    if (which === "bottomAudio" && bottomAudio) {
      URL.revokeObjectURL(bottomAudio.url);
      setBottomAudio(null);
    }
    markDirty();
  }

  function swapClips() {
    if (!top && !bottom) return;
    setTop(bottom);
    setBottom(top);
    setTopAudio(bottomAudio);
    setBottomAudio(topAudio);
    setMuteTop(muteBottom);
    setMuteBottom(muteTop);
    setTopFit(bottomFit);
    setBottomFit(topFit);
    setTopPosY(bottomPosY);
    setBottomPosY(topPosY);
    markDirty();
  }

  async function handleCreate() {
    if (!top && !bottom) {
      setError("Upload at least one video.");
      return;
    }

    setError("");
    setDownloadUrl("");
    setCreating(true);
    setProgress(3);
    setStage("uploading");

    try {
      const form = new FormData();
      form.append("muteTop", muteTop ? "true" : "false");
      form.append("muteBottom", muteBottom ? "true" : "false");
      if (top) form.append("videoTop", top.file, top.file.name);
      if (bottom) form.append("videoBottom", bottom.file, bottom.file.name);
      if (top && topAudio && !muteTop) {
        form.append("audioTop", topAudio.file, topAudio.file.name);
      }
      if (bottom && bottomAudio && !muteBottom) {
        form.append("audioBottom", bottomAudio.file, bottomAudio.file.name);
      }
      form.append("overlayText", overlay.text);
      form.append("overlayTextColor", overlay.textColor);
      form.append("overlayBgColor", overlay.bgColor);
      form.append("overlayBgTransparent", overlay.bgTransparent ? "true" : "false");
      form.append("overlayFontSize", String(overlay.fontSize));
      form.append("overlayFont", overlay.font || "jakarta");
      form.append("overlayX", String(overlay.x));
      form.append("overlayY", String(overlay.y));
      form.append("layout", layout);
      form.append("pipX", String(pipX));
      form.append("pipY", String(pipY));
      form.append("splitTop", String(splitTop));
      const panes = duetSplitLayout(splitTop);
      form.append("topH", String(panes.topH));
      form.append("botH", String(panes.botH));
      form.append("topFit", topFit);
      form.append("bottomFit", bottomFit);
      form.append("topPosY", String(topPosY));
      form.append("bottomPosY", String(bottomPosY));
      const captionPng = await renderDuetCaptionPng(overlay);
      if (captionPng) form.append("overlayImage", captionPng, captionPng.name);

      const res = await fetch("/api/duet", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }

      const { jobId: id, downloadUrl: url } = await res.json();
      setProgress(10);
      setStage("stacking portrait duet");
      await pollStatus(id, { setProgress, setStage });

      setDownloadUrl(url);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      setError(err.message || "Something went wrong");
      setStage("");
    } finally {
      setCreating(false);
    }
  }

  const ready = Boolean(top || bottom);
  const splitMode = Boolean(top && bottom);
  const movePip = useCallback((x, y) => {
    setPipCorner("custom");
    setPipX(x);
    setPipY(y);
  }, []);

  const moveSplit = useCallback((value) => {
    setSplitTop(clampDuetSplit(value));
    setDownloadUrl("");
    setError("");
    setProgress(0);
    setStage("");
  }, []);

  return (
    <>
      <section className="workspace-section">
        <div className="split-intro">
          <h2 className="section-title">Portrait duet</h2>
          <p className="section-hint">
            One video fills the portrait screen. Add a second clip, then pick
            Split (drag the line for height). Fit full keeps a person inside
            their half — Fill crops to fill the box.
          </p>
        </div>

        <div className="music-upload-grid">
          <div className="music-upload-block">
            <h3 className="music-upload-label">1. Video one</h3>
            <Dropzone
              dragOver={topDragOver}
              setDragOver={setTopDragOver}
              onFiles={setTopFromList}
              multiple={false}
              subtitle="MP4, MOV, WebM · one clip fills the screen"
              disabled={creating}
              inputRef={topInputRef}
            />
            {top && (
              <DuetClipCard
                item={top}
                customAudio={topAudio}
                onCustomAudio={setTopAudioFromList}
                onClearCustom={() => clearSlot("topAudio")}
                onClear={() => clearSlot("top")}
                muted={muteTop}
                onToggleMute={() => setMuteTop((v) => !v)}
                fit={topFit}
                onFit={(next) => {
                  setTopFit(next);
                  markDirty();
                }}
                disabled={creating}
                label="Top"
              />
            )}
          </div>

          <div className="music-upload-block">
            <h3 className="music-upload-label">2. Video two — optional</h3>
            <Dropzone
              dragOver={bottomDragOver}
              setDragOver={setBottomDragOver}
              onFiles={setBottomFromList}
              multiple={false}
              subtitle="Optional · split (adjust height) or circle overlay"
              disabled={creating}
              inputRef={bottomInputRef}
            />
            {bottom && (
              <DuetClipCard
                item={bottom}
                customAudio={bottomAudio}
                onCustomAudio={setBottomAudioFromList}
                onClearCustom={() => clearSlot("bottomAudio")}
                onClear={() => clearSlot("bottom")}
                muted={muteBottom}
                onToggleMute={() => setMuteBottom((v) => !v)}
                fit={bottomFit}
                onFit={(next) => {
                  setBottomFit(next);
                  markDirty();
                }}
                disabled={creating}
                label="Bottom"
              />
            )}
          </div>
        </div>

        {(top || bottom) && (
          <div className="duet-swap-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={swapClips}
              disabled={creating || (!top && !bottom)}
            >
              Swap videos
            </button>
          </div>
        )}

        {splitMode && (
          <div className="duet-layout-tools">
            <span className="field-label">Layout</span>
            <div className="duet-font-grid" role="radiogroup" aria-label="Duet layout">
              {DUET_LAYOUTS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`speed-btn${
                    layout === opt.id ? " speed-btn--active" : ""
                  }`}
                  onClick={() => setLayout(opt.id)}
                  disabled={creating}
                  role="radio"
                  aria-checked={layout === opt.id}
                >
                  {opt.title}
                  <span className="duet-layout-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
            {layout === "circle" && (
              <>
                <span className="field-label">Circle position</span>
                <div
                  className="duet-font-grid"
                  role="radiogroup"
                  aria-label="Circle corner"
                >
                  {DUET_PIP_CORNERS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`speed-btn${
                        pipCorner === opt.id ? " speed-btn--active" : ""
                      }`}
                      onClick={() => {
                        setPipCorner(opt.id);
                        setPipX(opt.x);
                        setPipY(opt.y);
                      }}
                      disabled={creating}
                      role="radio"
                      aria-checked={pipCorner === opt.id}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="section-hint">
                  Or drag the circle on the player to place it anywhere.
                </p>
              </>
            )}
            {layout === "split" && (
              <>
                <span className="field-label">
                  Split height · top {Math.round(splitTop)}% · bottom{" "}
                  {Math.round(100 - splitTop)}%
                </span>
                <input
                  type="range"
                  className="duet-font-range"
                  min={DUET_SPLIT_MIN}
                  max={DUET_SPLIT_MAX}
                  step="1"
                  value={splitTop}
                  onChange={(e) => {
                    setSplitTop(clampDuetSplit(e.target.value));
                    markDirty();
                  }}
                  disabled={creating}
                  aria-label="Top video height"
                />
                <div className="duet-split-actions">
                  <button
                    type="button"
                    className="btn btn-ghost duet-mute-btn"
                    onClick={() => {
                      setSplitTop(50);
                      markDirty();
                    }}
                    disabled={creating || splitTop === 50}
                  >
                    Reset 50 / 50
                  </button>
                  <p className="section-hint">
                    Drag the middle line to set heights. Use Fit full on a
                    clip so the person stays inside that half.
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {(top || bottom) && (
        <section className="workspace-section">
          <h2 className="section-title">
            {splitMode ? "Duet player" : "Portrait player"}
          </h2>
          <p className="section-hint">
            {splitMode
              ? layout === "circle"
                ? "First clip fills the screen. Drag the circle or pick a corner."
                : "Drag the middle line for height. Fit full keeps the whole person visible. Fill + drag frames the face."
              : "One clip fills the screen. Add a second video to choose Split or Circle."}
          </p>
          <DuetPlayer
            top={top}
            bottom={bottom}
            topAudio={topAudio}
            bottomAudio={bottomAudio}
            muteTop={muteTop}
            muteBottom={muteBottom}
            onToggleMuteTop={() => setMuteTop((v) => !v)}
            onToggleMuteBottom={() => setMuteBottom((v) => !v)}
            overlay={overlay}
            setOverlay={setOverlay}
            textDisabled={creating}
            layout={layout}
            pipX={pipX}
            pipY={pipY}
            setPip={movePip}
            splitTop={splitTop}
            setSplitTop={moveSplit}
            topFit={topFit}
            bottomFit={bottomFit}
            topPosY={topPosY}
            bottomPosY={bottomPosY}
            setTopPosY={(value) => {
              setTopPosY(value);
              markDirty();
            }}
            setBottomPosY={(value) => {
              setBottomPosY(value);
              markDirty();
            }}
          />
          <DuetTextFields
            overlay={overlay}
            setOverlay={setOverlay}
            disabled={creating}
          />
        </section>
      )}

      <section className="workspace-section">
        <ProgressBlock
          active={creating}
          progress={progress}
          stage={stage}
          error={error}
        />

        <div
          className={`action-bar${
            creating || progress > 0 || error ? " action-bar--spaced" : ""
          }`}
        >
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || !ready}
            type="button"
          >
            {creating
              ? splitMode
                ? "Creating duet…"
                : "Creating video…"
              : splitMode
              ? "Create Duet"
              : "Create Video"}
          </button>

          {downloadUrl && !creating && (
            <a
              className="btn btn-success"
              href={downloadUrl}
              download="zyvom-duet-latest.mp4"
            >
              Download MP4
            </a>
          )}
        </div>
      </section>
    </>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path d="M8 6.5v11l9-5.5-9-5.5Z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path d="M7 6h3.4v12H7V6Zm6.6 0H17v12h-3.4V6Z" fill="currentColor" />
    </svg>
  );
}

function IconSoundOn() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M5 10v4h3.2L13 18V6L8.2 10H5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M16.2 9.2a3.4 3.4 0 0 1 0 5.6M18.4 7a6.2 6.2 0 0 1 0 10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSoundOff() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M5 10v4h3.2L13 18V6L8.2 10H5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M17 9.5 21 13.5M21 9.5 17 13.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function seekMedia(el, time, clipDur) {
  if (!el || !Number.isFinite(clipDur) || clipDur <= 0) return;
  const next = Math.min(Math.max(0, time), Math.max(0, clipDur - 0.04));
  try {
    el.currentTime = next;
  } catch {
    // ignore seek before metadata
  }
}

function DuetPanePlayer({
  item,
  customAudio,
  muted,
  onToggleMute,
  label,
  compact = false,
  paneStyle,
  fit = "cover",
  posY = 50,
  setPosY,
}) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const dragging = useRef(false);
  const frameDrag = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioDur, setAudioDur] = useState(0);

  function applyTime(time) {
    seekMedia(videoRef.current, time, duration);
    if (audioRef.current && audioDur > 0) {
      seekMedia(audioRef.current, time % audioDur, audioDur);
    }
  }

  function pauseClip() {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setPlaying(false);
  }

  async function playFrom(time) {
    applyTime(time);
    setCurrent(time);
    const tasks = [];
    if (videoRef.current && time < Math.max(0, duration - 0.05)) {
      tasks.push(videoRef.current.play());
    }
    if (audioRef.current && !muted) tasks.push(audioRef.current.play());
    await Promise.all(tasks.map((p) => p?.catch(() => {})));
    setPlaying(true);
  }

  function togglePlay() {
    if (playing) {
      pauseClip();
      return;
    }
    const startAt = duration > 0 && current >= duration - 0.05 ? 0 : current;
    playFrom(startAt);
  }

  useEffect(() => {
    pauseClip();
    setCurrent(0);
    setDuration(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = Boolean(customAudio) || muted;
    const audio = audioRef.current;
    if (audio) {
      audio.muted = muted;
      if (playing && !muted) audio.play().catch(() => {});
      if (muted) audio.pause();
    }
  }, [muted, customAudio, playing]);

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    const tick = () => {
      if (!dragging.current) {
        const t = Number(videoRef.current?.currentTime || 0);
        setCurrent(t);
        if (duration > 0 && t >= duration - 0.08) {
          applyTime(duration);
          setCurrent(duration);
          pauseClip();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  useEffect(() => {
    return () => {
      videoRef.current?.pause();
      audioRef.current?.pause();
    };
  }, []);

  function onFramePointerDown(e) {
    if (!setPosY || e.target.closest("button, input")) return;
    e.preventDefault();
    e.stopPropagation();
    frameDrag.current = {
      startY: e.clientY,
      posY,
      height: e.currentTarget.getBoundingClientRect().height || 1,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  useEffect(() => {
    function onMove(e) {
      if (!frameDrag.current || !setPosY) return;
      const { startY, posY: start, height } = frameDrag.current;
      const next = start - ((e.clientY - startY) / height) * 100;
      setPosY(Math.max(0, Math.min(100, next)));
    }
    function onUp() {
      frameDrag.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [setPosY]);

  if (!item) {
    return (
      <div
        className={`duet-pane${compact ? " duet-pane--pip" : ""}`}
        style={paneStyle}
      >
        <span className="duet-pane-empty">{label}</span>
      </div>
    );
  }

  return (
    <div
      className={`duet-pane${compact ? " duet-pane--pip" : ""}${
        setPosY ? " duet-pane--frame" : ""
      }`}
      style={paneStyle}
      onPointerDown={onFramePointerDown}
    >
      <video
        ref={videoRef}
        src={item.url}
        className="duet-pane-video"
        style={{
          objectFit: fit === "cover" ? "cover" : "contain",
          objectPosition: `center ${posY}%`,
        }}
        muted={Boolean(customAudio) || muted}
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />
      {customAudio && (
        <audio
          ref={audioRef}
          src={customAudio.url}
          preload="auto"
          onLoadedMetadata={(e) => setAudioDur(e.currentTarget.duration || 0)}
        />
      )}
      <button
        type="button"
        className={`duet-sound-btn${muted ? " duet-sound-btn--off" : ""}`}
        onClick={onToggleMute}
        aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
        title={muted ? "Sound off" : "Sound on"}
      >
        {muted ? <IconSoundOff /> : <IconSoundOn />}
      </button>
      <div className="duet-pane-controls">
        <button
          type="button"
          className="duet-play-btn"
          onClick={togglePlay}
          aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        {!compact && (
          <>
            <input
              type="range"
              className="duet-seek"
              min={0}
              max={duration || 0}
              step={0.05}
              value={Math.min(current, duration || 0)}
              disabled={!duration}
              onPointerDown={() => {
                dragging.current = true;
              }}
              onPointerUp={(e) => {
                dragging.current = false;
                const t = Number(e.currentTarget.value);
                if (playing) playFrom(t);
                else applyTime(t);
              }}
              onChange={(e) => {
                const t = Number(e.target.value);
                if (!Number.isFinite(t)) return;
                setCurrent(t);
                applyTime(t);
              }}
              aria-label={`${label} seek`}
            />
            <span className="duet-time">
              {formatDuration(current)} / {formatDuration(duration)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function DuetPlayer({
  top,
  bottom,
  topAudio,
  bottomAudio,
  muteTop,
  muteBottom,
  onToggleMuteTop,
  onToggleMuteBottom,
  overlay,
  setOverlay,
  textDisabled,
  layout = "split",
  pipX = 82,
  pipY = 89,
  setPip,
  splitTop = 50,
  setSplitTop,
  topFit = "contain",
  bottomFit = "contain",
  topPosY = 50,
  bottomPosY = 50,
  setTopPosY,
  setBottomPosY,
}) {
  const stageRef = useRef(null);
  const drag = useRef(null);
  const pipDrag = useRef(null);
  const splitDrag = useRef(null);

  function onCaptionPointerDown(e) {
    if (textDisabled || !overlay.text.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      x: overlay.x,
      y: overlay.y,
      rect: stage.getBoundingClientRect(),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onSplitPointerDown(e) {
    if (textDisabled || !setSplitTop) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    splitDrag.current = { rect: stage.getBoundingClientRect() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPipPointerDown(e) {
    if (textDisabled || !setPip) return;
    if (e.target.closest("button, input")) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    pipDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      x: pipX,
      y: pipY,
      rect: stage.getBoundingClientRect(),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  useEffect(() => {
    function onMove(e) {
      if (splitDrag.current && setSplitTop) {
        const { rect } = splitDrag.current;
        if (rect.height) {
          setSplitTop(splitTopFromStageY(e.clientY, rect));
        }
        return;
      }
      if (pipDrag.current && setPip) {
        const { startX, startY, x, y, rect } = pipDrag.current;
        if (rect.width && rect.height) {
          setPip(
            Math.max(10, Math.min(90, x + ((e.clientX - startX) / rect.width) * 100)),
            Math.max(8, Math.min(92, y + ((e.clientY - startY) / rect.height) * 100))
          );
        }
        return;
      }
      if (!drag.current) return;
      const { startX, startY, x, y, rect } = drag.current;
      if (!rect.width || !rect.height) return;
      const nextX = x + ((e.clientX - startX) / rect.width) * 100;
      const nextY = y + ((e.clientY - startY) / rect.height) * 100;
      setOverlay((prev) => ({
        ...prev,
        x: Math.max(4, Math.min(96, nextX)),
        y: Math.max(4, Math.min(96, nextY)),
      }));
    }
    function onUp() {
      drag.current = null;
      pipDrag.current = null;
      splitDrag.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [setOverlay, setPip, setSplitTop]);

  const caption = overlay.text.trim();
  const split = Boolean(top && bottom);
  const circle = split && layout === "circle";
  const solo = top || bottom;
  const soloTop = Boolean(top);
  const panes = duetSplitLayout(splitTop);

  return (
    <div className="duet-player">
      <div
        ref={stageRef}
        className={`duet-stage${
          split && !circle ? " duet-stage--split" : " duet-stage--solo"
        }`}
        aria-label={split ? "Portrait duet player" : "Portrait player"}
      >
        {circle ? (
          <>
            <DuetPanePlayer
              item={top}
              customAudio={topAudio}
              muted={muteTop}
              onToggleMute={onToggleMuteTop}
              label="Main clip"
            />
            <div
              className="duet-pip"
              style={{ left: `${pipX}%`, top: `${pipY}%` }}
              onPointerDown={onPipPointerDown}
            >
              <DuetPanePlayer
                item={bottom}
                customAudio={bottomAudio}
                muted={muteBottom}
                onToggleMute={onToggleMuteBottom}
                label="Circle clip"
                compact
              />
            </div>
          </>
        ) : split ? (
          <>
            <DuetPanePlayer
              item={top}
              customAudio={topAudio}
              muted={muteTop}
              onToggleMute={onToggleMuteTop}
              label="Top clip"
              paneStyle={{ height: `${panes.topPct}%`, flex: "none" }}
              fit={topFit}
              posY={topPosY}
              setPosY={setTopPosY}
            />
            <div
              className="duet-stage-bar"
              style={{ height: `${panes.barPct}%` }}
              onPointerDown={onSplitPointerDown}
              role="separator"
              aria-orientation="horizontal"
              aria-valuemin={DUET_SPLIT_MIN}
              aria-valuemax={DUET_SPLIT_MAX}
              aria-valuenow={Math.round(splitTop)}
              aria-label="Drag to set clip heights"
              title="Drag to set heights"
            />
            <DuetPanePlayer
              item={bottom}
              customAudio={bottomAudio}
              muted={muteBottom}
              onToggleMute={onToggleMuteBottom}
              label="Bottom clip"
              paneStyle={{ height: `${panes.botPct}%`, flex: "none" }}
              fit={bottomFit}
              posY={bottomPosY}
              setPosY={setBottomPosY}
            />
          </>
        ) : (
          <DuetPanePlayer
            item={solo}
            customAudio={soloTop ? topAudio : bottomAudio}
            muted={soloTop ? muteTop : muteBottom}
            onToggleMute={soloTop ? onToggleMuteTop : onToggleMuteBottom}
            label="Full clip"
          />
        )}
        {caption ? (
          <span
            className="duet-caption"
            style={{
              left: `${overlay.x}%`,
              top: `${overlay.y}%`,
              color: overlay.textColor,
              background: overlay.bgTransparent
                ? "transparent"
                : hexToRgba(overlay.bgColor, 0.88),
              fontSize: `${Math.max(10, Math.round((overlay.fontSize || 28) * 0.3))}px`,
              fontFamily: duetFontFamily(overlay.font),
            }}
            onPointerDown={onCaptionPointerDown}
            role="button"
            tabIndex={0}
            aria-label="Drag text to place it"
            title="Drag to place"
          >
            {caption}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DuetClipCard({
  item,
  customAudio,
  onCustomAudio,
  onClearCustom,
  onClear,
  muted,
  onToggleMute,
  fit = "contain",
  onFit,
  disabled,
  label,
}) {
  const audioInputRef = useRef(null);
  return (
    <div className="duet-clip-card">
      <video
        src={item.url}
        className="duet-clip-thumb"
        muted
        playsInline
        preload="metadata"
        onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
        onMouseLeave={(e) => {
          e.currentTarget.pause();
          e.currentTarget.currentTime = 0;
        }}
      />
      <div className="clip-info">
        <div className="clip-name" title={item.file.name}>
          {item.file.name}
        </div>
        <div className="clip-meta">
          {label} · {formatSize(item.file.size)}
          {muted ? " · sound off" : ""}
        </div>
      </div>
      <div className="clip-actions">
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          onClick={onClear}
          disabled={disabled}
          aria-label={`Remove ${label} video`}
          title="Remove"
        >
          <IconClose />
        </button>
      </div>
      <div className="duet-clip-sound">
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
          hidden
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files?.length) onCustomAudio(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={`btn btn-ghost duet-mute-btn${
            muted ? " duet-mute-btn--on" : ""
          }`}
          onClick={onToggleMute}
          disabled={disabled}
        >
          {muted ? "Restore sound" : "Remove sound"}
        </button>
        {onFit ? (
          <button
            type="button"
            className={`btn btn-ghost duet-mute-btn${
              fit === "contain" ? " duet-mute-btn--on" : ""
            }`}
            onClick={() => onFit(fit === "contain" ? "cover" : "contain")}
            disabled={disabled}
            title={
              fit === "contain"
                ? "Showing the full video inside this half"
                : "Filling this half — drag the video to frame the face"
            }
          >
            {fit === "contain" ? "Fit full" : "Fill half"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost duet-mute-btn"
          onClick={() => audioInputRef.current?.click()}
          disabled={disabled}
        >
          {customAudio ? "Change sound" : "Add custom sound"}
        </button>
        {customAudio ? (
          <>
            <span className="clip-meta" title={customAudio.file.name}>
              {customAudio.file.name}
            </span>
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              onClick={onClearCustom}
              disabled={disabled}
              aria-label={`Remove ${label} custom sound`}
              title="Remove custom sound"
            >
              <IconClose />
            </button>
          </>
        ) : (
          <span className="clip-meta">Optional · MP3 / M4A / WAV</span>
        )}
      </div>
    </div>
  );
}

function looksLikeVideoUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function DownloaderTab() {
  const [sourceUrl, setSourceUrl] = useState("");
  const [importInfo, setImportInfo] = useState(null);
  const [selectedQuality, setSelectedQuality] = useState("");
  const [fetchingQualities, setFetchingQualities] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [file, setFile] = useState(null);
  const [duration, setDuration] = useState(0);
  const [downloadHref, setDownloadHref] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const fetchGen = useRef(0);
  const jobGen = useRef(0);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!looksLikeVideoUrl(sourceUrl)) return undefined;
    const handle = window.setTimeout(() => {
      fetchQualities(sourceUrl.trim());
    }, 700);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  async function fetchQualities(url = sourceUrl.trim()) {
    if (!looksLikeVideoUrl(url)) {
      setError("Paste a YouTube, Instagram, Facebook, or LinkedIn video URL.");
      return;
    }
    const gen = ++fetchGen.current;
    setError("");
    setImportInfo(null);
    setSelectedQuality("");
    setFetchingQualities(true);
    try {
      const res = await fetch("/api/import/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (gen !== fetchGen.current) return;
      if (!res.ok) throw new Error(data.error || "Could not read this URL.");
      setImportInfo(data);
      setSelectedQuality(data.qualities?.[0]?.id || "");
    } catch (err) {
      if (gen !== fetchGen.current) return;
      setError(err.message || "Could not read qualities for this URL.");
    } finally {
      if (gen === fetchGen.current) setFetchingQualities(false);
    }
  }

  async function downloadSelectedQuality() {
    const quality = importInfo?.qualities?.find((q) => q.id === selectedQuality);
    if (!quality) {
      setError("Choose a quality first.");
      return;
    }
    const gen = ++jobGen.current;
    setError("");
    setWorking(true);
    setProgress(6);
    setStage("downloading");
    try {
      const res = await fetch("/api/import/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sourceUrl.trim(),
          selector: quality.selector,
          title: importInfo.title,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Download failed");
      const done = await pollStatus(data.jobId, { setProgress, setStage });
      if (gen !== jobGen.current) return;
      const fileRes = await fetch(done.downloadUrl || `/api/download/${data.jobId}`);
      if (!fileRes.ok) throw new Error("Could not fetch the downloaded video.");
      const blob = await fileRes.blob();
      const name = done.downloadName || `${quality.label}.mp4`;
      const videoFile = new File([blob], name, { type: "video/mp4" });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const nextUrl = URL.createObjectURL(videoFile);
      setFile(videoFile);
      setPreviewUrl(nextUrl);
      setDownloadHref(done.downloadUrl || nextUrl);
      setDownloadName(name);
      setDuration(0);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      if (gen !== jobGen.current) return;
      setError(err.message || "Download failed");
      setStage("");
    } finally {
      if (gen === jobGen.current) setWorking(false);
    }
  }

  function clearAll() {
    fetchGen.current += 1;
    jobGen.current += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSourceUrl("");
    setImportInfo(null);
    setSelectedQuality("");
    setFile(null);
    setPreviewUrl("");
    setDownloadHref("");
    setDownloadName("");
    setDuration(0);
    setError("");
    setProgress(0);
    setStage("");
    setWorking(false);
    setFetchingQualities(false);
  }

  const selected = importInfo?.qualities?.find((q) => q.id === selectedQuality);

  return (
    <>
      <section className="workspace-section">
        <div className="split-intro">
          <h2 className="section-title">Paste a video link</h2>
          <p className="section-hint">
            YouTube, Instagram, Facebook, LinkedIn, and most public video
            pages. Qualities load as soon as the URL looks valid.
          </p>
        </div>
        <div className="url-import">
          <label className="field-label" htmlFor="downloaderUrl">
            Video URL
          </label>
          <div className="url-import-row">
            <input
              id="downloaderUrl"
              className="brand-input"
              type="url"
              placeholder="https://youtube.com/…  or  instagram / facebook / linkedin"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") fetchQualities();
              }}
              disabled={working}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => fetchQualities()}
              disabled={working || fetchingQualities || !sourceUrl.trim()}
            >
              {fetchingQualities ? "Reading…" : "Read URL"}
            </button>
          </div>
        </div>
        <p className="section-hint">
          Supported in MP4: 2160p, 1440p, 1080p, 720p, 480p, 360p — plus a
          Recommended pick.
        </p>
      </section>

      {(fetchingQualities || importInfo || error) && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Quality</h2>
            {(importInfo || file) && (
              <button className="btn btn-ghost" onClick={clearAll} disabled={working}>
                Clear
              </button>
            )}
          </div>
          {importInfo && (
            <div className="dl-meta">
              {importInfo.thumbnail && (
                <img
                  src={importInfo.thumbnail}
                  alt=""
                  className="dl-thumb"
                />
              )}
              <div>
                <p className="quality-title">{importInfo.title}</p>
                {importInfo.duration > 0 && (
                  <p className="section-hint">
                    {formatDuration(importInfo.duration)}
                    {selected ? ` · ${selected.label} MP4` : ""}
                  </p>
                )}
              </div>
            </div>
          )}
          {importInfo && (
            <div className="quality-grid" role="radiogroup" aria-label="Download quality">
              {importInfo.qualities.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className={`quality-card${
                    selectedQuality === q.id ? " quality-card--active" : ""
                  }${q.recommended ? " quality-card--rec" : ""}`}
                  onClick={() => setSelectedQuality(q.id)}
                  disabled={working}
                >
                  {q.recommended && (
                    <span className="quality-kicker">Recommended</span>
                  )}
                  <span className="quality-label">{q.label}</span>
                  <span className="quality-meta">
                    {q.recommended
                      ? q.note || "MP4"
                      : `MP4${q.height ? ` · ${q.height}p` : ""}`}
                    {q.sizeLabel ? ` · ${q.sizeLabel}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          <ProgressBlock
            active={working || fetchingQualities}
            progress={fetchingQualities ? 12 : progress}
            stage={fetchingQualities ? "reading url" : stage}
            error={error}
          />
          {importInfo && (
            <div className="action-bar action-bar--spaced">
              <button
                type="button"
                className="btn btn-primary"
                onClick={downloadSelectedQuality}
                disabled={working || !selectedQuality}
              >
                {working
                  ? "Preparing video…"
                  : `Download ${selected?.label || "MP4"}`}
              </button>
            </div>
          )}
        </section>
      )}

      {file && previewUrl && (
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Preview</h2>
            <a
              className="btn btn-success"
              href={downloadHref || previewUrl}
              download={downloadName || file.name || "video.mp4"}
            >
              Save MP4
            </a>
          </div>
          <video
            src={previewUrl}
            className="split-preview"
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) =>
              setDuration(e.currentTarget.duration || 0)
            }
          />
          <div className="split-meta">
            <div className="clip-name" title={file.name}>
              {file.name}
            </div>
            <div className="clip-meta">
              {formatSize(file.size)}
              {duration > 0 && <> · {formatDuration(duration)}</>}
              {selected ? ` · ${selected.label} MP4` : " · MP4"}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function formatTranscriptClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return formatDuration(seconds);
}

function MemeTab() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [segments, setSegments] = useState([]);
  const language = "auto";
  const [detectedLanguage, setDetectedLanguage] = useState("");
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [importInfo, setImportInfo] = useState(null);
  const [selectedQuality, setSelectedQuality] = useState("");
  const [fetchingQualities, setFetchingQualities] = useState(false);
  const [importDownloadUrl, setImportDownloadUrl] = useState("");
  const [importDownloadName, setImportDownloadName] = useState("");
  const [category, setCategory] = useState("");
  const [moments, setMoments] = useState([]);
  const [finding, setFinding] = useState(false);
  const [splittingMoments, setSplittingMoments] = useState(false);
  const [clipsZipUrl, setClipsZipUrl] = useState("");
  const [splitClips, setSplitClips] = useState([]);
  const [playingClip, setPlayingClip] = useState(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const transcribeGen = useRef(0);
  const lastAnalyzeKey = useRef("");
  const categoryResults = useRef({});

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const timestampedText = segments
    .map((s) => `[${formatTranscriptClock(s.start)}] ${s.text}`)
    .join("\n");
  const displayText = showTimestamps && timestampedText ? timestampedText : transcript;

  function clearFile() {
    transcribeGen.current += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
    setDuration(0);
    setTranscript("");
    setSegments([]);
    setDetectedLanguage("");
    setError("");
    setProgress(0);
    setStage("");
    setCopied(false);
    setImportDownloadUrl("");
    setImportDownloadName("");
    setMoments([]);
    setClipsZipUrl("");
    setSplitClips([]);
    setPlayingClip(null);
    lastAnalyzeKey.current = "";
    categoryResults.current = {};
  }

  async function fetchQualities() {
    const url = sourceUrl.trim();
    if (!url) {
      setError("Paste a video URL first.");
      return;
    }
    setError("");
    setImportInfo(null);
    setSelectedQuality("");
    setImportDownloadUrl("");
    setFetchingQualities(true);
    try {
      const res = await fetch("/api/import/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not read this URL.");
      setImportInfo(data);
      setSelectedQuality(data.qualities?.[0]?.id || "");
    } catch (err) {
      setError(err.message || "Could not read qualities for this URL.");
    } finally {
      setFetchingQualities(false);
    }
  }

  async function downloadSelectedQuality() {
    const quality = importInfo?.qualities?.find((q) => q.id === selectedQuality);
    if (!quality) {
      setError("Choose a quality first.");
      return;
    }

    const gen = ++transcribeGen.current;
    setError("");
    setWorking(true);
    setProgress(6);
    setStage("downloading");
    setImportDownloadUrl("");

    try {
      const res = await fetch("/api/import/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sourceUrl.trim(),
          selector: quality.selector,
          title: importInfo.title,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Download failed");

      const done = await pollStatus(data.jobId, { setProgress, setStage });
      if (gen !== transcribeGen.current) return;

      const fileRes = await fetch(done.downloadUrl || `/api/download/${data.jobId}`);
      if (!fileRes.ok) throw new Error("Could not fetch the downloaded video.");
      const blob = await fileRes.blob();
      const name = done.downloadName || `${quality.label}.mp4`;
      const videoFile = new File([blob], name, { type: "video/mp4" });

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setFile(videoFile);
      setPreviewUrl(URL.createObjectURL(videoFile));
      setDuration(0);
      setTranscript("");
      setSegments([]);
      setImportDownloadUrl(done.downloadUrl || `/api/download/${data.jobId}`);
      setImportDownloadName(name);
      setMoments([]);
      setClipsZipUrl("");
      setSplitClips([]);
      setPlayingClip(null);
      lastAnalyzeKey.current = "";
      categoryResults.current = {};
      await startTranscribe(videoFile);
    } catch (err) {
      if (gen !== transcribeGen.current) return;
      setError(err.message || "Download failed");
      setStage("");
    } finally {
      if (gen === transcribeGen.current) setWorking(false);
    }
  }

  function addFile(fileList) {
    const video = Array.from(fileList).find(
      (f) => f.type.startsWith("video/") || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name)
    );
    if (!video) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(video);
    setFile(video);
    setPreviewUrl(url);
    setDuration(0);
    setTranscript("");
    setSegments([]);
    setDetectedLanguage("");
    setError("");
    setProgress(0);
    setStage("");
    setCopied(false);
    setMoments([]);
    setClipsZipUrl("");
    setSplitClips([]);
    setPlayingClip(null);
    lastAnalyzeKey.current = "";
    categoryResults.current = {};
    startTranscribe(video);
  }

  async function startTranscribe(videoFile = file) {
    if (!category) {
      setError("Choose a category first.");
      return;
    }
    if (!videoFile) {
      setError("Upload a video to transcribe.");
      return;
    }
    const gen = ++transcribeGen.current;
    setError("");
    setTranscript("");
    setSegments([]);
    setDetectedLanguage("");
    setWorking(true);
    setProgress(4);
    setStage("uploading");

    try {
      const url = sourceUrl.trim();
      if (url) {
        setStage("reading captions");
        setProgress(12);
        const capRes = await fetch("/api/import/transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, language }),
        });
        const capData = await capRes.json().catch(() => ({}));
        const capText = String(capData.transcript || "").trim();
        if (capRes.ok && capText) {
          if (gen !== transcribeGen.current) return;
          const segs = Array.isArray(capData.segments) ? capData.segments : [];
          setTranscript(capText);
          setSegments(segs);
          setDetectedLanguage(capData.language || "");
          const found = await findMoments({
            text: capText,
            segs,
            nextCategory: category,
          });
          if (gen !== transcribeGen.current) return;
          if (found?.length) await splitMoments(found, videoFile);
          return;
        }
      }

      const form = new FormData();
      form.append("video", videoFile, videoFile.name);
      form.append("language", language);

      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.error ||
            (res.status === 404
              ? "Transcript API is not running. Restart the backend (npm start)."
              : `Upload failed (${res.status})`)
        );
      }

      const { jobId } = await res.json();
      if (gen !== transcribeGen.current) return;
      setProgress(10);
      setStage("processing");
      const done = await pollStatus(jobId, { setProgress, setStage });
      if (gen !== transcribeGen.current) return;

      const text = String(done?.transcript || "").trim();
      const segs = Array.isArray(done?.segments) ? done.segments : [];
      setTranscript(text);
      setSegments(segs);
      setDetectedLanguage(done?.language || "");
      const found = await findMoments({
        text,
        segs,
        nextCategory: category,
      });
      if (gen !== transcribeGen.current) return;
      if (found?.length) await splitMoments(found, videoFile);
    } catch (err) {
      if (gen !== transcribeGen.current) return;
      setError(err.message || "Transcription failed");
      setStage("");
    } finally {
      if (gen === transcribeGen.current) setWorking(false);
    }
  }

  async function findMoments({
    text = transcript,
    segs = segments,
    dur = duration,
    nextCategory = category,
    force = false,
  } = {}) {
    if (!text.trim()) {
      setError("Transcribe the video first.");
      return;
    }
    if (finding) return;
    const analyzeKey = `v5::${nextCategory}::${text}`;
    const cached = categoryResults.current[nextCategory];
    if (!force && cached?.transcript === text && cached.moments?.length) {
      setMoments(cached.moments);
      if (cached.clips?.length) {
        setSplitClips(cached.clips);
        setClipsZipUrl(cached.zip || "");
      }
      lastAnalyzeKey.current = analyzeKey;
      return cached.moments;
    }
    if (!force && lastAnalyzeKey.current === analyzeKey && moments.length) {
      return moments;
    }
    setFinding(true);
    setError("");
    setClipsZipUrl("");
    setStage("finding moments");
    setProgress(20);
    try {
      let videoDur = Number(dur) || Number(videoRef.current?.duration) || 0;
      if (!videoDur && videoRef.current) {
        await new Promise((resolve) => {
          const video = videoRef.current;
          if (video?.duration > 1) {
            resolve();
            return;
          }
          const done = () => resolve();
          video?.addEventListener("loadedmetadata", done, { once: true });
          window.setTimeout(done, 2000);
        });
        videoDur = Number(videoRef.current?.duration) || 0;
      }
      const sampled = sampleMemeSegments(segs, nextCategory);
      const res = await fetch("/api/meme/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: text.slice(0, 8000),
          category: nextCategory,
          duration: videoDur,
          segments: sampled,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 413) {
        throw new Error("Transcript is too long to send. Try Transcribe again or a shorter clip.");
      }
      if (!res.ok) throw new Error(data.error || "Could not find moments.");
      lastAnalyzeKey.current = analyzeKey;
      const found = Array.isArray(data.moments) ? data.moments : [];
      categoryResults.current[nextCategory] = {
        transcript: text,
        moments: found,
        clips: [],
        zip: "",
      };
      setMoments(found);
      setStage("complete");
      setProgress(100);
      return found;
    } catch (err) {
      setError(err.message || "Could not find moments.");
      setMoments([]);
      return [];
    } finally {
      setFinding(false);
    }
  }

  async function splitMoments(nextMoments = moments, videoFile = file) {
    if (!videoFile || !nextMoments.length) {
      setError("Find moments first, then split.");
      return;
    }
    setSplittingMoments(true);
    setProgress(70);
    setStage("splitting clips");
    try {
      const form = new FormData();
      form.append("video", videoFile, videoFile.name);
      form.append("moments", JSON.stringify(nextMoments));
      const res = await fetch("/api/meme/split", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Split failed");
      const done = await pollStatus(data.jobId, { setProgress, setStage });
      const zip = done.downloadUrl || `/api/download/${data.jobId}`;
      const clips = Array.isArray(done.clips) ? done.clips : [];
      setClipsZipUrl(zip);
      setSplitClips(clips);
      const prev = categoryResults.current[category] || {};
      categoryResults.current[category] = {
        ...prev,
        moments: nextMoments,
        clips,
        zip,
      };
      setPlayingClip(null);
      setStage("complete");
      setProgress(100);
    } catch (err) {
      setError(err.message || "Split failed");
      setStage("");
    } finally {
      setSplittingMoments(false);
    }
  }

  async function copyTranscript() {
    if (!displayText) return;
    try {
      await navigator.clipboard.writeText(displayText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not copy. Select the text and copy manually.");
    }
  }

  async function chooseCategory(id) {
    setCategory(id);
    if (!file || !transcript) return;
    const cached = categoryResults.current[id];
    if (cached?.transcript === transcript && cached.clips?.length) {
      setMoments(cached.moments || []);
      setSplitClips(cached.clips);
      setClipsZipUrl(cached.zip || "");
      setPlayingClip(null);
      return;
    }
    setWorking(true);
    setError("");
    try {
      const found = await findMoments({
        text: transcript,
        segs: segments,
        nextCategory: id,
      });
      if (found?.length && !cached?.clips?.length) await splitMoments(found, file);
    } catch (err) {
      setError(err.message || "Could not find moments.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="meme-layout">
      <div className="meme-main">
      <section className="workspace-section">
        <div className="split-intro">
          <h2 className="section-title">1. Choose category</h2>
          <p className="section-hint">
            Sirf selected category ke scenes nikalte hain. Transcript ek
            baar banti hai, extra API calls nahi.
            {category === "song" && (
              <>
                {" "}
                Song category sirf sung gaane / picturized songs nikalegi —
                normal dialogue nahi.
              </>
            )}
          </p>
        </div>
        <div className="cover-modes" role="radiogroup" aria-label="Meme category">
          {MEME_CATEGORIES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`speed-btn ${category === opt.id ? "speed-btn--active" : ""}`}
              onClick={() => chooseCategory(opt.id)}
              disabled={working || finding}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {category && (
      <section className="workspace-section">
        <div className="split-intro">
          <h2 className="section-title">2. Upload video</h2>
          <p className="section-hint">
            Video upload ya URL se lao. Transcript automatic banega, phir
            OpenAI poori transcript dekh ke scenes split karega.
          </p>
        </div>
        <div className="url-import">
          <label className="field-label" htmlFor="memeSourceUrl">
            Video URL
          </label>
          <div className="url-import-row">
            <input
              id="memeSourceUrl"
              className="brand-input"
              type="url"
              placeholder="https://…"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              disabled={working || fetchingQualities}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={fetchQualities}
              disabled={working || fetchingQualities || !sourceUrl.trim()}
            >
              {fetchingQualities ? "Reading…" : "Get qualities"}
            </button>
          </div>
        </div>
        {importInfo && (
          <div className="quality-wrap">
            <div className="quality-head">
              <div>
                <p className="quality-title">{importInfo.title}</p>
                {importInfo.duration > 0 && (
                  <p className="section-hint">
                    {formatDuration(importInfo.duration)}
                  </p>
                )}
              </div>
            </div>
            <div className="quality-grid" role="radiogroup" aria-label="Download quality">
              {importInfo.qualities.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className={`quality-card${
                    selectedQuality === q.id ? " quality-card--active" : ""
                  }${q.recommended ? " quality-card--rec" : ""}`}
                  onClick={() => setSelectedQuality(q.id)}
                  disabled={working}
                >
                  {q.recommended && (
                    <span className="quality-kicker">Recommended</span>
                  )}
                  <span className="quality-label">{q.label}</span>
                  <span className="quality-meta">
                    {q.recommended
                      ? q.note || "MP4"
                      : `MP4${q.height ? ` · ${q.height}p` : ""}`}
                    {q.sizeLabel ? ` · ${q.sizeLabel}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <ProgressBlock
              active={working && !transcript}
              progress={progress}
              stage={stage}
              error=""
            />
            <div className="action-bar">
              <button
                type="button"
                className="btn btn-primary"
                onClick={downloadSelectedQuality}
                disabled={working || !selectedQuality}
              >
                {working && stage === "downloading"
                  ? "Downloading…"
                  : "Download selected quality"}
              </button>
              {importDownloadUrl && (
                <a
                  className="btn btn-success"
                  href={importDownloadUrl}
                  download={importDownloadName || "video.mp4"}
                >
                  Save MP4
                </a>
              )}
            </div>
          </div>
        )}
        <Dropzone
          dragOver={dragOver}
          setDragOver={setDragOver}
          onFiles={addFile}
          multiple={false}
          subtitle="MP4, MOV, WebM, MKV · max 2 GB"
          disabled={working}
          inputRef={fileInputRef}
        />
      </section>
      )}

      {file && (
        <video
          ref={videoRef}
          src={previewUrl}
          className="source-preview--closed"
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        />
      )}

      <section className="workspace-section">
        <div className="section-head">
          <h2 className="section-title">Transcript</h2>
          <div className="transcript-actions">
            {segments.length > 0 && (
              <button
                type="button"
                className={`speed-btn ${showTimestamps ? "speed-btn--active" : ""}`}
                onClick={() => setShowTimestamps((v) => !v)}
                disabled={!transcript}
              >
                Timestamps
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={copyTranscript}
              disabled={!displayText}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {file && (
              <button className="btn btn-ghost" onClick={clearFile} disabled={working}>
                Clear
              </button>
            )}
          </div>
        </div>

        <ProgressBlock
          active={working}
          progress={progress}
          stage={stage}
          error={error}
        />

        {displayText ? (
          <div className="transcript-panel">
            {(detectedLanguage || segments.length > 0) && (
              <div className="transcript-meta">
                {detectedLanguage && (
                  <span>Language · {detectedLanguage}</span>
                )}
                <span>{displayText.trim().split(/\s+/).length} words</span>
              </div>
            )}
            <textarea
              className="transcript-output"
              readOnly
              value={displayText}
              spellCheck={false}
            />
          </div>
        ) : (
          !working &&
          !error && (
            <p className="section-hint">
              Upload a video. Transcript and viral durations will appear here.
            </p>
          )
        )}

        <div
          className={`action-bar${
            working || progress > 0 || error ? " action-bar--spaced" : ""
          }`}
        >
          <button
            className="btn btn-primary"
            onClick={() => startTranscribe()}
            disabled={working || finding || !file}
          >
            {working && !finding ? "Transcribing…" : transcript ? "Transcribe again" : "Transcribe"}
          </button>
        </div>
      </section>

      </div>

      <aside className="meme-clips" aria-label="Split clips">
        <section className="workspace-section">
          <div className="section-head">
            <h2 className="section-title">Split clips</h2>
            {clipsZipUrl && (
              <a className="btn btn-ghost" href={clipsZipUrl} download="zyvom-meme-latest.zip">
                All ZIP
              </a>
            )}
          </div>
          {playingClip && (
            <video
              key={playingClip.downloadUrl}
              className="split-preview meme-clip-player"
              src={playingClip.downloadUrl}
              controls
              autoPlay
              playsInline
            />
          )}
          {splitClips.length > 0 ? (
            <div className="moment-list">
              {splitClips.map((clip) => (
                <div key={clip.downloadUrl} className="moment-card">
                  <div className="moment-copy">
                    <span className="moment-time">
                      {formatTranscriptClock(clip.start)} – {formatTranscriptClock(clip.end)}
                    </span>
                    <span className="moment-title">{clip.title}</span>
                  </div>
                  <div className="moment-actions">
                    <button
                      type="button"
                      className="moment-play"
                      onClick={() => setPlayingClip(clip)}
                    >
                      Play
                    </button>
                    <a
                      className="btn btn-success"
                      href={clip.downloadUrl}
                      download={clip.downloadName || "clip.mp4"}
                    >
                      Download
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="section-hint">
              {working
                ? "Clips yahin aayenge jab split complete hoga."
                : "Category choose karke video upload karo. Scenes automatic split ho ke yahin dikhenge."}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("merge");
  const [navOpen, setNavOpen] = useState(false);
  const current = TABS.find((t) => t.id === activeTab) || TABS[0];

  return (
    <div className={`app-shell${navOpen ? " app-shell--nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Studio navigation">
        <div className="sidebar-brand">
          <img
            className="brand-logo"
            src="/logo.svg"
            width="38"
            height="38"
            alt=""
          />
          <div className="brand-copy">
            <p className="brand-name">Reals Maker</p>
            <p className="brand-tagline">Studio</p>
          </div>
        </div>

        <p className="nav-label">Workspace</p>
        <nav className="side-nav" role="tablist" aria-label="Studio tools">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              className={`nav-item ${activeTab === tab.id ? "nav-item--active" : ""}`}
              onClick={() => {
                setActiveTab(tab.id);
                setNavOpen(false);
              }}
            >
              <span className="nav-item-icon">
                <NavIcon id={tab.id} />
              </span>
              <span className="nav-item-copy">
                <span className="nav-item-label">{tab.label}</span>
                <span className="nav-item-desc">{tab.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-status">
            <span className="status-dot" />
            Engine online
          </div>
          <p className="sidebar-meta">FFmpeg · Node · React</p>
        </div>
      </aside>

      {navOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="topbar-crumb">
            <span>Studio</span>
            <span className="crumb-sep">/</span>
            <span>{current.label}</span>
          </div>
          <div className="topbar-actions">
            <span className="header-badge">Enterprise</span>
            <span className="header-badge header-badge--live">FFmpeg live</span>
          </div>
        </header>

        <main className="workspace">
          <div className="page-hero">
            <p className="page-kicker">{current.kicker}</p>
            <h1 className="page-title">{current.title}</h1>
            <p className="page-desc">{current.desc}</p>
          </div>

          <div
            className="workspace-canvas"
            role="tabpanel"
            id={`panel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
          >
            {activeTab === "merge" ? (
              <MergeTab />
            ) : activeTab === "duet" ? (
              <DuetTab />
            ) : activeTab === "split" ? (
              <SplitTab />
            ) : activeTab === "music" ? (
              <MusicTab />
            ) : activeTab === "downloader" ? (
              <DownloaderTab />
            ) : (
              <MemeTab />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
