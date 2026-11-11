# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

A Convex component that enables hosting static React/Vite apps using Convex HTTP
actions and file storage. Published as `@convex-dev/static-hosting` on npm.

## Commands

```bash
# Development
npm run dev              # Run backend + example frontend concurrently
npm run build            # Build TypeScript to dist/
npm run build:codegen    # Run Convex codegen + build

# Testing
npm run test             # Run vitest with typechecking
npm run test:watch       # Watch mode
vitest run src/component/lib.test.ts  # Run single test file

# Quality
npm run lint             # ESLint
npm run typecheck        # TypeScript checking (root + example + example/convex)

# Release
npm run alpha            # Publish alpha version
npm run release          # Publish patch version
```

## Architecture

```
src/
├── cli/                 # CLI commands (setup, deploy, upload)
│   └── index.ts         # Entry point - routes to subcommands
├── client/              # Client library exposed via package exports
│   └── index.ts         # registerStaticRoutes, exposeUploadApi, exposeDeploymentQuery, etc.
├── component/           # Convex component code
│   ├── convex.config.ts # Component definition
│   ├── schema.ts        # Database schema (assets, deploymentInfo tables)
│   └── lib.ts           # Component queries/mutations
├── react/               # React hooks and components
│   └── index.tsx        # UpdateBanner, useDeploymentUpdates
└── test.ts              # Test utilities
```

### Package Exports

- `@convex-dev/static-hosting` - Client APIs (registerStaticRoutes,
  exposeUploadApi, etc.)
- `@convex-dev/static-hosting/react` - React components (UpdateBanner,
  useDeploymentUpdates)
- `@convex-dev/static-hosting/convex.config` - Component config for app.use()

### Deployment Mode

- **Convex Storage** - Files in Convex storage served via HTTP actions

## Convex Patterns

This project uses Convex components. Key patterns:

- Component functions in `src/component/` are internal to the component
- Client APIs in `src/client/` use `*Generic` helpers (e.g.,
  `httpActionGeneric`, `internalMutationGeneric`) to create functions that work
  with the component
- The `exposeUploadApi()` returns **internal** functions (only callable via
  `npx convex run`)

When working with Convex code, follow the patterns in
`.cursor/rules/convex_rules.mdc`:

- Always include argument and return validators
- Use `v.null()` for functions that don't return values
- Use `internalQuery`/`internalMutation`/`internalAction` for non-public
  functions

## Example App

The `example/` directory contains a working Vite + React app demonstrating
integration:

- `example/convex/convex.config.ts` - Registers the component
- `example/convex/http.ts` - Serves static files (Convex Storage mode)
- `example/convex/staticHosting.ts` - Exposes upload API and deployment query
