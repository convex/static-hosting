---
"@convex-dev/static-hosting": patch
---

- An app-supplied `404.html` at the site root is served with status 404 for
  misses, under SPA fallback for paths with an extension and under `--no-spa`
  for every miss. Without it, misses keep the plain-text 404.
- Docs: `--no-spa` is now recommended for multi-page and content sites, such as
  podcast audio and Markdown transcripts, where unknown URLs should 404.

- Serve audio, video, and Markdown assets with the corrected MIME types.
- Return the registered component API from the `/test` helper.
