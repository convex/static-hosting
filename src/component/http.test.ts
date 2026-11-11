/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { getMountPrefix } from "./http.js";
import {
  cacheControlFor,
  decodeRequestPath,
  etagMatches,
  hasFileExtension,
  isHashedAsset,
} from "./serving.js";
import {
  getMimeType,
  ifRangeMatches,
  parseByteRange,
  resolveContentType,
} from "../mime/mime.js";

async function storeAsset(
  t: ReturnType<typeof initConvexTest>,
  path: string,
  body: string,
  contentType: string,
  deploymentId = "deploy-1",
) {
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([body], { type: contentType }));
  });
  await t.mutation(internal.lib.recordAsset, {
    path,
    storageId,
    contentType,
    deploymentId,
  });
  return storageId;
}

describe("static file serving", () => {
  test("serves index.html at the root", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html><title>hi</title>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>hi</title>");
  });

  test("serves an exact asset with immutable caching for hashed files", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/assets/index-B71cUw87.js",
      "console.log(1)",
      "application/javascript; charset=utf-8",
    );

    const res = await t.fetch("/assets/index-B71cUw87.js", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("HTML is revalidated rather than cached immutably", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/", {});
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  test("returns 304 for weak or listed If-None-Match validators", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/assets/app-B71cUw87.js",
      "x",
      "application/javascript; charset=utf-8",
    );

    const first = await t.fetch("/assets/app-B71cUw87.js", {});
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();

    const second = await t.fetch("/assets/app-B71cUw87.js", {
      headers: { "If-None-Match": `"not-current", W/${etag}` },
    });
    expect(second.status).toBe(304);
  });

  test("decodes percent-encoded asset paths", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/docs/hello world.txt",
      "hello",
      "text/plain; charset=utf-8",
    );

    const res = await t.fetch("/docs/hello%20world.txt", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("returns 400 for malformed percent encoding", async () => {
    const t = initConvexTest();
    const res = await t.fetch("/bad%ZZpath", {});
    expect(res.status).toBe(400);
  });

  test("SPA fallback serves index.html for extension-less misses", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html><div id=root>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/dashboard/settings", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=root");
  });

  test("missing files with an extension 404 (no SPA fallback)", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/missing.js", {});
    expect(res.status).toBe(404);
  });

  test("shows the setup page when nothing is deployed", async () => {
    const t = initConvexTest();
    const res = await t.fetch("/", {});
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.text()).toContain("no static files have been deployed");
  });

  test("shows the setup page for an inherited or deleted index storage row", async () => {
    const t = initConvexTest();
    const storageId = await storeAsset(
      t,
      "/index.html",
      "legacy",
      "text/html; charset=utf-8",
    );
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });

    const res = await t.fetch("/", {});
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  test("extension-less misses 404 when SPA fallback is disabled", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );
    // Record the deployment with SPA fallback off (what `upload --no-spa` does).
    await t.mutation(internal.lib.commitDeployment, {
      currentDeploymentId: "deploy-1",
      spaFallback: false,
    });

    const res = await t.fetch("/dashboard", {});
    expect(res.status).toBe(404);
  });
});

/**
 * Stand-in for Convex storage at the URL returned by `getUrl`. It answers a
 * single byte range the way storage does, so the streaming path is exercised
 * without network access. It does not prove real storage behavior.
 */
