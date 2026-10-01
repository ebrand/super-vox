import { defineConfig } from 'vitest/config';

// Resolve @super-vox/* packages to their TypeScript sources, never to dist/.
const conditions = ['source'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Some terrain tests build whole worlds (about 4 s each alone); with the suite running in
    // parallel on a busy machine, 5 s (the default) isn't enough room.
    testTimeout: 20_000,
  },
});
