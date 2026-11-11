// Helpers shared by the HTTP handler (http.ts), the app-owned client routes
// and the asset-resolution query (lib.ts). Kept separate so lib.ts can reuse
// them without importing the HTTP router. MIME and Range helpers live in
// ../mime/mime.js and are imported from there directly.

import {
  ifRangeMatches,
  parseByteRange,
  unsatisfiableResponse,
} from "../mime/mime.js";

export function getSetupHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Convex Static Hosting</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 640px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #fafafa;
      color: #333;
      line-height: 1.6;
    }
    h1 { color: #111; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 32px; }
    code {
      background: #e8e8e8;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 14px;
    }
    pre {
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 14px;
    }
    .step { margin-bottom: 24px; }
    .step-num {
      display: inline-block;
      background: #333;
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      text-align: center;
      font-size: 14px;
      line-height: 24px;
      margin-right: 8px;
    }
    a { color: #0070f3; }
  </style>
</head>
<body>
  <h1>Almost there!</h1>
  <p class="subtitle">Your Convex backend is running, but no static files have been deployed yet.</p>

  <div class="step">
    <span class="step-num">1</span>
    <strong>Build your frontend</strong>
    <pre>npm run build</pre>
  </div>

  <div class="step">
    <span class="step-num">2</span>
    <strong>Deploy your static files</strong>
    <pre>npx @convex-dev/static-hosting deploy</pre>
  </div>

  <p>Or deploy everything in one command:</p>
  <pre>npm run deploy</pre>

  <p style="margin-top: 32px; color: #666; font-size: 14px;">
    Learn more at <a href="https://github.com/convex/static-hosting">github.com/convex/static-hosting</a>
  </p>
</body>
</html>`;
}

/**
 * An app-supplied not-found page. When it exists, a miss is answered with its
 * contents and status 404, instead of plain text.
 */
export const NOT_FOUND_PAGE_PATH = "/404.html";

export const NOT_FOUND_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=0, must-revalidate",
  "X-Content-Type-Options": "nosniff",
};

export function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() || "";
  return lastSegment.includes(".") && !lastSegment.startsWith(".");
}

// Bundler content-hash suffix: e.g. `index-lj_vq_aF.js`,
// `index-D3LP-ukt.js`, or `style-B71cUw87.css`. Requiring at least one
// non-letter avoids treating ordinary names such as `privacy-policy.html` as
// content-addressed assets.
export function isHashedAsset(path: string): boolean {
  const match = path.match(/[-.]([\dA-Za-z_-]{6,32})\.[A-Za-z\d]+$/);
  return match !== null && /[\d_-]/.test(match[1]);
}

export function isHtmlContentType(contentType: string): boolean {
  return contentType.startsWith("text/html");
}

export function cacheControlFor(path: string): string {
  return !path.toLowerCase().endsWith(".html") && isHashedAsset(path)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
}

/**
 * Decode the URL pathname before looking it up in the asset table. A malformed
 * escape sequence is a bad request, not a missing static asset.
 */
export function decodeRequestPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * If-None-Match uses weak comparison for GET and HEAD requests. Browsers and
 * proxies may send a weak validator or a comma-separated list of validators.
 */
export function etagMatches(
  ifNoneMatch: string | null,
  currentEtag: string,
): boolean {
  if (!ifNoneMatch) return false;

  const normalize = (value: string) => value.trim().replace(/^W\//, "").trim();
  const normalizedCurrent = normalize(currentEtag);

  return ifNoneMatch.split(",").some((candidate) => {
    const normalizedCandidate = normalize(candidate);
    return (
      normalizedCandidate === "*" || normalizedCandidate === normalizedCurrent
    );
  });
}

/**
 * Fetch a Convex storage URL and stream the result, so a Range request reads
 * only the requested bytes instead of buffering the whole file. `size` is the
 * stored file's byte length. `headers` are the full-response headers (type,
 * caching, ETag, ...).
 *
 * `rangeHeader` and `ifRange` are the raw request headers. A stale If-Range
 * (checked against `headers.ETag`, as blobResponse does) drops Range and serves
 * the full body. The range is resolved against `size` here. Storage answers suffix and
 * out-of-bounds ranges with a malformed 206 instead of 416, so only an explicit
 * satisfiable range is forwarded, and Content-Range is built locally. An
 * unknown `size` ignores Range and serves the full body.
 */
export async function streamStorageResponse(
  storageUrl: string,
  rangeHeader: string | null,
  ifRange: string | null,
  size: number | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const range =
    size === undefined || !ifRangeMatches(ifRange, headers.ETag)
      ? null
      : parseByteRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return unsatisfiableResponse(headers, size!);
  }

  const storageResponse = await fetch(
    storageUrl,
    range
      ? { headers: { Range: `bytes=${range.start}-${range.end}` } }
      : undefined,
  );
  if (!storageResponse.ok || !storageResponse.body) {
    return new Response("Storage error", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Serve 206 only when storage honored the explicit range we forwarded.
  if (range && storageResponse.status === 206) {
    return new Response(storageResponse.body, {
      status: 206,
      headers: {
        ...headers,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }
  // Advertise bytes only when storage lists it, so "none" does not count.
  const storageSupportsRanges = (
    storageResponse.headers.get("Accept-Ranges") ?? ""
  )
    .split(",")
    .map((unit) => unit.trim().toLowerCase())
    .includes("bytes");
  return new Response(storageResponse.body, {
    status: 200,
    headers: {
      ...headers,
      ...(storageSupportsRanges ? { "Accept-Ranges": "bytes" } : {}),
    },
  });
}
