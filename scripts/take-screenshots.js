/**
 * Capture README screenshots of Reals Maker.
 *
 * Prereq: frontend at http://localhost:5173
 * Output: docs/screenshots/*.png
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const APP_URL = process.env.APP_URL || "http://localhost:5173";
const OUT_DIR = path.join(__dirname, "..", "docs", "screenshots");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function shoot(page, file) {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: true });
  console.log("  →", path.relative(process.cwd(), out));
}

async function openTab(page, label) {
  await page.locator(".nav-item", { hasText: label }).click();
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 920 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  console.log("Opening", APP_URL);
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".sidebar-brand");
  await page.waitForTimeout(400);

  console.log("1. Merge");
  await shoot(page, "01-merge.png");

  console.log("2. Split");
  await openTab(page, "Split Video");
  await shoot(page, "02-split.png");

  console.log("3. Music");
  await openTab(page, "Make Video with Music");
  await shoot(page, "03-music.png");

  console.log("4. Meme Finder");
  await openTab(page, "Meme Finder");
  await page.waitForTimeout(200);
  await shoot(page, "04-meme-finder.png");

  console.log("5. Downloader");
  await openTab(page, "Video Downloader");
  await shoot(page, "05-downloader.png");

  await browser.close();
  console.log("\nDone.", path.relative(process.cwd(), OUT_DIR));
})().catch((err) => {
  console.error("Screenshot script failed:", err);
  process.exit(1);
});
