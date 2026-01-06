// server.mjs
// Express server that accepts a binary stream and writes it to ./output/<fileName>
// fileName is required as a query param, otherwise 400.
//
// Example:
//   node server.mjs
//   node upload.mjs ./somefile.bin --url http://localhost:3000/upload

import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const outputDir = path.resolve(process.cwd(), "output");

function ensureOutputDir() {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
}

function safeBasename(name) {
  // Prevent path traversal / weird directory injection
  return path.basename(String(name));
}

app.post("/upload", (req, res) => {
  const rawName = req.query.fileName;
  if (!rawName || typeof rawName !== "string" || !rawName.trim()) {
    return res.status(400).send('Missing required query param "fileName"');
  }

  const fileName = safeBasename(rawName.trim());
  if (!fileName) {
    return res.status(400).send('Invalid "fileName"');
  }

  ensureOutputDir();
  const outPath = path.join(outputDir, fileName);

  const outStream = fs.createWriteStream(outPath, { flags: "w" });

  let wroteBytes = 0;

  req.on("data", (chunk) => {
    wroteBytes += chunk.length;
  });

  req.on("error", (err) => {
    outStream.destroy();
    console.error("Request stream error:", err);
    if (!res.headersSent) res.status(500).send("Upload stream error");
  });

  outStream.on("error", (err) => {
    console.error("File write error:", err);
    if (!res.headersSent) res.status(500).send("File write error");
    req.destroy();
  });

  outStream.on("finish", () => {
    res.status(200).json({
      ok: true,
      fileName,
      bytesWritten: wroteBytes,
      savedTo: `output/${fileName}`,
    });
  });

  // Pipe raw binary request body to disk
  req.pipe(outStream);
});

app.get("/", (_req, res) => {
  res.type("text").send("OK. POST binary data to /upload?fileName=yourfile.bin");
});

app.listen(PORT, () => {
  ensureOutputDir();
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Upload endpoint: POST http://localhost:${PORT}/upload?fileName=<name>`);
  console.log(`Saving files to: ${outputDir}`);
});
