# Integration Guide: @convex-dev/static-hosting

This guide walks you through hosting a static React/Vite app on Convex using the
`@convex-dev/static-hosting` component. Your frontend ends up at
`https://<deployment>.convex.site`, served alongside your Convex backend with
SPA routing and smart caching.

## What this component gives you

- A drop-in HTTP handler that serves your static files from Convex storage
- One CLI command (`deploy`) that builds, deploys the backend, and uploads files
- SPA fallback to `index.html` for client-side routing
- Long-term cache headers on hashed assets and ETag-based revalidation on HTML
- Optional live-reload notifications when a new deploy ships
- Authenticated uploads via the Convex CLI (no public upload endpoint)

## Quick Start

```bash
npm install @convex-dev/static-hosting
npx @convex-dev/static-hosting setup
```

For a new app, the setup script:

- Adds the component to `convex/convex.config.ts`
- Adds a `deploy` script to `package.json`

It preserves an existing `convex/convex.config.ts` or `deploy` script. Complete
any manual edits it prints, and confirm the existing script invokes
`@convex-dev/static-hosting deploy`. Otherwise run the package command directly
or add a separate static-hosting deploy script.

Then:

```bash
npm run deploy
```

## Manual Setup

### `convex/convex.config.ts`

The default setup mounts the component's HTTP handler at the root and moves
app-owned routes under `/api`.

```typescript
import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// Serve your own HTTP endpoints (convex/http.ts) under /api so the static
// site can own the root.
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
```

This is the fastest serving mode because the component reads its storage
directly. It is appropriate for new apps and apps whose HTTP routes can live
under `/api`.

