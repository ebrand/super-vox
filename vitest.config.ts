import { defineConfig } from 'vitest/config';

// Resolve @super-vox/* packages to their TypeScript sources, never to dist/.
const conditions = ['source'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
