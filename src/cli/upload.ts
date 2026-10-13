#!/usr/bin/env node
/**
 * CLI tool to upload static files to a Convex static-hosting component.
 *
 * Usage:
 *   npx @convex-dev/static-hosting upload [options]
 *
 * Options:
 *   --dist <path>            Path to dist directory (default: ./dist)
 *   --component <name>       Component instance name (default: staticHosting)
 *   --prod                   Deploy to production deployment
 *   --build                  Run the frontend build before uploading
 *   --build-command <cmd>    Override the frontend build command
 *   --spa / --no-spa         Enable or disable SPA fallback
 *   --cdn                    Use the legacy convex-fs integration
 *   --cdn-delete-function    App function that deletes old CDN blobs
 *   --concurrency <n>        Parallel upload workers (default: 5)
 *   --help                   Show help
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative, extname, resolve } from "path";
import { randomUUID } from "crypto";
import { runConvexAsync, spawnShell } from "./commands.js";
import {
  chunkBySerializedArgument,
  MAX_CONVEX_ARGUMENT_BYTES,
} from "./argumentChunks.js";
import { parseUploadArgs } from "./args.js";
import { buildEnvironment } from "./deployEnvironment.js";
import {
  componentNameCandidates,
  isLegacyAutoDetected,
  legacyComponentNameWarning,
} from "./componentName.js";

// MIME type mapping
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

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function showHelp(): void {
  console.log(`
Usage: npx @convex-dev/static-hosting upload [options]

Upload static files from a dist directory to Convex storage.

Options:
  -d, --dist <path>           Path to dist directory (default: ./dist)
  -c, --component <name>      Static-hosting component instance name (default: staticHosting)
      --prod                  Deploy to production deployment
  -b, --build                 Run the build command with VITE_CONVEX_URL,
                              VITE_CONVEX_SITE_URL, and
                              STATIC_HOSTING_BASE_PATH set before uploading
      --build-command <cmd>   Build command to run (default: 'npm run build').
                              Implies --build.
      --no-spa                Disable SPA fallback for this deployment (return a
                              404 instead of falling back to /index.html)
      --spa                   Enable SPA fallback for this deployment (default)
      --cdn                   Use the legacy convex-fs integration
      --cdn-delete-function <name>  Legacy app function that deletes CDN blobs
  -j, --concurrency <n>       Number of parallel uploads (default: 5)
  -h, --help                  Show this help message

Examples:
  # Upload to Convex storage
  npx @convex-dev/static-hosting upload
  npx @convex-dev/static-hosting upload --dist ./build --prod
  npx @convex-dev/static-hosting upload --build --prod

  # Upload through an existing legacy convex-fs integration
  npx @convex-dev/static-hosting upload --cdn --prod
`);
}

// Global flag for production mode
let useProd = true;
const MAX_ASSETS_PER_DEPLOYMENT = 1800;
const MAX_MANIFEST_SERIALIZED_BYTES = 2 * 1024 * 1024;
// A Convex CLI function result can be truncated around 64 KiB. Signed upload
// URLs are long enough that 250 sometimes crosses that boundary.
const UPLOAD_URL_BATCH_SIZE = 100;
const MAINTENANCE_PAGE_SIZE = 256;
const MAX_MAINTENANCE_PAGES = 20;

interface DeploymentUrls {
  /** CONVEX_SITE_URL, including the component's mount prefix. */
  siteUrl: string;
  /** CONVEX_CLOUD_URL, the backend URL the frontend connects to. */
  cloudUrl: string;
}

/**
 * Resolve the component's deployment URLs and the instance name that answered.
 *
 * When the caller relied on the default name we also probe the legacy 0.1.x
 * name so a same-name migration keeps working without `--component selfHosting`
 * on every command; landing on the legacy name prints a one-time warning. Bails
 * the CLI if no candidate is deployed. Uploading wouldn't work either, so a
 * fallback would only hide the real problem.
 */
