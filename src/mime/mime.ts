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
