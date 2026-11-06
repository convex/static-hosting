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
  resolveContentType,
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
