/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { getMountPrefix } from "./http.js";
import {
  cacheControlFor,
  decodeRequestPath,
  etagMatches,
  getMimeType,
  hasFileExtension,
  isHashedAsset,
} from "./serving.js";

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

describe("media serving", () => {
  test("stored octet-stream mp3 is served as audio/mpeg with range support", async () => {
    const t = initConvexTest();
    await storeAsset(
      t,
      "/index.html",
      "<html></html>",
      "text/html; charset=utf-8",
    );
    await storeAsset(t, "/ep1.mp3", "0123456789", "application/octet-stream");

    const full = await t.fetch("/ep1.mp3", {});
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");

    const part = await t.fetch("/ep1.mp3", { headers: { Range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");

    const bad = await t.fetch("/ep1.mp3", { headers: { Range: "bytes=50-" } });
    expect(bad.status).toBe(416);
  });

  test("If-Range with a stale validator ignores Range and serves the full body", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep2.mp3", "0123456789", "application/octet-stream");

    const full = await t.fetch("/ep2.mp3", {});
    const etag = full.headers.get("ETag")!;

    const stale = await t.fetch("/ep2.mp3", {
      headers: { Range: "bytes=2-4", "If-Range": '"stale-validator"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789");

    const current = await t.fetch("/ep2.mp3", {
      headers: { Range: "bytes=2-4", "If-Range": etag },
    });
    expect(current.status).toBe(206);
    expect(await current.text()).toBe("234");
  });

  test("Range unit names are case-insensitive", async () => {
    const t = initConvexTest();
    await storeAsset(t, "/ep3.mp3", "0123456789", "application/octet-stream");

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
    // Node's extname returned "" for these, so they already mapped to
    // octet-stream. The current lookup preserves that behavior.
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
