/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("component lib", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("generates upload URLs", async () => {
    const t = initConvexTest();
    const uploadUrl = await t.mutation(internal.lib.generateUploadUrl, {});
    expect(typeof uploadUrl).toBe("string");
    expect(uploadUrl.length).toBeGreaterThan(0);

    const urls = await t.mutation(internal.lib.generateUploadUrls, {
      count: 3,
    });
    expect(urls).toHaveLength(3);
    for (const u of urls) {
      expect(typeof u).toBe("string");
    }

    await expect(
      t.mutation(internal.lib.generateUploadUrls, { count: 101 }),
    ).rejects.toThrow("integer from 1 to 100");
  });

  test("getByPath returns null when absent", async () => {
    const t = initConvexTest();
    const asset = await t.query(internal.lib.getByPath, {
      path: "/index.html",
    });
    expect(asset).toBeNull();
  });

  test("listAssets is empty by default", async () => {
    const t = initConvexTest();
    const assets = await t.query(internal.lib.listAssets, {});
    expect(assets).toHaveLength(0);
  });

  test("commitDeployment on empty db returns zero", async () => {
    const t = initConvexTest();
    const result = await t.mutation(internal.lib.commitDeployment, {
      currentDeploymentId: "deploy-1",
    });
    expect(result.deleted).toBe(0);
    expect(result.blobIds).toHaveLength(0);
  });

  test("recordAsset stores and replaces blob assets", async () => {
    const t = initConvexTest();

    await t.mutation(internal.lib.recordAsset, {
      path: "/test.js",
      blobId: "blob-123",
      contentType: "application/javascript; charset=utf-8",
      deploymentId: "deploy-1",
    });

    const first = await t.query(internal.lib.getByPath, { path: "/test.js" });
    expect(first?.blobId).toBe("blob-123");

    await t.mutation(internal.lib.recordAsset, {
      path: "/test.js",
      blobId: "blob-456",
      contentType: "application/javascript; charset=utf-8",
      deploymentId: "deploy-2",
    });

    const second = await t.query(internal.lib.getByPath, { path: "/test.js" });
    expect(second?.blobId).toBe("blob-456");
  });

  test("replaces a legacy or already-deleted storage reference", async () => {
    const t = initConvexTest();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["old"]));
    });
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      storageId,
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-old",
    });
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });

    await expect(
      t.mutation(internal.lib.recordAsset, {
        path: "/index.html",
        blobId: "replacement",
        contentType: "text/html; charset=utf-8",
        deploymentId: "deploy-new",
      }),
    ).resolves.toBeNull();
  });

  test("commitDeployment returns blobIds for old CDN assets and bumps deployment", async () => {
    const t = initConvexTest();

    await t.mutation(internal.lib.recordAsset, {
      path: "/assets/main.js",
      blobId: "blob-abc",
      contentType: "application/javascript; charset=utf-8",
      deploymentId: "deploy-old",
    });

    const result = await t.mutation(internal.lib.commitDeployment, {
      currentDeploymentId: "deploy-new",
    });
    expect(result.deleted).toBe(0);
    expect(result.blobIds).toEqual(["blob-abc"]);

    const deployment = await t.query(api.lib.getCurrentDeployment, {});
    expect(deployment?.currentDeploymentId).toBe("deploy-new");
  });

  test("commitDeployment skips a legacy or already-deleted storage ID", async () => {
    const t = initConvexTest();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["legacy"]));
    });
    await t.mutation(internal.lib.recordAsset, {
      path: "/legacy.css",
      storageId,
      contentType: "text/css; charset=utf-8",
      deploymentId: "deploy-old",
    });
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });

    const result = await t.mutation(internal.lib.commitDeployment, {
      currentDeploymentId: "deploy-new",
    });

    expect(result).toEqual({ deleted: 0, blobIds: [] });
    expect(await t.query(internal.lib.listAssets, {})).toEqual([]);
  });

  test("deletes newly uploaded files after a failed publish", async () => {
    const t = initConvexTest();
    const [first, alreadyMissing] = await t.run(async (ctx) => {
      return await Promise.all([
        ctx.storage.store(new Blob(["first"])),
        ctx.storage.store(new Blob(["missing"])),
      ]);
    });
    await t.run(async (ctx) => {
      await ctx.storage.delete(alreadyMissing);
    });

    const result = await t.mutation(internal.lib.deleteUploadedFiles, {
      storageIds: [first, alreadyMissing],
    });

    expect(result).toEqual({
      deleted: 1,
      alreadyMissing: 1,
      stillReferenced: 0,
    });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(first)).toBeNull();
    });
  });

  test("failed-upload cleanup never deletes a file referenced by the live manifest", async () => {
    const t = initConvexTest();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["live"]));
    });
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      storageId,
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-live",
    });

    const result = await t.mutation(internal.lib.deleteUploadedFiles, {
      storageIds: [storageId],
    });

    expect(result).toEqual({
      deleted: 0,
      alreadyMissing: 0,
      stillReferenced: 1,
    });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(storageId)).not.toBeNull();
    });
  });

  test("cleanup after a lost publish response keeps the newly live file", async () => {
    const t = initConvexTest();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["new live deployment"]));
    });
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/index.html",
          storageId,
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-ambiguous",
        },
      ],
    });
    await t.mutation(internal.lib.publishDeployment, {
      currentDeploymentId: "deploy-ambiguous",
      expectedAssetCount: 1,
    });

    // This is the sequence the CLI runs when the publish mutation committed
    // but its response was lost.
    expect(
      await t.mutation(internal.lib.discardStagedDeployment, {
        deploymentId: "deploy-ambiguous",
      }),
    ).toEqual({ discarded: 0 });
    expect(
      await t.mutation(internal.lib.deleteUploadedFiles, {
        storageIds: [storageId],
      }),
    ).toEqual({ deleted: 0, alreadyMissing: 0, stillReferenced: 1 });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(storageId)).not.toBeNull();
    });
  });

  test("publishes the manifest, deployment info, and cleanup atomically", async () => {
    const t = initConvexTest();
    const oldStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["old"]));
    });
    await t.mutation(internal.lib.recordAssets, {
      assets: [
        {
          path: "/old.css",
          storageId: oldStorageId,
          contentType: "text/css; charset=utf-8",
          deploymentId: "deploy-old",
        },
        {
          path: "/old.js",
          blobId: "old-cdn-blob",
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-old",
        },
      ],
    });
    const newStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["new"]));
    });

    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/index.html",
          storageId: newStorageId,
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-new",
        },
      ],
    });
    const result = await t.mutation(internal.lib.publishDeployment, {
      currentDeploymentId: "deploy-new",
      expectedAssetCount: 1,
      spaFallback: false,
    });

    expect(result).toEqual({ deleted: 0, pendingBlobCleanup: 1 });
    expect(await t.query(internal.lib.listPendingBlobCleanup, {})).toEqual([
      "old-cdn-blob",
    ]);
    expect(await t.query(internal.lib.listAssets, {})).toMatchObject([
      {
        path: "/index.html",
        storageId: newStorageId,
        deploymentId: "deploy-new",
      },
    ]);
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      currentDeploymentId: "deploy-new",
      spaFallback: false,
      pendingBlobCleanupCount: 1,
    });
    const concurrentStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["concurrent upload"]));
    });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(oldStorageId)).not.toBeNull();
      expect(await ctx.storage.get(newStorageId)).not.toBeNull();
    });
    expect(await t.mutation(internal.lib.cleanupPendingStorage, {})).toEqual({
      processed: 1,
      deleted: 1,
      needsAnotherPass: false,
    });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(oldStorageId)).toBeNull();
      expect(await ctx.storage.get(newStorageId)).not.toBeNull();
      expect(await ctx.storage.get(concurrentStorageId)).not.toBeNull();
    });

    expect(
      await t.mutation(internal.lib.acknowledgeBlobCleanup, {
        blobIds: ["old-cdn-blob"],
      }),
    ).toEqual({ acknowledged: 1 });
    expect(await t.query(internal.lib.listPendingBlobCleanup, {})).toEqual([]);
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      pendingBlobCleanupCount: 0,
    });

    expect(
      await t.mutation(internal.lib.queueBlobCleanup, {
        blobIds: ["retry-cdn-blob", "retry-cdn-blob"],
      }),
    ).toEqual({ queued: 1 });
    expect(await t.query(internal.lib.listPendingBlobCleanup, {})).toEqual([
      "retry-cdn-blob",
    ]);
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      pendingBlobCleanupCount: 1,
    });
  });

  test("rejects a staged manifest without index.html and keeps the live manifest", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      blobId: "still-live",
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-old",
    });

    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/only.css",
          blobId: "not-published",
          contentType: "text/css; charset=utf-8",
          deploymentId: "deploy-new",
        },
      ],
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-new",
        expectedAssetCount: 1,
      }),
    ).rejects.toThrow("must include /index.html");

    expect(
      await t.query(internal.lib.getByPath, { path: "/index.html" }),
    ).toMatchObject({ blobId: "still-live", deploymentId: "deploy-old" });
  });

  test("rejects a zero expected asset count without changing the live manifest", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      blobId: "still-live",
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-old",
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-empty",
        expectedAssetCount: 0,
      }),
    ).rejects.toThrow("integer from 1 to 1800");

    expect(
      await t.query(internal.lib.getByPath, { path: "/index.html" }),
    ).toMatchObject({ blobId: "still-live", deploymentId: "deploy-old" });
  });

  test("keeps CDN cleanup accounting queued before the first deployment", async () => {
    const t = initConvexTest();
    expect(
      await t.mutation(internal.lib.queueBlobCleanup, {
        blobIds: ["failed-first-upload"],
      }),
    ).toEqual({ queued: 1 });
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/index.html",
          blobId: "first-live-index",
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-first-success",
        },
      ],
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-first-success",
        expectedAssetCount: 1,
      }),
    ).resolves.toEqual({ deleted: 0, pendingBlobCleanup: 1 });
    expect(await t.query(api.lib.getCurrentDeployment, {})).toMatchObject({
      currentDeploymentId: "deploy-first-success",
      pendingBlobCleanupCount: 1,
    });
  });

  test("rejects a staged manifest whose storage file disappeared", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      blobId: "still-live",
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-old",
    });
    const missingStorageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["temporary"]));
      await ctx.storage.delete(storageId);
      return storageId;
    });
    await expect(
      t.mutation(internal.lib.stageAssets, {
        assets: [
          {
            path: "/index.html",
            storageId: missingStorageId,
            contentType: "text/html; charset=utf-8",
            deploymentId: "deploy-missing",
          },
        ],
      }),
    ).rejects.toThrow("Staged storage file is missing");
    expect(
      await t.query(internal.lib.getByPath, { path: "/index.html" }),
    ).toMatchObject({ blobId: "still-live", deploymentId: "deploy-old" });
  });

  test("publishes a manifest staged in multiple chunks", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/index.html",
          blobId: "index",
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-chunked",
        },
      ],
    });
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/app.js",
          blobId: "app",
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-chunked",
        },
      ],
    });

    await t.mutation(internal.lib.publishDeployment, {
      currentDeploymentId: "deploy-chunked",
      expectedAssetCount: 2,
    });

    expect(await t.query(internal.lib.listAssets, {})).toMatchObject([
      { path: "/index.html", deploymentId: "deploy-chunked" },
      { path: "/app.js", deploymentId: "deploy-chunked" },
    ]);
    expect(
      await t.mutation(internal.lib.discardStagedDeployment, {
        deploymentId: "deploy-chunked",
      }),
    ).toEqual({ discarded: 0 });
  });

  test("rejects manifests above the safe transaction-sized file limit", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.stageAssets, {
      assets: Array.from({ length: 1801 }, (_, index) => ({
        path: index === 0 ? "/index.html" : `/asset-${index}.js`,
        blobId: `blob-${index}`,
        contentType:
          index === 0
            ? "text/html; charset=utf-8"
            : "application/javascript; charset=utf-8",
        deploymentId: "deploy-too-large",
      })),
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-too-large",
        expectedAssetCount: 1801,
      }),
    ).rejects.toThrow("integer from 1 to 1800");
    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-too-large",
        expectedAssetCount: 1800,
      }),
    ).rejects.toThrow("Staged manifest has 1801 files; expected 1800");
  });

  test("publishes large inherited rows before bounded storage cleanup", async () => {
    const t = initConvexTest();
    const sharedStorageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["legacy"]));
      await Promise.all(
        Array.from({ length: 1800 }, (_, index) =>
          ctx.db.insert("staticAssets", {
            path: `/legacy-${index}`,
            storageId,
            blobId: `legacy-blob-${index}`,
            contentType: "application/octet-stream",
            deploymentId: "deploy-legacy",
          }),
        ),
      );
      return storageId;
    });
    expect(sharedStorageId).toBeTruthy();
    await t.mutation(internal.lib.stageAssets, {
      assets: Array.from({ length: 1800 }, (_, index) => ({
        path: index === 0 ? "/index.html" : `/new-${index}.js`,
        blobId: `new-blob-${index}`,
        contentType:
          index === 0
            ? "text/html; charset=utf-8"
            : "application/javascript; charset=utf-8",
        deploymentId: "deploy-new",
      })),
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-new",
        expectedAssetCount: 1800,
      }),
    ).resolves.toEqual({ deleted: 0, pendingBlobCleanup: 1800 });
    expect(await t.mutation(internal.lib.cleanupPendingStorage, {})).toEqual({
      processed: 1,
      deleted: 1,
      needsAnotherPass: false,
    });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(sharedStorageId)).toBeNull();
    });
  });

  test("rejects manifests above the serialized metadata budget", async () => {
    const t = initConvexTest();
    const assets = Array.from({ length: 1800 }, (_, index) => ({
      path:
        index === 0
          ? "/index.html"
          : `/${index}-${"nested-path/".repeat(100)}asset.js`,
      blobId: `blob-${index}`,
      contentType:
        index === 0
          ? "text/html; charset=utf-8"
          : "application/javascript; charset=utf-8",
      deploymentId: "deploy-too-many-bytes",
    }));
    await t.mutation(internal.lib.stageAssets, { assets });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-too-many-bytes",
        expectedAssetCount: assets.length,
      }),
    ).rejects.toThrow("above the safe limit");
  });

  test("rejects an oversized combined legacy and new manifest safely", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      await Promise.all(
        Array.from({ length: 2001 }, (_, index) =>
          ctx.db.insert("staticAssets", {
            path: `/legacy-${index}.js`,
            blobId: `legacy-${index}`,
            contentType: "application/javascript; charset=utf-8",
            deploymentId: "deploy-legacy",
          }),
        ),
      );
    });
    const assets = Array.from({ length: 1800 }, (_, index) => ({
      path: index === 0 ? "/index.html" : `/new-${index}.js`,
      blobId: `new-${index}`,
      contentType:
        index === 0
          ? "text/html; charset=utf-8"
          : "application/javascript; charset=utf-8",
      deploymentId: "deploy-new",
    }));
    await t.mutation(internal.lib.stageAssets, { assets });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-new",
        expectedAssetCount: assets.length,
      }),
    ).rejects.toThrow("more than 3800 rows combined");
  });

  test("rejects a truncated staged manifest even when index.html remains", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.recordAsset, {
      path: "/index.html",
      blobId: "still-live",
      contentType: "text/html; charset=utf-8",
      deploymentId: "deploy-old",
    });
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/app.js",
          blobId: "app",
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-truncated",
        },
        {
          path: "/index.html",
          blobId: "index",
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-truncated",
        },
      ],
    });
    await t.run(async (ctx) => {
      const stagedAssets = await ctx.db
        .query("stagedAssets")
        .withIndex("by_deploymentId", (q) =>
          q.eq("deploymentId", "deploy-truncated"),
        )
        .collect();
      const appAsset = stagedAssets.find((asset) => asset.path === "/app.js");
      if (!appAsset) throw new Error("Expected staged app asset");
      await ctx.db.delete("stagedAssets", appAsset._id);
    });

    await expect(
      t.mutation(internal.lib.publishDeployment, {
        currentDeploymentId: "deploy-truncated",
        expectedAssetCount: 2,
      }),
    ).rejects.toThrow("Staged manifest has 1 files; expected 2");
    expect(
      await t.query(internal.lib.getByPath, { path: "/index.html" }),
    ).toMatchObject({ blobId: "still-live", deploymentId: "deploy-old" });
  });

  test("removes old unreferenced component storage after an interrupted upload", async () => {
    const t = initConvexTest();
    const orphan = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["orphan"]));
    });

    const result = await t.mutation(internal.lib.cleanupUnreferencedStorage, {
      before: Date.now() + 1,
      limit: 10,
    });

    expect(result.deleted).toBe(1);
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(orphan)).toBeNull();
    });
  });

  test("recovers an abandoned staged manifest and queues its CDN blob", async () => {
    const t = initConvexTest();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["abandoned"]));
    });
    await t.mutation(internal.lib.stageAssets, {
      assets: [
        {
          path: "/index.html",
          storageId,
          contentType: "text/html; charset=utf-8",
          deploymentId: "deploy-abandoned",
        },
        {
          path: "/app.js",
          blobId: "abandoned-cdn-blob",
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-abandoned",
        },
      ],
    });

    expect(
      await t.mutation(internal.lib.cleanupAbandonedStaging, {
        before: Date.now() + 1,
      }),
    ).toEqual({ discarded: 2, deletedFiles: 1, queuedBlobIds: 1 });
    expect(await t.query(internal.lib.listPendingBlobCleanup, {})).toEqual([
      "abandoned-cdn-blob",
    ]);
    expect(
      await t.mutation(internal.lib.discardStagedDeployment, {
        deploymentId: "deploy-abandoned",
      }),
    ).toEqual({ discarded: 0 });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(storageId)).toBeNull();
    });
  });

  test("recordAssets batches multiple inserts", async () => {
    const t = initConvexTest();

    const result = await t.mutation(internal.lib.recordAssets, {
      assets: [
        {
          path: "/a.js",
          blobId: "blob-a",
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-1",
        },
        {
          path: "/b.css",
          blobId: "blob-b",
          contentType: "text/css; charset=utf-8",
          deploymentId: "deploy-1",
        },
      ],
    });

    expect(result).toEqual({ blobIds: [] });
    const all = await t.query(internal.lib.listAssets, {});
    expect(all).toHaveLength(2);
  });

  test("recordAssets returns replaced CDN blobs for cleanup", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.recordAsset, {
      path: "/app.js",
      blobId: "old-blob",
      contentType: "application/javascript; charset=utf-8",
      deploymentId: "deploy-old",
    });

    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["new"]));
    });
    const result = await t.mutation(internal.lib.recordAssets, {
      assets: [
        {
          path: "/app.js",
          storageId,
          contentType: "application/javascript; charset=utf-8",
          deploymentId: "deploy-new",
        },
      ],
    });

    expect(result).toEqual({ blobIds: ["old-blob"] });
    const current = await t.query(internal.lib.getByPath, { path: "/app.js" });
    expect(current?.storageId).toBe(storageId);
    expect(current?.blobId).toBeUndefined();
  });

  test("recordAssets rejects ambiguous locations and duplicate paths", async () => {
    const t = initConvexTest();

    await expect(
      t.mutation(internal.lib.recordAssets, {
        assets: [
          {
            path: "/missing-location.js",
            contentType: "application/javascript; charset=utf-8",
            deploymentId: "deploy-1",
          },
        ],
      }),
    ).rejects.toThrow("exactly one of storageId or blobId");

    await expect(
      t.mutation(internal.lib.recordAssets, {
        assets: [
          {
            path: "/duplicate.js",
            blobId: "blob-a",
            contentType: "application/javascript; charset=utf-8",
            deploymentId: "deploy-1",
          },
          {
            path: "/duplicate.js",
            blobId: "blob-b",
            contentType: "application/javascript; charset=utf-8",
            deploymentId: "deploy-1",
          },
        ],
      }),
    ).rejects.toThrow("Duplicate asset path");
  });

  describe("resolveAsset", () => {
    async function seedIndex(t: ReturnType<typeof initConvexTest>) {
      await t.mutation(internal.lib.recordAsset, {
        path: "/index.html",
        blobId: "blob-index",
        contentType: "text/html; charset=utf-8",
        deploymentId: "deploy-1",
      });
    }

    test("returns the exact match when present", async () => {
      const t = initConvexTest();
      await t.mutation(internal.lib.recordAsset, {
        path: "/assets/app-B71cUw87.js",
        blobId: "blob-app",
        contentType: "application/javascript; charset=utf-8",
        deploymentId: "deploy-1",
      });

      const asset = await t.query(internal.lib.resolveAsset, {
        path: "/assets/app-B71cUw87.js",
      });
      expect(asset?.path).toBe("/assets/app-B71cUw87.js");
    });

    test("falls back to index.html for extension-less misses by default", async () => {
      const t = initConvexTest();
      await seedIndex(t);

      const asset = await t.query(internal.lib.resolveAsset, {
        path: "/dashboard/settings",
      });
      expect(asset?.path).toBe("/index.html");
    });

    test("does not fall back for paths with an extension", async () => {
      const t = initConvexTest();
      await seedIndex(t);

      const asset = await t.query(internal.lib.resolveAsset, {
        path: "/missing.js",
      });
      expect(asset).toBeNull();
    });

    test("does not fall back when the deployment disables it", async () => {
      const t = initConvexTest();
      await seedIndex(t);
      await t.mutation(internal.lib.commitDeployment, {
        currentDeploymentId: "deploy-1",
        spaFallback: false,
      });

      const asset = await t.query(internal.lib.resolveAsset, {
        path: "/dashboard",
      });
      expect(asset).toBeNull();
    });

    test("returns a storage URL for app-owned HTTP routes", async () => {
      const t = initConvexTest();
      const storageId = await t.run(async (ctx) => {
        return await ctx.storage.store(
          new Blob(["<h1>Hello</h1>"], { type: "text/html" }),
        );
      });
      await t.mutation(internal.lib.recordAsset, {
        path: "/index.html",
        storageId,
        contentType: "text/html; charset=utf-8",
        deploymentId: "deploy-1",
      });

      const asset = await t.query(api.lib.resolveAssetForHttp, {
        path: "/index.html",
      });

      expect(asset?.storageUrl).toContain("http");
      expect(asset?.etag).toBe(`"${storageId}"`);
      expect(asset?.contentType).toBe("text/html; charset=utf-8");
    });

    test("returns the stored file size so Range can be resolved", async () => {
      // The app-owned route resolves a Range against `size` before streaming;
      // if it were omitted, Range would be silently ignored and a full 200
      // served. Mocked runQuery tests can't catch that, so assert it here
      // against real storage.
      const t = initConvexTest();
      const body = "<h1>Hello, range</h1>";
      const storageId = await t.run(async (ctx) => {
        return await ctx.storage.store(new Blob([body], { type: "text/html" }));
      });
      await t.mutation(internal.lib.recordAsset, {
        path: "/index.html",
        storageId,
        contentType: "text/html; charset=utf-8",
        deploymentId: "deploy-1",
      });

      const asset = await t.query(api.lib.resolveAssetForHttp, {
        path: "/index.html",
      });

      expect(asset?.size).toBe(new TextEncoder().encode(body).byteLength);
    });

    test("surfaces the app-owned storage id for inherited v1 rows", async () => {
      // A same-name v1→v2 migration inherits rows whose files live in the app's
      // storage; the component can't resolve a URL for them. convex-test can't
      // distinguish that from a deleted file, so deleting one reproduces the
      // condition: resolveAssetForHttp surfaces appStorageId (no storageUrl) so
      // the app-side handler can serve it from its own storage during migration.
      const t = initConvexTest();
      const storageId = await t.run(async (ctx) => {
        return await ctx.storage.store(new Blob(["legacy"]));
      });
      await t.mutation(internal.lib.recordAsset, {
        path: "/index.html",
        storageId,
        contentType: "text/html; charset=utf-8",
        deploymentId: "deploy-old",
      });
      await t.run(async (ctx) => {
        await ctx.storage.delete(storageId);
      });

      const asset = await t.query(api.lib.resolveAssetForHttp, {
        path: "/index.html",
      });
      expect(asset?.appStorageId).toBe(storageId);
      expect(asset?.storageUrl).toBeUndefined();
      expect(asset?.size).toBeUndefined();
      expect(asset?.etag).toBe(`"${storageId}"`);
    });

    test("allows compatibility routes to override SPA fallback", async () => {
      const t = initConvexTest();
      await seedIndex(t);

      const asset = await t.query(api.lib.resolveAssetForHttp, {
        path: "/dashboard",
        spaFallback: false,
      });

      expect(asset).toBeNull();
    });
  });
});
