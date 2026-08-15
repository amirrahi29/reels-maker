/**
 * Generate two small portrait demo clips used as fixtures by the screenshot
 * script. Reuses the FFmpeg binary already installed in `backend`.
 */
const path = require("path");
const fs = require("fs");

const ffmpeg = require(path.join(
  __dirname,
  "..",
  "backend",
  "node_modules",
  "fluent-ffmpeg"
));
const ffmpegPath = require(path.join(
  __dirname,
  "..",
  "backend",
  "node_modules",
  "ffmpeg-static"
));
ffmpeg.setFfmpegPath(ffmpegPath);

const OUT_DIR = path.join(__dirname, "sample-clips");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function make(name, colour) {
  const out = path.join(OUT_DIR, name);
  return new Promise((res, rej) => {
    ffmpeg()
      .input(`color=c=${colour}:s=720x1280:d=2:r=30`)
      .inputFormat("lavfi")
      .input("sine=frequency=440:duration=2")
      .inputFormat("lavfi")
      .complexFilter([
        // Fake red watermark in bottom-right corner
        "[0:v]drawbox=x=600:y=1210:w=100:h=50:color=red@0.85:t=fill[v]",
      ])
      .outputOptions([
        "-map [v]",
        "-map 1:a",
        "-c:v libx264",
        "-preset veryfast",
        "-c:a aac",
        "-pix_fmt yuv420p",
        "-shortest",
      ])
      .on("error", rej)
      .on("end", () => res(out))
      .save(out);
  });
}

(async () => {
  await make("clip-01.mp4", "darkblue");
  await make("clip-02.mp4", "darkgreen");
  await make("clip-03.mp4", "indigo");
  console.log("Sample clips written to", OUT_DIR);
})();
