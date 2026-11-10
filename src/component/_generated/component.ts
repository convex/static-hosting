/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      getCurrentDeployment: FunctionReference<
        "query",
        "internal",
        {},
        {
          _creationTime: number;
          _id: string;
          currentDeploymentId: string;
          deployedAt: number;
          pendingBlobCleanupCount?: number;
          spaFallback?: boolean;
        } | null,
        Name
      >;
      resolveAssetForHttp: FunctionReference<
        "query",
        "internal",
        { path: string; spaFallback?: boolean },
        {
          appStorageId?: string;
          blobId?: string;
          contentType: string;
          etag?: string;
          size?: number;
          storageUrl?: string;
        } | null,
        Name
      >;
    };
  };
