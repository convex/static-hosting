// MIME helpers shared by the upload CLI, the component HTTP handler and the
// app-owned client routes. Keep this file dependency-free.

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

const OCTET_STREAM = "application/octet-stream";

export function getMimeType(path: string): string {
  const segment = path.split(/[\\/]/).pop() || "";
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return OCTET_STREAM;
  return MIME_TYPES[segment.slice(dot).toLowerCase()] || OCTET_STREAM;
}

/**
 * Prefer the stored content type, but treat a stored octet-stream as unknown
 * so assets uploaded before a type was supported are corrected on serve.
 */
export function resolveContentType(
  stored: string | undefined | null,
  path: string,
): string {
  return stored && stored !== OCTET_STREAM ? stored : getMimeType(path);
}

/**
 * Parse a single-range `Range: bytes=...` header against a body of `size`
 * bytes. Returns null when the header is absent or not a single byte range
 * (serve the full body), "unsatisfiable" for a 416, or the inclusive range.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Build the response for an in-memory blob, honoring a single `Range`
 * request: 206 for a satisfiable range, 416 otherwise, 200 with no range.
 * `headers` are the full-response headers (type, caching, ETag, ...).
 */
export function blobResponse(
  blob: Blob,
  headers: Record<string, string>,
  rangeHeader: string | null,
): Response {
  const range = parseByteRange(rangeHeader, blob.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` },
    });
  }
  const base = { ...headers, "Accept-Ranges": "bytes" };
  if (range) {
    return new Response(blob.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${range.start}-${range.end}/${blob.size}`,
      },
    });
  }
  return new Response(blob, { status: 200, headers: base });
}
