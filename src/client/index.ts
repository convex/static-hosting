import {
  httpActionGeneric,
  queryGeneric,
  type HttpRouter,
} from "convex/server";
import { v, type GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  cacheControlFor,
  decodeRequestPath,
  etagMatches,
  getSetupHtml,
  isHtmlContentType,
} from "../component/serving.js";
import {
  blobResponse,
  ifRangeMatches,
  resolveContentType,
} from "../mime/mime.js";

const deploymentInfoValidator = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  currentDeploymentId: v.string(),
  deployedAt: v.number(),
  spaFallback: v.optional(v.boolean()),
});

/**
 * Register app-owned HTTP routes for static hosting.
 *
 * Prefer mounting the component's own HTTP routes when it can own the URL
 * prefix. Use this compatibility mode when existing app HTTP routes must stay
 * at the same root. Exact app routes take precedence over this catch-all.
 * Assets and deployment state still live in the component.
 *
 * @example
 * ```typescript
 * // convex/convex.config.ts
 * const app = defineApp();
 * app.use(staticHosting); // no httpPrefix: the app owns HTTP routing
 *
 * // convex/http.ts
 * const http = httpRouter();
 * auth.addHttpRoutes(http);
 * registerStaticRoutes(http, components.staticHosting);
 * export default http;
 * ```
 */
