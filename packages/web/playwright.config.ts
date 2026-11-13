import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const PORT = 4399;

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: 'chromium' },
  webServer: {
    command: 'npx tsx ../hub/scripts/e2e-hub.ts',
    cwd: here,
    url: `http://127.0.0.1:${PORT}/`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