async function fetchUrls(
  requested: string,
): Promise<{ urls: DeploymentUrls; componentName: string }> {
  const candidates = componentNameCandidates(requested);
  for (const name of candidates) {
    try {
      const out = await convexRunAsync(
        name,
        "lib:getUrls",
        {},
        { quiet: true },
      );
      const urls: DeploymentUrls = JSON.parse(out);
      if (isLegacyAutoDetected(requested, name)) {
        console.warn(legacyComponentNameWarning(name));
      }
      return { urls, componentName: name };
    } catch {
      // Try the next candidate name.
    }
  }
  console.error(
    `Could not reach component ${candidates
      .map((name) => `"${name}"`)
      .join(" or ")}. Deploy the Convex backend first and ensure --component ` +
      `matches the name in convex.config.ts.`,
  );
  process.exit(1);
}

function convexRunAsync(
  componentName: string | undefined,
  functionPath: string,
  args: Record<string, unknown> = {},
  options: { quiet?: boolean } = {},
): Promise<string> {
  const serializedArgs = JSON.stringify(args);
  const argumentBytes = Buffer.byteLength(serializedArgs);
  if (argumentBytes > MAX_CONVEX_ARGUMENT_BYTES) {
    throw new Error(
      "The Convex function argument is " +
        argumentBytes +
        " bytes, which exceeds the portable command-line limit. " +
        "This is an internal chunking error; please report it.",
    );
  }

  return runConvexAsync(
    [
      "run",
      ...(componentName ? ["--component", componentName] : []),
      functionPath,
      serializedArgs,
      "--typecheck=disable",
      "--codegen=disable",
      ...(useProd ? ["--prod"] : []),
    ],
    options,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UploadedLocations {
  storageIds: string[];
  blobIds: string[];
}

interface PublishResult {
  deleted: number;
  pendingBlobCleanup: number;
}

async function cleanUpPendingCdnBlobs(
  componentName: string,
  cdnDeleteFunction: string,
): Promise<number> {
  if (!cdnDeleteFunction) return 0;

  let cleaned = 0;
  for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
    const output = await convexRunAsync(
      componentName,
      "lib:listPendingBlobCleanup",
      { limit: 250 },
    );
    const blobIds = JSON.parse(output) as unknown;
    if (
      !Array.isArray(blobIds) ||
      !blobIds.every((blobId) => typeof blobId === "string")
    ) {
      throw new Error("Component returned invalid pending CDN cleanup data");
    }
    if (blobIds.length === 0) return cleaned;

    const deleteChunks = chunkBySerializedArgument(blobIds, (chunk) => ({
      blobIds: chunk,
    }));
    for (const chunk of deleteChunks) {
      await convexRunAsync(undefined, cdnDeleteFunction, { blobIds: chunk });
      await convexRunAsync(componentName, "lib:acknowledgeBlobCleanup", {
        blobIds: chunk,
      });
      cleaned += chunk.length;
    }
  }
  console.warn(
    "Warning: CDN cleanup reached its per-run maintenance limit; a later upload will continue it.",
  );
  return cleaned;
}

async function cleanUpAbandonedUploads(
  componentName: string,
  cdnDeleteFunction: string,
): Promise<void> {
  let discarded = 0;
  let deletedFiles = 0;
  let queuedBlobIds = 0;

  try {
    let stagingDrained = false;
    for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
      const output = await convexRunAsync(
        componentName,
        "lib:cleanupAbandonedStaging",
        { limit: MAINTENANCE_PAGE_SIZE },
      );
      const result = JSON.parse(output) as {
        discarded?: unknown;
        deletedFiles?: unknown;
        queuedBlobIds?: unknown;
      };
      if (
        typeof result.discarded !== "number" ||
        typeof result.deletedFiles !== "number" ||
        typeof result.queuedBlobIds !== "number"
      ) {
        throw new Error("Component returned invalid staging cleanup data");
      }
      discarded += result.discarded;
      deletedFiles += result.deletedFiles;
      queuedBlobIds += result.queuedBlobIds;
      if (result.discarded < MAINTENANCE_PAGE_SIZE) {
        stagingDrained = true;
        break;
      }
    }
    if (!stagingDrained) {
      console.warn(
        "Warning: Staging cleanup reached its per-run maintenance limit; a later upload will continue it.",
      );
    }

    deletedFiles += await cleanUpPendingStorage(componentName);
    deletedFiles += await cleanUpUnreferencedStorage(
      componentName,
      undefined,
      "desc",
    );
    deletedFiles += await cleanUpUnreferencedStorage(
      componentName,
      undefined,
      "asc",
    );

    if (discarded > 0 || deletedFiles > 0 || queuedBlobIds > 0) {
      console.log(
        `Recovered ${discarded} abandoned manifest record(s), removed ${deletedFiles} old unreferenced file(s), and queued ${queuedBlobIds} CDN blob(s) for cleanup.`,
      );
    }

    if (cdnDeleteFunction) {
      const cleaned = await cleanUpPendingCdnBlobs(
        componentName,
        cdnDeleteFunction,
      );
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} pending CDN blob(s).`);
      }
    }
  } catch (cleanupError) {
    console.warn(
      "Warning: Could not finish abandoned-upload maintenance: " +
        errorMessage(cleanupError),
    );
  }
}

async function cleanUpUnreferencedStorage(
  componentName: string,
  before?: number,
  order: "asc" | "desc" = "asc",
): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
    const output = await convexRunAsync(
      componentName,
      "lib:cleanupUnreferencedStorage",
      {
        limit: MAINTENANCE_PAGE_SIZE,
        order,
        ...(before === undefined ? {} : { before }),
      },
    );
    const result = JSON.parse(output) as {
      deleted?: unknown;
      needsAnotherPass?: unknown;
    };
    if (
      typeof result.deleted !== "number" ||
      typeof result.needsAnotherPass !== "boolean"
    ) {
      throw new Error("Component returned invalid storage cleanup data");
    }
    deleted += result.deleted;
    if (!result.needsAnotherPass) return deleted;
  }
  console.warn(
    "Warning: Orphan storage cleanup reached its per-run maintenance limit; a later upload will continue it.",
  );
  return deleted;
}

async function cleanUpPendingStorage(componentName: string): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < MAX_MAINTENANCE_PAGES; page++) {
    const output = await convexRunAsync(
      componentName,
      "lib:cleanupPendingStorage",
      { limit: MAINTENANCE_PAGE_SIZE },
    );
    const result = JSON.parse(output) as {
      deleted?: unknown;
      needsAnotherPass?: unknown;
    };
    if (
      typeof result.deleted !== "number" ||
      typeof result.needsAnotherPass !== "boolean"
    ) {
      throw new Error(
        "Component returned invalid pending-storage cleanup data",
      );
    }
    deleted += result.deleted;
    if (!result.needsAnotherPass) return deleted;
  }
  console.warn(
    "Warning: Published storage cleanup reached its per-run maintenance limit; a later upload will continue it.",
  );
  return deleted;
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;

  async function runWorker() {
    while (firstError === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (firstError !== undefined) throw firstError;
}

async function cleanUpFailedUpload(
  componentName: string,
  deploymentId: string,
  uploaded: UploadedLocations,
  cdnDeleteFunction: string,
  publishAttempted: boolean,
) {
  let discardSucceeded = false;
  let discarded = 0;
  try {
    const output = await convexRunAsync(
      componentName,
      "lib:discardStagedDeployment",
      { deploymentId },
    );
    const result = JSON.parse(output) as { discarded?: unknown };
    if (typeof result.discarded !== "number") {
      throw new Error("Component returned an invalid discard result");
    }
    discardSucceeded = true;
    discarded = result.discarded;
  } catch (cleanupError) {
    console.warn(
      "Warning: Could not discard the staged manifest: " +
        errorMessage(cleanupError),
    );
  }

  // Convex mutations have a single transaction order. If discard succeeds,
  // either it removed the staged rows before a late publish could use them, or
  // publish already committed and removed them first. In the latter case the
  // component cleanup below sees the live references and keeps those files.
  const canCleanComponentFiles = !publishAttempted || discardSucceeded;
  if (uploaded.storageIds.length > 0 && canCleanComponentFiles) {
    try {
      let deleted = 0;
      let stillReferenced = 0;
      const chunks = chunkBySerializedArgument(
        uploaded.storageIds,
        (storageIds) => ({ storageIds }),
      );
      for (const storageIds of chunks) {
        const output = await convexRunAsync(
          componentName,
          "lib:deleteUploadedFiles",
          { storageIds },
        );
        const result = JSON.parse(output) as {
          deleted?: unknown;
          stillReferenced?: unknown;
        };
        if (typeof result.deleted === "number") deleted += result.deleted;
        if (typeof result.stillReferenced === "number") {
          stillReferenced += result.stillReferenced;
        }
      }
      console.log(`Removed ${deleted} file(s) from the failed upload.`);
      if (stillReferenced > 0) {
        console.warn(
          `Kept ${stillReferenced} file(s) because the live deployment references them. The publish may have completed even though its response was lost.`,
        );
      }
    } catch (cleanupError) {
      console.warn(
        "Warning: Could not remove component files from the failed upload: " +
          errorMessage(cleanupError),
      );
    }
  } else if (uploaded.storageIds.length > 0) {
    console.warn(
      `${uploaded.storageIds.length} component file(s) were left in place because the CLI could not cancel or confirm the publish.`,
    );
  }

  // The app-level CDN delete function cannot inspect component-private live
  // references. Only delete CDN blobs when no publish was attempted, or when
  // discard removed staged rows and therefore won the transaction race.
  const canDeleteCdnBlobs =
    !publishAttempted || (discardSucceeded && discarded > 0);
  if (uploaded.blobIds.length > 0 && canDeleteCdnBlobs) {
    try {
      // Record these IDs before calling app-owned deletion. If that call fails
      // or only partially completes, the next upload can retry safely.
      const chunks = chunkBySerializedArgument(uploaded.blobIds, (blobIds) => ({
        blobIds,
      }));
      for (const blobIds of chunks) {
        await convexRunAsync(componentName, "lib:queueBlobCleanup", {
          blobIds,
        });
      }

      if (cdnDeleteFunction) {
        const cleaned = await cleanUpPendingCdnBlobs(
          componentName,
          cdnDeleteFunction,
        );
        console.log(`Removed ${cleaned} pending CDN blob(s).`);
      } else {
        console.warn(
          `${uploaded.blobIds.length} CDN blob(s) from the failed upload were queued for cleanup. Pass --cdn-delete-function on a later upload to delete them.`,
        );
      }
    } catch (cleanupError) {
      console.warn(
        "Warning: Could not finish queuing or deleting CDN blobs from the failed upload: " +
          errorMessage(cleanupError),
      );
    }
  } else if (uploaded.blobIds.length > 0 && !canDeleteCdnBlobs) {
    console.warn(
      `${uploaded.blobIds.length} CDN blob(s) were left in place because the CLI could not determine whether the publish completed.`,
    );
  }
}

async function uploadWithConcurrency(
  files: Array<{ path: string; localPath: string; contentType: string }>,
  componentName: string,
  deploymentId: string,
  useCdn: boolean,
  cdnUploadBase: string | null,
  concurrency: number,
  spaFallback: boolean,
  cdnDeleteFunction: string,
): Promise<PublishResult> {
  const total = files.length;
  const uploaded: UploadedLocations = { storageIds: [], blobIds: [] };

  // Separate CDN and storage files
  const cdnFiles: typeof files = [];
  const storageFiles: typeof files = [];
  for (const file of files) {
    const isHtml = file.contentType.startsWith("text/html");
    if (useCdn && !isHtml && cdnUploadBase) {
      cdnFiles.push(file);
    } else {
      storageFiles.push(file);
    }
  }

  // Upload storage files using batch operations
  let completed = 0;
  const allAssets: Array<{
    path: string;
    storageId?: string;
    blobId?: string;
    contentType: string;
    deploymentId: string;
  }> = [];
  let publishAttempted = false;

  try {
    if (storageFiles.length > 0) {
      // Keep both the Convex array value and the child-process stdout buffer
      // bounded, even for a deployment with thousands of files.
      console.log(`  Generating ${storageFiles.length} upload URLs...`);
      const uploadUrls: string[] = [];
      for (
        let offset = 0;
        offset < storageFiles.length;
        offset += UPLOAD_URL_BATCH_SIZE
      ) {
        const count = Math.min(
          UPLOAD_URL_BATCH_SIZE,
          storageFiles.length - offset,
        );
        const urlsOutput = await convexRunAsync(
          componentName,
          "lib:generateUploadUrls",
          { count },
        );
        const batch = JSON.parse(urlsOutput) as unknown;
        if (
          !Array.isArray(batch) ||
          batch.length !== count ||
          !batch.every((url) => typeof url === "string")
        ) {
          throw new Error("Component returned invalid upload URLs");
        }
        uploadUrls.push(...batch);
      }

      // Step 2: Upload all files in parallel via fetch
      const storageIds: string[] = new Array(storageFiles.length);
      await forEachWithConcurrency(
        storageFiles,
        concurrency,
        async (file, idx) => {
          const content = readFileSync(file.localPath);
          const response = await fetch(uploadUrls[idx], {
            method: "POST",
            headers: { "Content-Type": file.contentType },
            body: content,
          });
          if (!response.ok) {
            throw new Error(
              "Storage upload failed for " +
                file.path +
                ": " +
                response.status +
                " " +
                response.statusText,
            );
          }
          const { storageId } = (await response.json()) as {
            storageId?: unknown;
          };
          if (typeof storageId !== "string") {
            throw new Error(
              "Storage upload returned no storageId for " + file.path,
            );
          }
          storageIds[idx] = storageId;
          uploaded.storageIds.push(storageId);
          completed++;
          const isHtml = file.contentType.startsWith("text/html");
          console.log(
            `  [${completed}/${total}] ${file.path} (${isHtml ? "storage/html" : "storage"})`,
          );
        },
      );

      for (let i = 0; i < storageFiles.length; i++) {
        allAssets.push({
          path: storageFiles[i].path,
          storageId: storageIds[i],
          contentType: storageFiles[i].contentType,
          deploymentId,
        });
      }
    }

    // Upload CDN files (still uses per-file calls since CDN has its own upload endpoint)
    if (cdnFiles.length > 0 && cdnUploadBase) {
      await forEachWithConcurrency(cdnFiles, concurrency, async (file) => {
        const content = readFileSync(file.localPath);
        const uploadResponse = await fetch(`${cdnUploadBase}/fs/upload`, {
          method: "POST",
          headers: { "Content-Type": file.contentType },
          body: content,
        });
        if (!uploadResponse.ok) {
          throw new Error(
            `CDN upload failed for ${file.path}: ${uploadResponse.status}`,
          );
        }
        const { blobId } = (await uploadResponse.json()) as {
          blobId?: unknown;
        };
        if (typeof blobId !== "string") {
          throw new Error("CDN upload returned no blobId for " + file.path);
        }
        uploaded.blobIds.push(blobId);
        allAssets.push({
          path: file.path,
          blobId,
          contentType: file.contentType,
          deploymentId,
        });
        completed++;
        console.log(`  [${completed}/${total}] ${file.path} (cdn)`);
      });
    }

    // Stage the manifest in portable command-line chunks. These rows are not
    // served, so the previous deployment stays intact until publish succeeds.
    const manifestChunks = chunkBySerializedArgument(allAssets, (assets) => ({
      assets,
    }));
    for (let index = 0; index < manifestChunks.length; index++) {
      console.log(
        `  Staging manifest chunk ${index + 1}/${manifestChunks.length}...`,
      );
      await convexRunAsync(componentName, "lib:stageAssets", {
        assets: manifestChunks[index],
      });
    }

    // Publish the staged manifest, SPA setting, and old-asset GC in one
    // mutation. The previous deployment stays intact if this call fails.
    console.log("  Publishing deployment...");
    publishAttempted = true;
    const output = await convexRunAsync(
      componentName,
      "lib:publishDeployment",
      {
        currentDeploymentId: deploymentId,
        expectedAssetCount: allAssets.length,
        spaFallback,
      },
    );
    const result = JSON.parse(output) as {
      deleted?: unknown;
      pendingBlobCleanup?: unknown;
    };
    if (
      typeof result.deleted !== "number" ||
      typeof result.pendingBlobCleanup !== "number"
    ) {
      throw new Error("Component returned an invalid publish result");
    }
    return {
      deleted: result.deleted,
      pendingBlobCleanup: result.pendingBlobCleanup,
    };
  } catch (error) {
    if (publishAttempted) {
      try {
        const output = await convexRunAsync(
          componentName,
          "lib:getCurrentDeployment",
        );
        const current = JSON.parse(output) as {
          currentDeploymentId?: unknown;
          pendingBlobCleanupCount?: unknown;
        } | null;
        if (current?.currentDeploymentId === deploymentId) {
          console.warn(
            "The publish completed, but the CLI could not read a valid response. The new deployment is live and its files were kept.",
          );
          return {
            deleted: 0,
            pendingBlobCleanup:
              typeof current.pendingBlobCleanupCount === "number"
                ? current.pendingBlobCleanupCount
                : 0,
          };
        }
      } catch (reconcileError) {
        console.warn(
          "Warning: Could not determine whether the publish completed: " +
            errorMessage(reconcileError),
        );
      }
    }

    await cleanUpFailedUpload(
      componentName,
      deploymentId,
      uploaded,
      cdnDeleteFunction,
      publishAttempted,
    );
    throw error;
  }
}

function collectFiles(
  dir: string,
  baseDir: string,
): Array<{ path: string; localPath: string; contentType: string }> {
  const files: Array<{
    path: string;
    localPath: string;
    contentType: string;
  }> = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push({
        path: "/" + relative(baseDir, fullPath).replace(/\\/g, "/"),
        localPath: fullPath,
        contentType: getMimeType(fullPath),
      });
    }
  }
  return files;
}

function estimateManifestBytes(
  files: Array<{ path: string; contentType: string }>,
  deploymentId: string,
): number {
  // IDs returned by Convex storage and convex-fs are much shorter than this.
  // The generous placeholder lets us reject oversized path metadata before
  // uploading while the component still enforces the exact serialized size.
  const locationPlaceholder = "x".repeat(128);
  return Buffer.byteLength(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        storageId: locationPlaceholder,
        contentType: file.contentType,
        deploymentId,
      })),
    ),
  );
}

async function main(): Promise<void> {
  const args = parseUploadArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Set global prod flag
  useProd = args.prod;

  // The component knows both its CONVEX_SITE_URL (where the app is served,
  // including the mount prefix) and CONVEX_CLOUD_URL (what the frontend
  // connects to). We fetch both in one call and trust neither hostname. This
  // also resolves the instance name actually mounted (default or legacy).
  const {
    urls: { siteUrl: componentSiteUrl, cloudUrl: convexUrl },
    componentName: resolvedComponentName,
  } = await fetchUrls(args.component);

  // Run build if requested
  if (args.build) {
    const environment = buildEnvironment({
      siteUrl: componentSiteUrl,
      cloudUrl: convexUrl,
    });

    const envLabel = useProd ? "production" : "development";
    console.log(`🔨 Building for ${envLabel}...`);
    console.log(`   Build command: ${args.buildCommand}`);
    console.log(`   VITE_CONVEX_URL=${environment.cloudUrl}`);
    console.log(`   VITE_CONVEX_SITE_URL=${environment.siteUrl}`);
    console.log(`   STATIC_HOSTING_BASE_PATH=${environment.basePath}`);
    console.log("");

    const buildResult = spawnShell(args.buildCommand, {
      ...process.env,
      VITE_CONVEX_URL: environment.cloudUrl,
      VITE_CONVEX_SITE_URL: environment.siteUrl,
      STATIC_HOSTING_BASE_PATH: environment.basePath,
    });

    if (buildResult !== 0) {
      console.error("Build failed.");
      process.exit(1);
    }

    console.log("");
  }

  const distDir = resolve(args.dist);
  const componentName = resolvedComponentName;
  const useCdn = args.cdn;

  // Convex storage deployment

  if (!existsSync(distDir)) {
    console.error(`Error: dist directory not found: ${distDir}`);
    console.error(
      "Run your build command first (e.g., 'npm run build' or add --build flag)",
    );
    process.exit(1);
  }

  // /fs/upload lives at the deployment root, not under the component's
  // mount prefix.
  const cdnUploadBase = useCdn ? new URL(componentSiteUrl).origin : null;

  const deploymentId = randomUUID();
  const files = collectFiles(distDir, distDir);
  if (files.length === 0) {
    console.error(`Error: dist directory is empty: ${distDir}`);
    console.error("Refusing to replace the live deployment with no files.");
    process.exit(1);
  }
  if (!files.some((file) => file.path === "/index.html")) {
    console.error(`Error: dist directory has no index.html: ${distDir}`);
    console.error("Refusing to publish a static site without its entry point.");
    process.exit(1);
  }
  if (files.length > MAX_ASSETS_PER_DEPLOYMENT) {
    console.error(
      `Error: dist directory contains ${files.length} files; the supported maximum is ${MAX_ASSETS_PER_DEPLOYMENT}.`,
    );
    console.error(
      "Reduce the number of emitted files so publication stays within Convex transaction limits.",
    );
    process.exit(1);
  }
  const estimatedManifestBytes = estimateManifestBytes(files, deploymentId);
  if (estimatedManifestBytes > MAX_MANIFEST_SERIALIZED_BYTES) {
    console.error(
      `Error: asset manifest metadata is approximately ${estimatedManifestBytes} bytes; the supported maximum is ${MAX_MANIFEST_SERIALIZED_BYTES}.`,
    );
    console.error(
      "Shorten emitted asset paths or reduce the number of files so publication stays within Convex transaction byte limits.",
    );
    process.exit(1);
  }

  await cleanUpAbandonedUploads(componentName, args.cdnDeleteFunction);

  const envLabel = useProd ? "production" : "development";
  console.log(`🚀 Deploying to ${envLabel} environment`);
  if (useCdn) {
    console.log("☁️  CDN mode: non-HTML assets will be uploaded to convex-fs");
  }
  console.log("🔒 Using secure internal functions (requires Convex CLI auth)");
  console.log(
    `Uploading ${files.length} files with deployment ID: ${deploymentId}`,
  );
  console.log(`Component: ${componentName}`);
  console.log("");

  const publishResult = await uploadWithConcurrency(
    files,
    componentName,
    deploymentId,
    useCdn,
    cdnUploadBase,
    args.concurrency,
    args.spaFallback,
    args.cdnDeleteFunction,
  );

  console.log("");

  let deletedCount = publishResult.deleted;
  try {
    // Publish queues only IDs from the old live manifest. Deleting that queue
    // cannot race with files from another uploader that are not staged yet.
    deletedCount += await cleanUpPendingStorage(componentName);
  } catch (cleanupError) {
    console.warn(
      "Warning: The new deployment is live, but old component storage could not be fully removed: " +
        errorMessage(cleanupError),
    );
  }

  if (deletedCount > 0) {
    console.log(
      `Cleaned up ${deletedCount} old storage file(s) from previous deployments`,
    );
  }

  // Old CDN IDs are persisted by the component until the app-level delete
  // function succeeds, including when the publish response was lost.
  if (args.cdnDeleteFunction) {
    try {
      const cleaned = await cleanUpPendingCdnBlobs(
        componentName,
        args.cdnDeleteFunction,
      );
      if (cleaned > 0) {
        console.log(
          `Cleaned up ${cleaned} old CDN blob(s) from previous deployments`,
        );
      }
    } catch (error) {
      console.warn(
        "Warning: Could not delete old CDN blobs via " +
          args.cdnDeleteFunction +
          ": " +
          errorMessage(error),
      );
    }
  } else if (publishResult.pendingBlobCleanup > 0) {
    console.log(
      `${publishResult.pendingBlobCleanup} CDN blob(s) are pending cleanup. Pass --cdn-delete-function to delete them.`,
    );
  }

  console.log("");
  console.log("✨ Upload complete!");

  console.log("");
  console.log(`Your app is now available at: ${componentSiteUrl}`);
}

main().catch((error) => {
  console.error("Upload failed:", error);
  process.exit(1);
});
