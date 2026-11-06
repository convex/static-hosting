import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import {
  cacheControlFor,
  decodeRequestPath,
  etagMatches,
  getSetupHtml,
  blobResponse,
  resolveContentType,
  isHtmlContentType,
} from "./serving.js";

// CONVEX_SITE_URL reflects the component's mount point (including any httpPrefix).
// We use it to strip the prefix from incoming request paths so lookups in
// the asset table remain relative to the component (e.g. `/index.html`).
export function getMountPrefix(): string {
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) return "";
  try {
    const pathname = decodeRequestPath(new URL(siteUrl).pathname);
    if (pathname === null) return "";
    return pathname === "/" ? "" : pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const serveStaticFile = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const decodedPath = decodeRequestPath(url.pathname);
  if (decodedPath === null) {
    return new Response("Bad Request", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  let path = decodedPath;

  const mountPrefix = getMountPrefix();
  if (mountPrefix && path.startsWith(mountPrefix)) {
    path = path.slice(mountPrefix.length) || "/";
  }

  if (path === "" || path === "/") {
    path = "/index.html";
  }

  // One query resolves the asset: an exact match, or, when SPA fallback is
  // enabled for the current deployment, the index.html asset for an
  // extension-less miss. The fallback lookup happens inside the query so the
  // HTTP action never makes a second round-trip.
  const asset = await ctx.runQuery(internal.lib.resolveAsset, { path });

  if (!asset) {
    if (path === "/index.html") {
      return new Response(getSetupHtml(), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      });
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const contentType = resolveContentType(asset.contentType, path);

  // CDN redirect: blobs are served by the platform at /fs/blobs/{id}, which
  // lives at the deployment root (not under the component's prefix).
  if (asset.blobId && !isHtmlContentType(contentType)) {
    const redirectUrl = `${url.origin}/fs/blobs/${asset.blobId}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
        "Cache-Control": cacheControlFor(path),
      },
    });
  }

  if (!asset.storageId) {
    return new Response("Asset not available", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const etag = `"${asset.storageId}"`;
  const ifNoneMatch = request.headers.get("If-None-Match");
  const cacheControl = cacheControlFor(path);

  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  const blob = await ctx.storage.get(asset.storageId);
  if (!blob) {
    // A same-name v1 to v2 migration can temporarily inherit an index row that
    // points at app-owned storage. Treat that interval like an empty component
    // rather than returning a misleading permanent storage error.
    if (asset.path === "/index.html") {
      return new Response(getSetupHtml(), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      });
    }
    return new Response("Storage error", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return blobResponse(
    blob,
    {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
    request.headers.get("Range"),
  );
});

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: serveStaticFile,
});

export default http;
