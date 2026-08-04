import { defineConfig } from '@playwright/test';

// Browser tests are `*.spec.mjs`. Unit tests are `*.test.mjs` and run under
// node:test, so keep the two runners from collecting each other's files.
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.mjs',
});
