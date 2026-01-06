# File Upload Tool (Node.js)

A simple Node.js client–server setup for uploading large files over HTTP with:

- Streaming uploads (no buffering entire file in memory)
- Live CLI progress bar
- Upload speed estimation
- Estimated time remaining
- Binary-safe server receiver

---

## Requirements

- Node.js **18+**
- npm

Install dependencies:

```bash
npm install axios express
````

---

## Files Overview

### `upload.mjs`

CLI tool that uploads a file to a remote server using a streamed HTTP POST request.

Features:

* Reads destination URL from `config.json`
* Allows URL override via CLI flag
* Streams file data (low memory usage)
* Displays live progress bar with:

  * Percentage uploaded
  * Uploaded size / total size (MiB)
  * Upload speed (Mb/s and MiB/s)
  * Estimated completion time (HH:MM:SS)

---

### `server.mjs`

Express server that accepts a raw binary upload stream and writes it to disk.

Features:

* Accepts binary data via HTTP POST
* Requires `fileName` query parameter
* Saves uploaded files to local `output/` directory
* Rejects invalid requests with HTTP 400

---

## Usage

### 1️⃣ Start the server

```bash
node server.mjs
```

By default:

* Server listens on `http://localhost:3000`
* Upload endpoint:

  ```
  POST /upload?fileName=<your-file-name>
  ```
* Files are written to the `output/` directory

---

### 2️⃣ Configure upload destination (optional)

Create a `config.json` file:

```json
{
  "destination": "http://localhost:3000/upload"
}
```

If `config.json` is present, `upload.mjs` will use it automatically.

---

### 3️⃣ Upload a file

Basic usage:

```bash
node upload.mjs path/to/file.bin
```

Override destination URL explicitly:

```bash
node upload.mjs path/to/file.bin --url http://localhost:3000/upload
```

The uploader automatically appends the query parameter:

```
?fileName=<basename of file>
```

---

## Progress Display

During upload, the CLI displays:

```
[████████░░░░░░░░░░░░░░░░] [42.7%] [18.32 MiB/42.90 MiB]
[Upload: 84.12 Mb/s = 10.01 MiB/s]
[Estimated completion 00:00:03]
```

### Notes

* Upload speed is smoothed using an exponential moving average to avoid jitter
* Speeds are shown in both:

  * **Megabits per second (Mb/s)** — network convention
  * **Mebibytes per second (MiB/s)** — storage convention

---

## Error Handling

* Missing `fileName` query param → HTTP 400
* Invalid file path → client-side error
* Network or server failure → upload aborts with message
* Partial uploads are not committed silently

---

## Security Notes

* Server sanitizes `fileName` to prevent path traversal
* Only raw binary streams are accepted (no multipart parsing)

---

## License

MIT (or whatever you prefer)
