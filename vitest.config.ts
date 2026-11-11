import { defineConfig } from 'vitest/config';

// Vite 5 does not recognise `node:sqlite` as a builtin and strips the prefix, so serve it
// through a virtual module that loads the real builtin via createRequire.
const VIRTUAL = '\0node-sqlite';

export default defineConfig({
  plugins: [
    {
      name: 'node-sqlite',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:sqlite') return VIRTUAL;
      },
      load(id) {
        if (id === VIRTUAL) {
          return `import { createRequire } from 'node:module';
const m = createRequire(import.meta.url)('node:sqlite');
export const DatabaseSync = m.DatabaseSync;
export const StatementSync = m.StatementSync;
export default m;`;
        }
      },
    },
  ],
});
