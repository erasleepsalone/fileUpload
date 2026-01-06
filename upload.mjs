// upload.mjs
// Usage:
//   node upload.mjs <file_name>
//   node upload.mjs <file_name> --url <url>
//
// Reads ./config.json (expects { "destination": "http://host:port/upload" }) unless --url is provided.
// Uploads the file as a binary stream via Axios POST, attaching ?fileName=<basename> to the URL.
// Shows a live progress bar with percent, MiB progress, speed (Mb/s + MiB/s), and smooth ETA.
//
// Mintty/MSYS2 notes:
// - If the status line wraps, \r only returns to the last wrapped line, causing "new lines" each tick.
// - This version dynamically fits to terminal width and (optionally) disables auto-wrap while rendering.

import fs from "fs";
import path from "path";
import { Transform } from "stream";
import axios from "axios";

const BAR_WIDTH = 30;          // <-- max bar width (will shrink to fit terminal)
const TICK_MS = 100;           // UI refresh interval
const SPEED_ALPHA = 0.2;       // EMA smoothing factor (0..1). Higher = more responsive, more jitter.
const DISABLE_AUTOWRAP = true; // <-- helps a lot on terminals that support it (mintty does)

function printUsageAndExit(code = 1) {
  console.error(
    "Usage:\n" +
      "  node upload.mjs <file_name>\n" +
      "  node upload.mjs <file_name> --url <url>\n"
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let file = null;
  let url = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--url") {
      const next = args[i + 1];
      if (!next) {
        console.error("Error: --url requires a value");
        printUsageAndExit(1);
      }
      url = next;
      i++;
      continue;
    }

    if (a.startsWith("--")) {
      console.error(`Error: Unknown flag ${a}`);
      printUsageAndExit(1);
    }

    if (!file) file = a;
    else {
      console.error(`Error: Unexpected extra arg: ${a}`);
      printUsageAndExit(1);
    }
  }

  return { file, url };
}

async function readDestinationFromConfig() {
  const configPath = path.resolve(process.cwd(), "config.json");
  const raw = await fs.promises.readFile(configPath, "utf8");
  const json = JSON.parse(raw);

  if (!json || typeof json.destination !== "string" || !json.destination.trim()) {
    throw new Error('config.json must contain a non-empty string key "destination"');
  }
  return json.destination.trim();
}

