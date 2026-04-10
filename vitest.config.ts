// Scope vitest to src/ so it does not also pick up the compiled test files
// that land in dist/ after `pnpm build`. Shipping compiled tests in the npm
// package is fine (see the npm-package skill), but running them twice in CI
// is wasteful and confusing.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