export function registerStaticRoutes(
  http: HttpRouter,
  component: ComponentApi,
  {
    pathPrefix = "/",
    spaFallback,
    cdnBaseUrl,
  }: {
    /** URL prefix where the app should serve static files. */
    pathPrefix?: string;
    /** Override the deployment's SPA fallback setting. */
    spaFallback?: boolean;
    /** Optional custom base URL for convex-fs blob redirects. */
    cdnBaseUrl?: string | ((request: Request) => string);
  } = {},
) {
  if (!pathPrefix.startsWith("/")) {
    throw new Error("pathPrefix must start with /");
  }

  const normalizedPrefix =
    pathPrefix === "/" ? "" : pathPrefix.replace(/\/$/, "");

  const serveStaticFile = httpActionGeneric(async (ctx, request) => {
    const url = new URL(request.url);
    const decodedPath = decodeRequestPath(url.pathname);
    if (decodedPath === null) {
      return new Response("Bad Request", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
    let path = decodedPath;

    if (normalizedPrefix && path.startsWith(normalizedPrefix)) {
      path = path.slice(normalizedPrefix.length) || "/";
    }
    if (path === "" || path === "/") {
      path = "/index.html";
    }

    const asset = await ctx.runQuery(component.lib.resolveAssetForHttp, {
      path,
      ...(spaFallback === undefined ? {} : { spaFallback }),
    });

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
    const cacheControl = cacheControlFor(path);

    if (asset.blobId && !isHtmlContentType(contentType)) {
      const configuredBase =
        typeof cdnBaseUrl === "function" ? cdnBaseUrl(request) : cdnBaseUrl;
      const baseUrl = configuredBase ?? `${url.origin}/fs/blobs`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${baseUrl.replace(/\/$/, "")}/${asset.blobId}`,
          "Cache-Control": cacheControl,
        },
      });
    }

    // TODO(remove in a future major): v1→v2 transitional path. The file still
    // lives in the app's own storage (a same-name migration inherited the v1
    // row; see the component's resolveAssetForHttp). Serve it directly from app
    // storage so the site stays up during migration with no re-upload. Once v1
    // app-storage assets are no longer supported, delete this branch.
    if (asset.appStorageId) {
      if (
        asset.etag &&
        etagMatches(request.headers.get("If-None-Match"), asset.etag)
      ) {
        return new Response(null, {
          status: 304,
          headers: { ETag: asset.etag, "Cache-Control": cacheControl },
        });
      }
      const blob = await ctx.storage.get(
        asset.appStorageId as GenericId<"_storage">,
      );
      if (!blob) {
        // The component surfaces appStorageId whenever it can't resolve a
        // storage URL, which also covers a genuinely deleted file (the two are
        // indistinguishable from the component). If it isn't in app storage
        // either, degrade like an empty deployment rather than erroring.
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
      return blobResponse(
        blob,
        {
          "Content-Type": contentType,
          "Cache-Control": cacheControl,
          ...(asset.etag ? { ETag: asset.etag } : {}),
          "X-Content-Type-Options": "nosniff",
        },
        request.headers.get("Range"),
        request.headers.get("If-Range"),
      );
    }

    if (!asset.storageUrl) {
      return new Response("Asset not available", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (
      asset.etag &&
      etagMatches(request.headers.get("If-None-Match"), asset.etag)
    ) {
      return new Response(null, {
        status: 304,
        headers: { ETag: asset.etag, "Cache-Control": cacheControl },
      });
    }

    // Forward Range so audio/video can seek; the storage response's 206 and
    // range headers are passed through below. A stale If-Range drops Range so
    // storage returns the full representation.
    const rangeHeader = ifRangeMatches(
      request.headers.get("If-Range"),
      asset.etag,
    )
      ? request.headers.get("Range")
      : null;
    const storageResponse = await fetch(
      asset.storageUrl,
      rangeHeader ? { headers: { Range: rangeHeader } } : undefined,
    );
    if (storageResponse.status === 416) {
      const contentRange = storageResponse.headers.get("Content-Range");
      return new Response(null, {
        status: 416,
        headers: {
          "Cache-Control": cacheControl,
          "X-Content-Type-Options": "nosniff",
          ...(asset.etag ? { ETag: asset.etag } : {}),
          ...(contentRange ? { "Content-Range": contentRange } : {}),
        },
      });
    }
    if (!storageResponse.ok || !storageResponse.body) {
      return new Response("Storage error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const contentRange = storageResponse.headers.get("Content-Range");
    // Advertise bytes only when storage actually lists it, so "none" does not count.
    const storageAcceptsBytes = (storageResponse.headers.get("Accept-Ranges") ?? "")
      .split(",")
      .map((unit) => unit.trim().toLowerCase())
      .includes("bytes");
    const storageSupportsRanges =
      storageResponse.status === 206 || storageAcceptsBytes;
    return new Response(storageResponse.body, {
      status: storageResponse.status === 206 ? 206 : 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ...(asset.etag ? { ETag: asset.etag } : {}),
        "X-Content-Type-Options": "nosniff",
        ...(storageSupportsRanges ? { "Accept-Ranges": "bytes" } : {}),
        ...(contentRange ? { "Content-Range": contentRange } : {}),
      },
    });
  });

  http.route({
    pathPrefix: pathPrefix === "/" ? "/" : `${normalizedPrefix}/`,
    method: "GET",
    handler: serveStaticFile,
  });

  if (normalizedPrefix) {
    http.route({
      path: normalizedPrefix,
      method: "GET",
      handler: serveStaticFile,
    });
  }
}

/**
 * Expose a query that clients can subscribe to for live reload on deploy.
 * This is only needed if you use `UpdateBanner` / `useDeploymentUpdates` from
 * `@convex-dev/static-hosting/react`. If you don't surface deployment updates
 * in your app, you don't need to call this.
 *
 * @example
 * ```typescript
 * // convex/staticHosting.ts
 * import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
 * import { components } from "./_generated/api";
 *
 * export const { getCurrentDeployment } = exposeDeploymentQuery(
 *   components.staticHosting,
 * );
 * ```
 */
export function exposeDeploymentQuery(component: ComponentApi) {
  return {
    getCurrentDeployment: queryGeneric({
      args: {},
      returns: v.union(deploymentInfoValidator, v.null()),
      handler: async (ctx) => {
        const deployment = await ctx.runQuery(
          component.lib.getCurrentDeployment,
          {},
        );
        if (!deployment) return null;
        // Cleanup accounting is private component state. Returning it through
        // this public wrapper would fail the narrower response validator.
        const deploymentWithCleanup = deployment as typeof deployment & {
          pendingBlobCleanupCount?: number;
        };
        const { pendingBlobCleanupCount: _pending, ...publicDeployment } =
          deploymentWithCleanup;
        return publicDeployment;
      },
    }),
  };
}

/**
 * Derive the Convex cloud URL from a `.convex.site` hostname.
 * Useful when your frontend is served from Convex static hosting and needs
 * to connect to its own Convex backend without an explicit env var.
 *
 * @example
 * ```typescript
 * import { getConvexUrl } from "@convex-dev/static-hosting";
 *
 * const convexUrl = import.meta.env.VITE_CONVEX_URL ?? getConvexUrl();
 * const convex = new ConvexReactClient(convexUrl);
 * ```
 */
export function getConvexUrl(): string {
  if (typeof window === "undefined") {
    throw new Error("getConvexUrl() can only be called in a browser context");
  }
  if (window.location.hostname.endsWith(".convex.site")) {
    return `https://${window.location.hostname.replace(".convex.site", ".convex.cloud")}`;
  }
  throw new Error(
    "Unable to derive Convex URL. Please set VITE_CONVEX_URL environment variable.",
  );
}