function stubStorageFetch(body: string) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    const match = range?.match(/^bytes=(\d+)-(\d*)$/i);
    if (!match) return new Response(body, { status: 200 });
    const start = Number(match[1]);
    if (start >= body.length) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${body.length}` },
      });
    }
    const end =
      match[2] === ""
        ? body.length - 1
        : Math.min(Number(match[2]), body.length - 1);
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${body.length}` },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("media serving", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stored octet-stream mp3 is served as audio/mpeg with range support", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<html></html>",
      "text/html; charset=utf-8",
    );
    await storeAsset(t, "/ep1.mp3", "0123456789", "application/octet-stream");
    const storage = stubStorageFetch("0123456789");

    const full = await t.fetch("/ep1.mp3", {});
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(storage).not.toHaveBeenCalled();

    const part = await t.fetch("/ep1.mp3", { headers: { Range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    expect(storage).toHaveBeenCalledTimes(1);
    expect(storage.mock.calls[0]?.[1]).toMatchObject({
      headers: { Range: "bytes=2-4" },
    });

    const bad = await t.fetch("/ep1.mp3", { headers: { Range: "bytes=50-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */10");
    expect(bad.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
    expect(bad.headers.get("ETag")).toBeTruthy();
  });

  test("If-Range with a stale validator ignores Range and serves the full body", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep2.mp3", "0123456789", "application/octet-stream");
    const storage = stubStorageFetch("0123456789");

    const full = await t.fetch("/ep2.mp3", {});
    const etag = full.headers.get("ETag")!;

    const stale = await t.fetch("/ep2.mp3", {
      headers: { Range: "bytes=2-4", "If-Range": '"stale-validator"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789");
    expect(storage).not.toHaveBeenCalled();

    const current = await t.fetch("/ep2.mp3", {
      headers: { Range: "bytes=2-4", "If-Range": etag },
    });
    expect(current.status).toBe(206);
    expect(await current.text()).toBe("234");
    expect(storage).toHaveBeenCalledTimes(1);
  });

  test("Range unit names are case-insensitive", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep3.mp3", "0123456789", "application/octet-stream");
    stubStorageFetch("0123456789");

    const res = await t.fetch("/ep3.mp3", { headers: { Range: "Bytes=2-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
  });
});

describe("serving helpers", () => {
  test("getMimeType maps known extensions and defaults to octet-stream", () => {
    expect(getMimeType("/index.html")).toBe("text/html; charset=utf-8");
    expect(getMimeType("/a/b/style.css")).toBe("text/css; charset=utf-8");
    expect(getMimeType("/favicon.ico")).toBe("image/x-icon");
    expect(getMimeType("/data.unknownext")).toBe("application/octet-stream");
  });

  test("getMimeType covers audio and markdown", () => {
    expect(getMimeType("/ep1.mp3")).toBe("audio/mpeg");
    expect(getMimeType("/ep1.MP3")).toBe("audio/mpeg");
    expect(getMimeType("/ep1.md")).toBe("text/plain; charset=utf-8");
    expect(getMimeType("/v1.2/README")).toBe("application/octet-stream");
    expect(getMimeType("C:\\a.b\\file")).toBe("application/octet-stream");
  });

  test("resolveContentType re-derives a stored octet-stream", () => {
    expect(resolveContentType("application/octet-stream", "/a.mp3")).toBe(
      "audio/mpeg",
    );
    expect(resolveContentType("image/png", "/a.mp3")).toBe("image/png");
    expect(resolveContentType(undefined, "/a.mp3")).toBe("audio/mpeg");
  });

  test("parseByteRange handles ranges", () => {
    expect(parseByteRange(null, 10)).toBeNull();
    expect(parseByteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseByteRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange("bytes=20-", 10)).toBe("unsatisfiable");
  });

  test("parseByteRange accepts case-insensitive range unit names", () => {
    expect(parseByteRange("Bytes=0-1", 10)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange("BYTES=0-1", 10)).toEqual({ start: 0, end: 1 });
  });

  test("parseByteRange edge cases", () => {
    // Open-ended and oversized ends clamp to the body.
    expect(parseByteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=0-99999999999", 10)).toEqual({
      start: 0,
      end: 9,
    });
    // A suffix of zero bytes is unsatisfiable.
    expect(parseByteRange("bytes=-0", 10)).toBe("unsatisfiable");
    // Multiple ranges are not supported, so the header is ignored.
    expect(parseByteRange("bytes=0-1,3-4", 10)).toBeNull();
    // An inverted range is syntactically invalid. RFC 9110 §14.2 permits
    // rejecting it with 416, so that behavior is pinned here.
    expect(parseByteRange("bytes=5-2", 10)).toBe("unsatisfiable");
    // Any range against an empty body is unsatisfiable.
    expect(parseByteRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  test("dotfiles and extensionless names keep octet-stream", () => {
    expect(getMimeType(".html")).toBe("application/octet-stream");
    expect(getMimeType(".json")).toBe("application/octet-stream");
    expect(getMimeType("assets/.mp3")).toBe("application/octet-stream");
    expect(getMimeType("v1.2/README")).toBe("application/octet-stream");
    expect(getMimeType("dir/Index.HTML")).toBe("text/html; charset=utf-8");
  });

  test("hasFileExtension distinguishes routes from files", () => {
    expect(hasFileExtension("/index.html")).toBe(true);
    expect(hasFileExtension("/assets/app.js")).toBe(true);
    expect(hasFileExtension("/dashboard")).toBe(false);
    expect(hasFileExtension("/dashboard/settings")).toBe(false);
    // dotfiles aren't treated as having an extension
    expect(hasFileExtension("/.well-known")).toBe(false);
  });

  test("isHashedAsset detects bundler content hashes", () => {
    expect(isHashedAsset("/assets/index-lj_vq_aF.js")).toBe(true);
    expect(isHashedAsset("/assets/index-D3LP-ukt.js")).toBe(true);
    expect(isHashedAsset("/assets/style-B71cUw87.css")).toBe(true);
    expect(isHashedAsset("/assets/inter-B71cUw87.woff2")).toBe(true);
    expect(isHashedAsset("/index.html")).toBe(false);
    expect(isHashedAsset("/logo.svg")).toBe(false);
    expect(isHashedAsset("/privacy-policy.html")).toBe(false);
  });

  test("cacheControlFor is immutable only for hashed assets", () => {
    expect(cacheControlFor("/assets/index-B71cUw87.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("/index.html")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(cacheControlFor("/page-B71cUw87.html")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  test("decodeRequestPath handles encoded and malformed paths", () => {
    expect(decodeRequestPath("/hello%20world.txt")).toBe("/hello world.txt");
    expect(decodeRequestPath("/bad%ZZpath")).toBeNull();
  });

  test("etagMatches supports weak tags, lists, and wildcard validators", () => {
    expect(etagMatches('W/"asset-1"', '"asset-1"')).toBe(true);
    expect(etagMatches('"other", W/"asset-1"', '"asset-1"')).toBe(true);
    expect(etagMatches("*", '"asset-1"')).toBe(true);
    expect(etagMatches('"other"', '"asset-1"')).toBe(false);
  });

  describe("getMountPrefix", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("is empty when mounted at the root", () => {
      vi.stubEnv("CONVEX_SITE_URL", "https://x.convex.site");
      expect(getMountPrefix()).toBe("");
      vi.stubEnv("CONVEX_SITE_URL", "https://x.convex.site/");
      expect(getMountPrefix()).toBe("");
    });

    test("strips a trailing slash from a sub-path mount", () => {
      vi.stubEnv("CONVEX_SITE_URL", "https://x.convex.site/app");
      expect(getMountPrefix()).toBe("/app");
      vi.stubEnv("CONVEX_SITE_URL", "https://x.convex.site/app/");
      expect(getMountPrefix()).toBe("/app");
    });
  });
});
describe("app 404 page", () => {
  test("a miss with an app 404 page is answered with that page and status 404", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );
    await storeAsset(
      t,
      "/404.html",
      "<h1>Gone</h1>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/missing.js", {});
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe("<h1>Gone</h1>");
  });

  test("SPA fallback still serves index.html for an extension-less miss", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );
    await storeAsset(
      t,
      "/404.html",
      "<h1>Gone</h1>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/dashboard", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html>");
  });

  test("with SPA fallback off, an extension-less miss gets the app 404 page", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );
    await storeAsset(
      t,
      "/404.html",
      "<h1>Gone</h1>",
      "text/html; charset=utf-8",
    );
    await t.mutation(internal.lib.commitDeployment, {
      currentDeploymentId: "deploy-1",
      spaFallback: false,
    });

    const res = await t.fetch("/dashboard", {});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Gone</h1>");
  });

  test("without an app 404 page, a miss keeps the plain-text 404", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );

    const res = await t.fetch("/missing.js", {});
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("Not Found");
  });
});

describe("app 404 page fallbacks", () => {
  test("a 404 page stored as a blob without a storage ID falls back to plain text", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<!doctype html>",
      "text/html; charset=utf-8",
    );
    await t.mutation(internal.lib.recordAsset, {
      path: "/404.html",
      blobId: "blob-404",
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-1",
    });

    const res = await t.fetch("/missing.js", {});
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("Not Found");
  });
});

