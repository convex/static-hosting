import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import {
  cacheControlFor,
  decodeRequestPath,
  etagMatches,
  getSetupHtml,
  isHtmlContentType,
  NOT_FOUND_PAGE_HEADERS,
  NOT_FOUND_PAGE_PATH,
  streamStorageResponse,
} from "./serving.js";
import {
  blobResponse,
  ifRangeMatches,
  resolveContentType,
} from "../mime/mime.js";

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
  // extension-less miss. The fallback lookup happens inside the query, so a
  // hit costs a single round-trip. Only a miss makes a second query, for the
  // app's 404.html.
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
    const notFoundPage = await ctx.runQuery(internal.lib.resolveAsset, {
      path: NOT_FOUND_PAGE_PATH,
    });
    const notFoundBlob = notFoundPage?.storageId
      ? await ctx.storage.get(notFoundPage.storageId)
      : null;
    if (notFoundBlob) {
      return new Response(notFoundBlob, {
        status: 404,
        headers: NOT_FOUND_PAGE_HEADERS,
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

  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };

  // A Range request streams from the storage URL so a seek reads only the
  // requested bytes. Full responses still load the blob. A stale If-Range
  // drops Range, which the blob path then serves as a full 200.
  const rangeHeader = ifRangeMatches(request.headers.get("If-Range"), etag)
    ? request.headers.get("Range")
    : null;
  if (rangeHeader) {
    const storageUrl = await ctx.storage.getUrl(asset.storageId);
    const size = await ctx.runQuery(internal.lib.getStorageSize, {
      storageId: asset.storageId,
    });
    if (storageUrl && size !== null) {
      return streamStorageResponse(storageUrl, rangeHeader, size, headers);
    }
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
    headers,
    request.headers.get("Range"),
    request.headers.get("If-Range"),
  );
});

const http = httpRouter();

http.route({
  pathPrefix: "/",
  method: "GET",
  handler: serveStaticFile,
});

export default http;
