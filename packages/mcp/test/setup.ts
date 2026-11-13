// Suite-level guard for packages/mcp: nothing in these tests may reach the user's real
// agent CLIs or global configs. Runs before every test file (see vitest.workspace.ts).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'agentchat-guard-'));
const shimDir = join(root, 'shims');
const log = join(root, 'shim-calls.log');
mkdirSync(shimDir);
mkdirSync(join(root, '.config'));
mkdirSync(join(root, '.codex'));
writeFileSync(log, '');
for (const name of ['codex', 'claude', 'opencode', 'dsh']) {
  const p = join(shimDir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${log}'\necho "SHIM CALLED: ${name}" >&2\nexit 97\n`);
  chmodSync(p, 0o755);
}
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, '.config');
process.env.CODEX_HOME = join(root, '.codex');
process.env.PATH = [shimDir, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter);

afterAll(() => {
  const calls = readFileSync(log, 'utf8').trim();
  if (calls !== '') throw new Error(`a test reached a real agent command (the guard shim ran):\n${calls}`);
});
