// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Standalone vitest config for the Solid integration modules (`app/solid/**`).
//
// Elk's root vitest config boots the full Nuxt test environment (heavy, browser-bound).
// The Solid integration is plain TypeScript with no Nuxt/Vue runtime in the units under
// test, so it runs far faster + more reliably in a bare `node` environment. This config
// is SCOPED to `app/solid/**/*.test.ts` and is what the Solid integration gate runs:
//   npx vitest run --config app/solid/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'solid',
    environment: 'node',
    include: ['app/solid/**/*.test.ts'],
    globals: false,
  },
})