describe("range header edge cases", () => {
  test("parseByteRange ignores empty specs and non-bytes units", () => {
    expect(parseByteRange("bytes=-", 10)).toBeNull();
    expect(parseByteRange("bytes=", 10)).toBeNull();
    expect(parseByteRange("items=0-1", 10)).toBeNull();
  });

  test("ifRangeMatches requires a strong, present, matching validator", () => {
    expect(ifRangeMatches(null, '"e"')).toBe(true);
    expect(ifRangeMatches('"e"', '"e"')).toBe(true);
    expect(ifRangeMatches('W/"e"', '"e"')).toBe(false);
    expect(ifRangeMatches("Wed, 21 Oct 2015 07:28:00 GMT", '"e"')).toBe(false);
    expect(ifRangeMatches('"e"', undefined)).toBe(false);
  });
});

describe("Range resolution in the component handler", () => {
  test("a suffix Range is resolved against the size and forwarded as an explicit range", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep5.mp3", "0123456789", "application/octet-stream");
    const storage = stubStorageFetch("0123456789");

    const res = await t.fetch("/ep5.mp3", { headers: { Range: "bytes=-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
    expect(storage.mock.calls[0]?.[1]).toMatchObject({
      headers: { Range: "bytes=7-9" },
    });
  });

  test("an out-of-bounds Range is answered with 416 without reading storage", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep6.mp3", "0123456789", "application/octet-stream");
    const storage = stubStorageFetch("0123456789");

    const res = await t.fetch("/ep6.mp3", { headers: { Range: "bytes=50-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(storage).not.toHaveBeenCalled();
  });
});

describe("416 caching", () => {
  test("an unsatisfiable Range on a hashed asset is never cached as immutable", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/assets/index-B71cUw87.js", "console.log(1)", "application/javascript; charset=utf-8");

    const res = await t.fetch("/assets/index-B71cUw87.js", { headers: { Range: "bytes=100-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
