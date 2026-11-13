// Suite-level guard for every package: nothing in these tests may reach the user's real agent
// CLIs, global configs or keychain. Runs before every test file (see vitest.workspace.ts).
// Background: a TDD red run once executed the real `opencode mcp add --global` and edited the
// user's ~/.config/opencode/opencode.json, because only packages/mcp had this guard.
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
// `security` is the macOS keychain CLI the hub's token store shells out to.
for (const name of ['codex', 'claude', 'opencode', 'dsh', 'security']) {
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
