# Convex Static Hosting

[![npm version](https://badge.fury.io/js/@convex-dev%2Fstatic-hosting.svg)](https://badge.fury.io/js/@convex-dev/static-hosting)

A Convex component for hosting static React/Vite apps directly on Convex: no
separate hosting provider, no DNS to wire up, no second deploy target. Run one
command and your frontend is live at `https://<deployment>.convex.site`
alongside your backend.

## Features

- 🚀 **One-command deploy:** build, push backend, and upload static files in a
  single step.
- 🔄 **SPA routing:** paths without an extension fall back to `index.html`.
- ⚡ **Smart caching:** static files are cached for speed, with safe updates
  when a new version is deployed.
- 🔔 **Deployment update notifications:** show connected users a prompt when a
  new version is ready.
- 🔒 **Authenticated uploads:** uploads go through the Convex CLI's
  authenticated session; there's no public upload endpoint.
- 🧹 **Automatic cleanup:** files from previous 0.2.x deployments are garbage
  collected on every deploy. The migration guide covers one-time v1 cleanup.

https://github.com/user-attachments/assets/5eaf781f-87da-4292-9f96-38070c86cd39

[![Share your slop with the Static Hosting Component!](https://thumbs.video-to-markdown.com/d5a10c30.jpg)](https://youtu.be/RNjTys_2OX4)

## Quick Start

> **Upgrading an existing 0.1.x app?** This is not a package-only update. Point
> your coding agent at the [0.1.x to 0.2.x migration guide](./MIGRATION.md)
> before it changes anything. The guide covers the storage-breaking re-upload,
> preserving auth and webhook URLs, historical v1 blob auditing, deployment
> sequencing, and verification.

```bash
npm install @convex-dev/static-hosting
npx @convex-dev/static-hosting setup
```

For a new setup, the command adds the component to `convex/convex.config.ts` and
creates a `deploy` script in `package.json`. It does not overwrite an existing
Convex config or `deploy` script. Complete any manual edits printed by the
command, and confirm that `npm run deploy` invokes this package before running:

```bash
npm run deploy
```

Your app is live at `https://<deployment>.convex.site`.

## Setup

### 1. Install

```bash
npm install @convex-dev/static-hosting
```

### 2. Register the component

`convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// Your own HTTP endpoints (convex/http.ts) are served under /api so the
// static site can own the root.
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
```

This is the fastest serving mode. The component owns `/`, while your app's
`convex/http.ts` routes move under `/api/...`.

If existing callbacks or auth routes must stay at the root, use
[app-owned root routing](#keep-existing-http-routes-at-the-root). To host the
site under a sub-path, see
[Mounting under a sub-path](#mounting-under-a-sub-path).

### 3. Add a deploy script

```json
{
  "scripts": {
    "deploy": "npx @convex-dev/static-hosting deploy"
  }
}
```

That's it.

### Keep existing HTTP routes at the root

Do not move stable webhook, auth, or API URLs just to add static hosting. Leave
the component's HTTP routes unmounted and register the static catch-all in your
existing router.

`convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();
app.use(staticHosting); // no httpPrefix

export default app;
```

`convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Register exact app routes first. Existing auth/webhook helpers can stay here.
// auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

export default http;
```

Exact routes win over the static catch-all, so existing URLs keep working. The
component still owns uploads, deployment state, and file storage. This mode adds
an internal query and storage fetch on an uncached request, so prefer the
component-owned mode when you do not need root-level app routes.

### Using non-Vite bundlers

The `deploy` build step and `upload --build` set `VITE_CONVEX_URL`,
`VITE_CONVEX_SITE_URL`, and `STATIC_HOSTING_BASE_PATH`. For bundlers that use
different environment variable conventions, wrap your build script to pass
through the values you need:

**For Expo:**

```json
{
  "scripts": {
    "build": "EXPO_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$EXPO_PUBLIC_CONVEX_URL} npx expo export --platform web"
  }
}
```

**For Next.js:**

```json
{
  "scripts": {
    "build": "NEXT_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$NEXT_PUBLIC_CONVEX_URL} next build"
  }
}
```

The pattern `${VITE_CONVEX_URL:-$VAR}` uses `VITE_CONVEX_URL` if set by the CLI
and otherwise falls back to your bundler-specific variable. This keeps both the
CLI-driven build and standalone `npm run build` working.

## Deployment

Deploy both Convex backend and static files with a single command:

```bash
npx convex login           # first time only
npx @convex-dev/static-hosting deploy
```

The `deploy` command:

1. Builds your frontend with the production `VITE_CONVEX_URL`.
2. Deploys the Convex backend.
3. Uploads `dist/` to Convex.

For more control, you can run the two halves separately:

```bash
npx convex deploy
npx @convex-dev/static-hosting upload --build --prod
```

Your app is live at `https://<deployment>.convex.site`.

## Development workflow

Use your normal frontend dev server during development:

```bash
# Terminal 1
npx convex dev

# Terminal 2
npm run dev
```

For Vite, that keeps HMR and fast local feedback. Static hosting is the deploy
target, not a replacement dev server. Uploading every edit to a development
deployment is slower and loses HMR, even when an agent writes most of the code.
Humans still need the quick loop for visual checks, transient UI state, and
debugging.

Before release, run one hosted smoke test against the development deployment:

```bash
npx @convex-dev/static-hosting upload --build
```

Then use `deploy` for production. This split keeps the dev loop fast while still
testing the real HTTP, caching, base-path, and SPA behavior before shipping.

## CLI options

```bash
npx @convex-dev/static-hosting deploy [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: staticHosting)
      --skip-build          Skip the build step (use existing dist)
      --skip-convex         Skip Convex backend deployment
      --build-command <cmd> Build command to run (default: 'npm run build')
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Use the legacy convex-fs integration
      --cdn-delete-function Legacy app function that deletes CDN blobs

npx @convex-dev/static-hosting upload [options]
  -d, --dist <path>         Path to dist directory (default: ./dist)
  -c, --component <name>    Component instance name (default: staticHosting)
      --prod                Deploy to production deployment
  -b, --build               Run 'npm run build' with VITE_CONVEX_URL set
      --build-command <cmd> Override the build command; implies --build
      --no-spa              Disable SPA fallback (404 instead of /index.html)
      --spa                 Enable SPA fallback (default)
      --cdn                 Use the legacy convex-fs integration
      --cdn-delete-function Legacy app function that deletes CDN blobs
  -j, --concurrency <n>     Parallel upload workers (default: 5)
```

Each upload is published atomically, so visitors never see a page that refers to
assets that are not available yet. Failed uploads leave the previous deployment
live, and old files are cleaned up safely. See
[INTEGRATION.md](./INTEGRATION.md) for upload limits and lifecycle details.

Convex HTTP routes currently support GET but not HEAD. Configure uptime checks
to make a lightweight GET request rather than a HEAD request.

If you mount the component under a different name with
`app.use(staticHosting, { name: "custom" })`, pass `--component custom` and
replace every generated `components.staticHosting` reference with
`components.custom`.

Do not use `--cdn` for a new integration. It targets an older ConvexFS HTTP API
and is retained only for existing deployments. Legacy CDN users must keep
app-owned root routing because `/fs/upload` and `/fs/blobs/*` are root app
routes. See `INTEGRATION.md` for the current limitation.

## Security

The upload API uses **internal functions** in the Component that can only be
called via:

- `npx convex run` (requires Convex CLI authentication)
- Other Convex functions in the Component (server-side only)

This means unauthorized users **cannot** upload files to your site, even if they
know your Convex URL.

## Reload prompt after deploy (optional)

If you want a banner that prompts users to reload when a new deployment ships,
expose the deployment query in your app and drop in `<UpdateBanner />`:

`convex/staticHosting.ts`:

```ts
import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
```

`src/App.tsx`:

```tsx
import { UpdateBanner } from "@convex-dev/static-hosting/react";

function App() {
  return (
    <>
      <UpdateBanner message="New version!" buttonText="Reload" />
      {/* ... */}
    </>
  );
}
```

`UpdateBanner` resolves `api.staticHosting.getCurrentDeployment` automatically.
If you re-export the query under a different module name, pass it explicitly:

```tsx
import { api } from "../convex/_generated/api";
<UpdateBanner getCurrentDeployment={api.myModule.getCurrentDeployment} />;
```

For custom UI, use the hook:

```tsx
import { useDeploymentUpdates } from "@convex-dev/static-hosting/react";

const { updateAvailable, reload, dismiss } = useDeploymentUpdates();
```

## Mounting under a sub-path

Mount the static site under a sub-path if you have other routes at the root:

```ts
app.use(staticHosting, { httpPrefix: "/app/" });
```

You'll also need to tell your bundler about the base path so the emitted HTML
references the right URLs. The CLI sets a `STATIC_HOSTING_BASE_PATH` env var
matching the component's mount when it runs your build, so `vite.config.ts` can
read it directly:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.STATIC_HOSTING_BASE_PATH ?? "/",
});
```

Root-mounted apps don't need this; the default is `/`. For webpack use
`publicPath`, for Next.js `assetPrefix`.

## SPA routing

By default, requests for a path with no file extension that doesn't match an
uploaded file fall back to `index.html`, so client-side routes like
`/dashboard/settings` work on reload. For a multi-page app where unknown paths
should be a real 404, deploy with `--no-spa`:

```bash
npx @convex-dev/static-hosting deploy --no-spa
```

The setting is stored with the deployment, so it travels with the code you ship
rather than living in a separate env var. Requests for paths with an extension
(e.g. `/missing.js`) always 404 when not found, regardless of this setting.

## Upgrading from 0.1.x

0.2.0 moves uploads and file storage into the component. You must remove the
`exposeUploadApi` re-exports from `convex/staticHosting.ts` and **redeploy your
assets** because 0.1.x files lived in the app's storage. Capture both the
current v1 manifest and a broader app-storage inventory first: older v1 uploads
may have left static blobs that the current manifest no longer lists.

You can then choose either serving mode:

- If the static site can own `/`, mount the component there and remove the old
  `registerStaticRoutes` call.
- If existing HTTP routes must stay at `/`, keep `convex/http.ts` and its
  `registerStaticRoutes` call. The 0.2 implementation reads the new
  component-owned files without changing those route URLs.

See the dedicated [0.1.x to 0.2.x migration guide](./MIGRATION.md) for exact
steps, verification, rollback, and the optional staged cutover.

## How it works

1. **Build:** your bundler emits `dist/`.
2. **Upload:** the CLI uses your authenticated Convex session to generate signed
   upload URLs, push files to Convex storage, record metadata, and GC old
   deployments.
3. **Serve:** an HTTP action looks up the requested path, streams the file with
   the right `Content-Type`, applies long-term caching for hashed assets, and
   falls back to `index.html` for SPA routes.

## Example

See [`example/`](./example) for a complete Vite + React app.

```bash
npm install
npm run dev
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0