If existing webhook, auth, or API routes must stay at the root, use
[App-owned root routing](#app-owned-root-routing). To host the static site under
a sub-path, see [Mounting under a sub-path](#mounting-under-a-sub-path).

> Run `npx convex dev` after editing `convex.config.ts` so codegen picks up the
> component.

### App-owned root routing

Keep the app in control of `convex/http.ts` when changing existing route URLs
would break clients or third-party callbacks.

`convex/convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();
app.use(staticHosting); // no httpPrefix

export default app;
```

`convex/http.ts`:

```typescript
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Keep existing exact routes at their current URLs.
// auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

export default http;
```

Exact routes win over the static catch-all. Uploads, deployment metadata, SPA
configuration, and file storage remain inside the component, so you can remove
the old `exposeUploadApi` wrappers. During a same-name 0.1.x→0.2.x migration
this mode also keeps serving your existing v1 files from app storage until the
first 0.2.x upload, so the live site never drops to the setup page. This
compatibility mode adds an internal query and storage fetch on uncached
requests. Use the component-owned handler when preserving root-level app routes
is not necessary.

### `package.json`

```json
{
  "scripts": {
    "deploy": "npx @convex-dev/static-hosting deploy"
  }
}
```

## Deployment

```bash
# First time
npx convex login

# Build + backend deploy + upload static files
npx @convex-dev/static-hosting deploy
```

Two-step alternative:

```bash
npx convex deploy
npx @convex-dev/static-hosting upload --build --prod
```

Your app is live at `https://<deployment>.convex.site`.

## Development workflow

Do not use uploaded static files as the main development loop. Run the normal
frontend dev server alongside Convex:

```bash
npx convex dev
npm run dev
```

Vite keeps HMR, source maps, and transient UI state intact. Agent-written code
does not change that tradeoff. HMR may matter less while code is being produced,
but it still matters when a person verifies visuals and debugs interactions.

Use the hosted development deployment as a smoke-test target before release:

```bash
npx @convex-dev/static-hosting upload --build
```

That catches differences in HTTP routing, cache headers, SPA fallback, and base
paths. Production remains the one-command `deploy` flow.

## Live reload banner (optional)

Show users a banner when a new version is deployed:

### `convex/staticHosting.ts`

```typescript
import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
```

### Frontend

```tsx
import { UpdateBanner } from "@convex-dev/static-hosting/react";

function App() {
  return (
    <>
      <UpdateBanner message="New version available!" buttonText="Reload" />
      {/* rest of app */}
    </>
  );
}
```

`UpdateBanner` resolves `api.staticHosting.getCurrentDeployment` by default. To
re-export the query under a different module, pass the reference explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getCurrentDeployment={api.myModule.getCurrentDeployment} />;
```

For custom UI, use the hook:

```tsx
import { useDeploymentUpdates } from "@convex-dev/static-hosting/react";

const { updateAvailable, reload, dismiss } = useDeploymentUpdates();
```

## Legacy CDN mode

Do not use `--cdn` for a new integration. It targets an older, unauthenticated
`convex-fs` HTTP API. Current ConvexFS releases require app-owned routes and
upload authentication, which this CLI does not yet provide.

Existing deployments that already expose the legacy routes can keep using the
flag during migration, but they must use app-owned root compatibility mode.
`/fs/upload` and `/fs/blobs/*` are app routes, so component-owned root mode
would break both upload and serving. Everyone else should use the default Convex
storage mode. Supporting current ConvexFS properly needs a separate
authenticated upload and garbage-collection design, not a copy-paste
configuration snippet.

The CLI uploads every file before atomically publishing the mixed storage/CDN
manifest and deployment settings while queuing exact old-file IDs for bounded
follow-up cleanup. New HTML does not point at asset records that are still
missing, and a failed publish leaves the previous deployment live. Failure
cleanup removes new files only after it can prove publication did not win the
transaction race; otherwise later maintenance recovers them. Failed legacy CDN
uploads can only be cleaned automatically when `--cdn-delete-function` is
configured. Old CDN IDs are kept in a private cleanup queue until that function
succeeds, so a lost publish response does not make them unrecoverable.

## Non-Vite bundlers

The `deploy` build step and `upload --build` set `VITE_CONVEX_URL`,
`VITE_CONVEX_SITE_URL`, and `STATIC_HOSTING_BASE_PATH`. To forward them to other
env vars (Expo, Next.js, etc.), wrap your build script:

```text
Expo build script:
EXPO_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$EXPO_PUBLIC_CONVEX_URL} npx expo export --platform web

Next.js build script:
NEXT_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$NEXT_PUBLIC_CONVEX_URL} next build
```

## Security

Upload functions are **internal** to the component. They can only be called via:

- `npx convex run` (requires Convex CLI authentication)
- Other Convex functions (server-side only)

This means unauthorized users cannot upload files, even if they know your Convex
URL.

## CLI Reference

```bash
npx @convex-dev/static-hosting setup
  # Adds the component to convex.config.ts and a deploy script to package.json.

npx @convex-dev/static-hosting deploy [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: staticHosting)
      --skip-build          Skip the build step
      --skip-convex         Skip Convex backend deployment
      --build-command <cmd> Build command to run (default: 'npm run build')
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Upload non-HTML assets to convex-fs CDN
      --cdn-delete-function App function path that deletes CDN blobs

npx @convex-dev/static-hosting upload [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: staticHosting)
      --prod                Deploy to production deployment
  -b, --build               Run 'npm run build' with VITE_CONVEX_URL set
      --build-command <cmd> Override the build command; implies --build
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Upload non-HTML assets to convex-fs CDN
      --cdn-delete-function App function path that deletes CDN blobs
  -j, --concurrency <n>     Parallel upload workers (default: 5)
```

The complete manifest is staged in small, portable command-line chunks after all
uploads finish. One final mutation atomically publishes the manifest and
deployment settings. Old component storage is removed immediately afterward in
bounded cleanup transactions. A failed attempt leaves the previous deployment
live and removes only new files that are not referenced by the live manifest.
The supported maximum is 1,800 files and 2 MiB of serialized manifest metadata,
which keeps the atomic switch below Convex transaction limits. Upload URLs are
generated in bounded batches. Later uploads recover component files and staging
records left unreferenced for more than 24 hours after an interrupted CLI.

Convex HTTP routers currently expose GET but not HEAD routes. Uptime monitors
must use a lightweight GET request.

## Mounting under a sub-path

To mount under `/app/` (for example, if you have other HTTP routes at the root):

```typescript
app.use(staticHosting, { httpPrefix: "/app/" });
```

The bundler also needs to know the base path so the emitted HTML references the
right URLs. The CLI sets a `STATIC_HOSTING_BASE_PATH` env var matching the
component's mount when it runs your build, so `vite.config.ts` can read it:

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.STATIC_HOSTING_BASE_PATH ?? "/",
});
```

Root-mounted apps don't need this; the default is `/`. Webpack/Next.js
equivalents: `publicPath` and `assetPrefix`.

## SPA routing

Requests for an extension-less path that doesn't match an uploaded file fall
back to `index.html`, so client-side routes survive a reload. Paths with an
extension (e.g. `/missing.js`) always 404 when not found. To turn the fallback
off for a multi-page app (unknown paths become real 404s), deploy with
`--no-spa`:

```bash
npx @convex-dev/static-hosting deploy --no-spa
# or: npx @convex-dev/static-hosting upload --no-spa
```

The flag is stored on the deployment record (the `deploymentInfo` table), so the
serving behavior travels with the code you ship rather than living in a separate
env var. Re-deploy without `--no-spa` or with `--spa` to turn it back on.

## Upgrading from 0.1.x

0.2.0 is a **storage-breaking change**. Every existing app must remove its
`exposeUploadApi` wrappers, choose a root-routing mode, regenerate the component
API, and upload its assets again. The old app-storage blobs also need an
explicit cleanup after the rollback window; component-private storage cannot
delete them automatically. The current v1 manifest is only a lower bound because
older v1 uploads may already have left historical blobs in app storage.

Read the dedicated [0.1.x to 0.2.x migration guide](./MIGRATION.md) before
upgrading. It includes both routing options, component-name and CLI changes,
development verification, rollback steps, and a staged production cutover that
avoids an asset-less window. It also shows how to audit app storage without
mistaking unrelated application uploads for static-hosting files.

## Troubleshooting

### 404s on every path

Run `npx convex dev` (or `npx convex deploy`) after adding the component. In
component-owned mode, verify its `httpPrefix`. In app-owned mode, verify that
`registerStaticRoutes` is called from `convex/http.ts` and the component itself
has no `httpPrefix`.

### Wrong `VITE_CONVEX_URL` in the built bundle

```bash
# Right: CLI sets VITE_CONVEX_URL for the target deployment
npx @convex-dev/static-hosting deploy

# Wrong: uses VITE_CONVEX_URL from .env.local
npm run build && npx @convex-dev/static-hosting upload --prod
```

### "Cannot find module convex.config"

Make sure you've installed the package and it's listed in `package.json`:

```bash
npm install @convex-dev/static-hosting
```

### Component name mismatch

If you've renamed the component instance with
`app.use(staticHosting, { name: "custom" })`, pass it to the CLI and replace
every generated `components.staticHosting` reference with `components.custom`:

```bash
npx @convex-dev/static-hosting upload --component custom
```

## API Reference

### `registerStaticRoutes(http, component, options?)`

Registers a static catch-all in the app's `convex/http.ts`. Use it when exact
app routes must remain at the same root. `pathPrefix`, `spaFallback`, and
`cdnBaseUrl` are supported. The component must be installed without an
`httpPrefix` so only the app owns that URL space.

### `exposeDeploymentQuery(component)`

Returns `{ getCurrentDeployment }`: a public query that wraps the component's
deployment singleton. Add this only if you use `<UpdateBanner />` or
`useDeploymentUpdates`.

### `getConvexUrl()`

Browser-only. Returns `https://<deployment>.convex.cloud` when the page is
served from `<deployment>.convex.site`.

## Additional Resources

- [README.md](./README.md)
- [0.1.x to 0.2.x migration guide](./MIGRATION.md)
- [`example/`](./example): Working example app
- [Component source](./src/component)
