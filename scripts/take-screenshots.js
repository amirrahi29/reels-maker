/**
 * Capture screenshots of the running frontend for README documentation.
 *
 * Prereq:
 *   - Frontend dev server running at http://localhost:5173 (cd frontend && npm run dev)
 *   - `npm install` already run inside `scripts/`
 *   - Sample clips generated:  `node make-sample-clips.js`
 *
 * Output: docs/screenshots/*.png
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const APP_URL = process.env.APP_URL || "http://localhost:5173";
const OUT_DIR = path.join(__dirname, "..", "docs", "screenshots");
const SAMPLE_DIR = path.join(__dirname, "sample-clips");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function ensureClipsReady(page) {
  await page.waitForSelector(".clips .clip", { timeout: 5000 });
  // Give video elements a moment to load metadata so thumbnails render.
  await page.waitForFunction(() => {
    const vids = document.querySelectorAll(".clip-thumb");
    return (
      vids.length > 0 &&
      Array.from(vids).every((v) => v.readyState >= 1) // HAVE_METADATA
    );
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function shoot(page, file) {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: true });
  console.log("  →", path.relative(process.cwd(), out));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2, // crisp retina-quality PNGs
  });
  const page = await ctx.newPage();

  console.log("Opening", APP_URL);
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".dropzone");
  await page.waitForTimeout(300);

  console.log("1. Empty state (landing)");
  await shoot(page, "01-empty-state.png");

  console.log("2. With clips loaded + watermark options visible");
  const input = page.locator(".dropzone input[type=file]");
  await input.setInputFiles([
    path.join(SAMPLE_DIR, "clip-01.mp4"),
    path.join(SAMPLE_DIR, "clip-02.mp4"),
    path.join(SAMPLE_DIR, "clip-03.mp4"),
  ]);
  await ensureClipsReady(page);
  await shoot(page, "02-with-clips.png");

  console.log("3. Portrait layout selected");
  await page.locator(".layout-card", { hasText: "Portrait" }).click();
  await page.waitForTimeout(150);
  await shoot(page, "03-layout-portrait.png");

  console.log("4. Watermark toggle off (showing layout-only mode)");
  await page.locator(".toggle").click();
  await page.waitForTimeout(150);
  await page.locator(".layout-card", { hasText: "Auto" }).click();
  await page.waitForTimeout(150);
  await shoot(page, "04-watermark-off.png");

  await browser.close();
  console.log("\nDone. Files written to", path.relative(process.cwd(), OUT_DIR));
})().catch((err) => {
  console.error("Screenshot script failed:", err);
  process.exit(1);
});
