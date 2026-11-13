import { defineWorkspace } from 'vitest/config';

// packages/mcp gets a setup file that makes it impossible for a test to reach a real agent CLI
// or the user's global configs; the other packages are configured as before.
export default defineWorkspace([
  { extends: './vitest.config.ts', test: { name: 'mcp', include: ['packages/mcp/**/*.test.ts'], setupFiles: ['packages/mcp/test/setup.ts'] } },
  { extends: './vitest.config.ts', test: { name: 'others', include: ['packages/{adapters,hub}/**/*.test.ts'] } },
]);
