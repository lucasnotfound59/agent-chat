import { defineWorkspace } from 'vitest/config';

// Every package gets the same setup file, which makes it impossible for a test to reach a real
// agent CLI, the user's global configs, the keychain or a browser (see test/guard.ts).
const setupFiles = ['test/guard.ts'];

export default defineWorkspace([
  { extends: './vitest.config.ts', test: { name: 'mcp', include: ['packages/mcp/**/*.test.ts'], setupFiles } },
  { extends: './vitest.config.ts', test: { name: 'others', include: ['packages/{adapters,hub}/**/*.test.ts'], setupFiles } },
  {
    extends: './vitest.config.ts',
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      include: ['packages/web/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: [...setupFiles, 'packages/web/test/setup.ts'],
    },
  },
]);
