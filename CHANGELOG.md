# Changelog

## 0.2.1

- Smoother migration story, with more automatic fallbacks to the old component
  name.

## 0.2.0

Component-owned HTTP and storage.

**Breaking — redeploy your static assets after upgrading.**

See the [0.1.x to 0.2.x migration guide](./MIGRATION.md) before upgrading an
existing deployment.

- The component now hosts its own HTTP endpoints and owns the file storage that
  serves them. Wire it up with `app.use(staticHosting, { httpPrefix: "/" })` and
  delete related code in`convex/http.ts` + the upload-API re-exports from
  `convex/staticHosting.ts`.
- Removed `exposeUploadApi` from the client API. Uploads and file lifecycle are
  now handled by private component functions.
- `registerStaticRoutes` remains as a compatibility mode for apps that need to
  keep existing auth, webhook, or API routes at the root. It serves the new
  component-owned files from the app's existing `convex/http.ts` catch-all.
  During a same-name v1→v2 migration it also serves inherited v1 files straight
  from the app's own storage, so the live site stays up with no re-upload gap.
  Mounting the component's own handler is still the faster default.
- `exposeDeploymentQuery` and `getConvexUrl` remain if you use the UpdateBanner.
- The component is now named `staticHosting` (previously `selfHosting`). The CLI
  invokes it directly via `npx convex run --component staticHosting lib:...`. If
  you mount the component under a different name, pass
  `--component <your-name>`. For a smooth upgrade, pass {name: "selfHosting} to
  `app.use(staticHosting, { name: "selfHosting" })`
- `useDeploymentUpdates` / `UpdateBanner` use `useQuery_experimental` and
  default to `api.staticHosting.getCurrentDeployment`. If you don't surface
  deployment updates, you no longer need to expose anything.
- Assets uploaded under 0.1.x lived in the app's storage — the component-owned
  HTTP handler can't resolve those references in 0.2.x. Run
  `npx @convex-dev/static-hosting deploy` to repopulate. (In app-owned root
  routing the app-side handler keeps serving those v1 files from app storage
  until the first upload replaces them, so that mode has no asset-less window.)
  The first 0.2.x upload safely discards those legacy storage references instead
  of trying to delete them from component storage. The old blobs remain in app
  storage until you explicitly clean them up after the rollback window. Older
  0.1.x deploys may also have left historical blobs that the current asset
  manifest no longer lists, so follow the migration guide's app-storage audit
  before cleanup.
- Default setup prefixes your own HTTP routes with
  `defineApp({ httpPrefix: "/api" })` so the static site can own the root
  without the catch-all route shadowing them. Use `registerStaticRoutes` when
  those existing root route URLs cannot move.
- SPA fallback is now configurable per deployment. Deploy with `--no-spa`
  (`deploy` or `upload`) to make extension-less misses return 404 instead of
  `index.html`. The setting is stored on the deployment record, so it travels
  with the code you ship.
- Hashed-asset caching recognizes Vite's base64url hashes (including `-`) and
  numeric extensions such as `.woff2`. HTML always uses revalidation, even if
  its filename looks content-hashed.
- The `cdnBaseUrl` override remains available in `registerStaticRoutes`
  compatibility mode. Component-owned HTTP routes redirect CDN blobs to the
  deployment's own `{origin}/fs/blobs`.
- `--cdn` is now documented as a legacy option. Its setup guide targeted an old
  unauthenticated convex-fs API and does not work with current ConvexFS. New
  integrations should use Convex storage until authenticated CDN uploads are
  designed.
- Storage and legacy CDN assets, deployment settings, and old-file cleanup are
  published in one atomic mutation after all uploads finish. New HTML cannot
  race ahead of its referenced asset records, and a failed publish leaves the
  previous deployment live. Replaced CDN blob IDs are retained for cleanup.
- Upload errors now report the failing file and HTTP status. Oversized manifests
  fail with a clear size error, and newly uploaded component files are removed
  after a failed upload or publish.
- Static handlers decode percent-encoded paths, accept weak or listed ETags, and
  return a non-cacheable HTTP 503 setup page until the first upload succeeds.
- Removed the install-time console banner.

## 0.1.5

- Forward-compatibility for 0.2.x rollbacks. The `deploymentInfo` schema and the
  `getCurrentDeployment` return validator now allow the optional `spaFallback`
  (boolean) and `pendingBlobCleanupCount` (number) fields that 0.2.x writes to
  the deployment record. 0.1.5 ignores them, but allowing them means a
  deployment upgraded to 0.2.x and later rolled back to 0.1.x keeps validating.
  No behavior change for 0.1.x users; upgrade to 0.1.5 before trying 0.2.x if
  you want a clean rollback path. (0.2.x also creates additional tables such as
  `stagedAssets` and `cleanupState`; extra tables don't fail 0.1.x schema
  validation, so they need no entry here.)

## 0.1.4

- Added support for Windows

## 0.1.3

- Fix missing README in published package

## 0.1.2

- Rename package from `@convex-dev/self-hosting` to `@convex-dev/static-hosting`

## 0.1.1-alpha.0

- Add optional convex-fs CDN mode for static asset serving (`--cdn` flag)
- Non-HTML assets can be served from CDN edge network via convex-fs
- New `cdnBaseUrl` option on `registerStaticRoutes`
- Schema: `storageId` now optional, new `blobId` field for CDN assets
- `gcOldAssets` returns `{ deleted, blobIds }` (breaking change from number
  return)

## 0.1.2-alpha.1

removed cloudflare for now.

## 0.1.1

- Setup wizard now configures custom domains for Cloudflare Workers
- Added note about running `convex dev` for HTTP actions error
- Added documentation for non-Vite bundlers (Expo, Next.js)

## 0.1.0

- Migrated from Cloudflare Pages to Workers Static Assets

## 0.0.0

- Initial release.
