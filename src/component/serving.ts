// Pure, dependency-free helpers shared by the HTTP handler (http.ts) and the
// asset-resolution query (lib.ts). Kept separate so lib.ts can reuse them
// without importing the HTTP router.

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
};

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

export function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

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