function buildUploadUrl(baseUrl, fileName) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid destination URL: ${baseUrl}`);
  }
  u.searchParams.set("fileName", fileName);
  return u.toString();
}

function formatHMS(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const s = Math.floor(totalSeconds);

  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function makeBar(progress01, width) {
  const clamped = Math.max(0, Math.min(1, progress01));
  const filled = Math.round(clamped * width);
  const empty = width - filled;

  // If you want pure ASCII (safer for some fonts), swap these:
  // const filledChar = "#"; const emptyChar = "-";
  const filledChar = "█";
  const emptyChar = "░";

  return `[${filledChar.repeat(filled)}${emptyChar.repeat(empty)}]`;
}

// -------- Mintty-safe single-line renderer --------
let lastRenderedLen = 0;

function enableNoWrap() {
  if (!process.stdout.isTTY) return;
  if (!DISABLE_AUTOWRAP) return;
  // ESC[?7l disables line wrap (DECAWM). ESC[?7h re-enables.
  process.stdout.write("\x1b[?7l");
}

function restoreWrap() {
  if (!process.stdout.isTTY) return;
  if (!DISABLE_AUTOWRAP) return;
  process.stdout.write("\x1b[?7h");
}

function writeStatusLine(line) {
  if (!process.stdout.isTTY) {
    // Non-TTY: don't attempt in-place updates.
    console.log(line);
    return;
  }

  const cols = process.stdout.columns || 0;

  // Truncate to terminal width to avoid wrapping (the main cause of the mintty behavior)
  let out = line;
  if (cols > 0 && out.length > cols - 1) {
    out = out.slice(0, cols - 1);
  }

  // Clear line + return carriage, then write.
  // \x1b[2K clears the entire current line (xterm-compatible).
  // Pad to fully overwrite remnants from a longer previous render.
  const padLen = Math.max(0, lastRenderedLen - out.length);
  const padded = out + " ".repeat(padLen);

  process.stdout.write("\r\x1b[2K" + padded);
  lastRenderedLen = out.length;
}
// -----------------------------------------------

async function main() {
  const { file, url: urlOverride } = parseArgs(process.argv);
  if (!file) printUsageAndExit(1);

  const filePath = path.resolve(process.cwd(), file);
  const fileName = path.basename(filePath);

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    console.error(`Error: cannot access file "${file}": ${e.message}`);
    process.exit(1);
  }

  if (!stat.isFile()) {
    console.error(`Error: "${file}" is not a regular file`);
    process.exit(1);
  }

  const totalBytes = stat.size;

  let destination;
  if (urlOverride) {
    destination = urlOverride;
  } else {
    try {
      destination = await readDestinationFromConfig();
    } catch (e) {
      console.error(
        `Error: could not read destination from config.json (${e.message}).\n` +
          `Either create config.json with {"destination":"http://..."} or pass --url.`
      );
      process.exit(1);
    }
  }

  let uploadUrl;
  try {
    uploadUrl = buildUploadUrl(destination, fileName);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const readStream = fs.createReadStream(filePath);

  let uploadedBytes = 0;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      uploadedBytes += chunk.length;
      cb(null, chunk);
    },
  });

  // Smoothed speed estimate (bytes/sec)
  let lastBytes = 0;
  let lastTime = Date.now();
  let emaBytesPerSec = 0;

  const startTime = Date.now();

  enableNoWrap();

  const ticker = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;

    if (dt > 0) {
      const dBytes = uploadedBytes - lastBytes;
      const inst = dBytes / dt;

      if (emaBytesPerSec === 0) emaBytesPerSec = inst;
      else emaBytesPerSec = SPEED_ALPHA * inst + (1 - SPEED_ALPHA) * emaBytesPerSec;

      lastBytes = uploadedBytes;
      lastTime = now;
    }

    const progress01 = totalBytes > 0 ? uploadedBytes / totalBytes : 1;
    const percent = Math.min(100, Math.max(0, progress01 * 100)).toFixed(1);

    const mibDone = (uploadedBytes / (1024 * 1024)).toFixed(2);
    const mibTotal = (totalBytes / (1024 * 1024)).toFixed(2);

    const mibPerSec = emaBytesPerSec / (1024 * 1024);
    const mbps = (emaBytesPerSec * 8) / 1_000_000; // megabits/sec (decimal)

    const remainingBytes = Math.max(0, totalBytes - uploadedBytes);
    const etaSec = emaBytesPerSec > 1 ? remainingBytes / emaBytesPerSec : Infinity;

    const suffix =
      `[${percent}%] ` +
      `[${mibDone} MiB/${mibTotal} MiB] ` +
      `[Upload: ${mbps.toFixed(2)} Mb/s = ${mibPerSec.toFixed(2)} MiB/s] ` +
      `[Estimated completion ${formatHMS(etaSec)}]`;

    // Dynamically shrink bar to prevent wrapping
    const cols = process.stdout.isTTY ? (process.stdout.columns || 0) : 0;
    let barWidth = BAR_WIDTH;

    if (cols > 0) {
      // total line length = bar(2 + barWidth) + space(1) + suffix.length
      const maxBarWidth = cols - suffix.length - 3;
      barWidth = Math.max(5, Math.min(BAR_WIDTH, maxBarWidth));
    }

    const bar = makeBar(progress01, barWidth);
    writeStatusLine(`${bar} ${suffix}`);
  }, TICK_MS);

  const bodyStream = readStream.pipe(counter);

  try {
    await axios.post(uploadUrl, bodyStream, {
      headers: {
        "Content-Length": totalBytes,
        "Content-Type": "application/octet-stream",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    uploadedBytes = totalBytes;
  } catch (e) {
    clearInterval(ticker);
    restoreWrap();
    process.stdout.write("\n");

    if (e.response) {
      console.error(
        `Upload failed: HTTP ${e.response.status}\n` +
          (typeof e.response.data === "string" ? e.response.data : "")
      );
    } else {
      console.error(`Upload failed: ${e.message}`);
    }
    process.exit(1);
  } finally {
    clearInterval(ticker);
    restoreWrap();
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  process.stdout.write("\n");
  console.log(
    `Done. Uploaded "${fileName}" (${(totalBytes / (1024 * 1024)).toFixed(2)} MiB) in ${elapsedSec.toFixed(2)}s`
  );
}

main().catch((e) => {
  restoreWrap();
  console.error(`Fatal error: ${e?.message ?? e}`);
  process.exit(1);
});
