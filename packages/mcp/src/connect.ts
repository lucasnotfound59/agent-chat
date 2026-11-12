import { execFile } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Target = 'codex' | 'claude' | 'opencode' | 'dsh';
export interface Step {
  target: Target;
  description: string;
  run: () => Promise<void> | void;
  display: string;
}
/** Runs one external command; rejects with the command's own message when it fails. */
export type Exec = (file: string, args: string[]) => Promise<void>;
export interface PlanOptions {
  targets: Target[];
  repoRoot: string;
  home: string;
  nodePath: string;
  dshProfiles: string[];
  exec?: Exec;
}

const NAME = 'agent-chat';
const TOOL_TIMEOUT_SEC = 600;
const START = `# >>> ${NAME}`;
const END = `# <<< ${NAME}`;

export const ALL_TARGETS: Target[] = ['codex', 'claude', 'opencode', 'dsh'];

const defaultExec: Exec = (file, args) =>
  new Promise((ok, fail) => {
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (!err) return ok();
      fail(new Error(String(stderr || stdout || err.message).trim() || err.message));
    });
  });

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
const shellJoin = (parts: string[]) => parts.map(shellQuote).join(' ');

/** `<node> --import <tsx loader> <main.ts> --as <target>`: no npx, no PATH lookup. */
function serverCommand(o: PlanOptions, target: Target): string[] {
  const loader = pathToFileURL(join(o.repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
  return [o.nodePath, '--import', loader, join(o.repoRoot, 'packages/mcp/src/main.ts'), '--as', target];
}

const codexConfig = (home: string) => join(home, '.codex/config.toml');
const dshFile = (home: string, profile: string) => join(home, '.dsh/profiles', profile, 'cordis.patch.yml');

function commandStep(
  target: Target,
  description: string,
  file: string,
  args: string[],
  exec: Exec,
  displayArgs: string[] = args,
): Step {
  return { target, description, display: shellJoin([file, ...displayArgs]), run: () => exec(file, args) };
}

export function planConnect(o: PlanOptions): Step[] {
  const exec = o.exec ?? defaultExec;
  const steps: Step[] = [];
  for (const target of o.targets) {
    const cmd = serverCommand(o, target);
    if (target === 'codex') {
      steps.push(
        commandStep('codex', `register "${NAME}" with Codex (codex writes ${codexConfig(o.home)})`, 'codex', ['mcp', 'add', NAME, '--', ...cmd], exec),
        {
          target,
          description: `set the tool timeout to ${TOOL_TIMEOUT_SEC}s for "${NAME}" (edits only the [mcp_servers.${NAME}] table; \`codex mcp add\` has no timeout option)`,
          display: `set tool_timeout_sec = ${TOOL_TIMEOUT_SEC} in [mcp_servers.${NAME}] of ${codexConfig(o.home)}`,
          run: () => {
            const file = codexConfig(o.home);
            writeFileSync(file, setCodexToolTimeout(readFileSync(file, 'utf8'), NAME, TOOL_TIMEOUT_SEC));
          },
        },
      );
    } else if (target === 'claude') {
      // MCP_TOOL_TIMEOUT is read from Claude Code's own environment, not from a server's `-e` env, so
      // passing it with -e would not change the call timeout; it is deliberately not passed.
      steps.push(
        commandStep(
          'claude',
          `register "${NAME}" with Claude Code at user scope (claude writes ~/.claude.json; the call timeout is a global Claude Code setting, MCP_TOOL_TIMEOUT, and is not changed)`,
          'claude',
          ['mcp', 'add', '-s', 'user', NAME, '--', ...cmd],
          exec,
        ),
      );
    } else if (target === 'opencode') {
      steps.push(
        commandStep(
          'opencode',
          `register "${NAME}" with OpenCode in its global config (opencode writes ~/.config/opencode; \`opencode mcp add\` has no timeout option)`,
          'opencode',
          ['mcp', 'add', '--global', NAME, '--', ...cmd],
          exec,
        ),
      );
    } else {
      for (const profile of o.dshProfiles) {
        const file = dshFile(o.home, profile);
        steps.push({
          target,
          description: `add the "${NAME}" block to DSH profile "${profile}" (edits ${file}; original saved once as ${file}.agent-chat.bak)`,
          display: `insert the ${NAME} block into ${file} (backup: ${file}.agent-chat.bak)`,
          run: () => {
            if (!existsSync(file)) throw new Error(`${file} does not exist`);
            const bak = `${file}.agent-chat.bak`;
            if (!existsSync(bak)) copyFileSync(file, bak);
            writeFileSync(file, upsertDshEntry(readFileSync(file, 'utf8'), dshEntry(cmd)));
          },
        });
      }
    }
  }
  return steps;
}

export function planDisconnect(o: PlanOptions): Step[] {
  const exec = o.exec ?? defaultExec;
  const steps: Step[] = [];
  for (const target of o.targets) {
    if (target === 'codex') {
      steps.push(commandStep('codex', `remove "${NAME}" from Codex (codex edits ${codexConfig(o.home)})`, 'codex', ['mcp', 'remove', NAME], exec));
    } else if (target === 'claude') {
      steps.push(commandStep('claude', `remove "${NAME}" from Claude Code at user scope (claude edits ~/.claude.json)`, 'claude', ['mcp', 'remove', '-s', 'user', NAME], exec));
    } else if (target === 'opencode') {
      steps.push({
        target,
        description: `OpenCode has no "mcp remove" subcommand, so nothing is changed: remove the "${NAME}" entry under "mcp" in its global config by hand`,
        display: `no change: opencode has no "mcp remove"; delete the "${NAME}" entry under "mcp" in ~/.config/opencode/opencode.json (or opencode.jsonc) by hand`,
        run: () => {},
      });
    } else {
      for (const profile of o.dshProfiles) {
        const file = dshFile(o.home, profile);
        steps.push({
          target,
          description: `remove the "${NAME}" block from DSH profile "${profile}" (edits ${file}; the .agent-chat.bak backup is kept)`,
          display: `remove the ${NAME} block from ${file}`,
          run: () => {
            if (!existsSync(file)) throw new Error(`${file} does not exist`);
            const before = readFileSync(file, 'utf8');
            const after = removeDshEntry(before);
            if (after !== before) writeFileSync(file, after);
          },
        });
      }
    }
  }
  return steps;
}

function dshEntry(cmd: string[]): string {
  const q = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
  return [
    '- id: mcp-agent-chat',
    `  name: '@deepseek-ai/dsh-mcp-client'`,
    '  config:',
    `    serverName: ${NAME}`,
    '    transport: stdio',
    `    command: ${q(cmd[0])}`,
    `    args: [${cmd.slice(1).map(q).join(', ')}]`,
    `    toolCallTimeoutMs: ${TOOL_TIMEOUT_SEC * 1000}`,
    '',
  ].join('\n');
}

/** Finds the marker block: [start of the start line, end after the end line (incl. its newline)). */
function findBlock(yaml: string): { s: number; e: number; endHadNewline: boolean } | null {
  const lines = yaml.split(/(?<=\n)/);
  let pos = 0;
  let s = -1;
  for (const line of lines) {
    const t = line.trimEnd();
    if (s < 0 && t === START) s = pos;
    else if (s >= 0 && t === END) return { s, e: pos + line.length, endHadNewline: line.endsWith('\n') };
    pos += line.length;
  }
  if (s >= 0) throw new Error(`found "${START}" without "${END}" in the DSH patch file; fix it by hand first`);
  return null;
}

/** Idempotent: replaces an existing marker block in place, otherwise appends one. `entry` is the block body. */
export function upsertDshEntry(yaml: string, entry: string): string {
  const body = entry.endsWith('\n') ? entry : `${entry}\n`;
  const found = findBlock(yaml);
  if (found) {
    const block = `${START}\n${body}${END}${found.endHadNewline ? '\n' : ''}`;
    return yaml.slice(0, found.s) + block + yaml.slice(found.e);
  }
  // A file without a final newline gets one added before the block and no newline after the end marker,
  // which is what lets removeDshEntry restore the original bytes exactly.
  const needsNl = yaml !== '' && !yaml.endsWith('\n');
  return `${yaml}${needsNl ? '\n' : ''}${START}\n${body}${END}${needsNl ? '' : '\n'}`;
}

export function removeDshEntry(yaml: string): string {
  const found = findBlock(yaml);
  if (!found) return yaml;
  const before = found.s > 0 && !found.endHadNewline && found.e === yaml.length ? yaml.slice(0, found.s - 1) : yaml.slice(0, found.s);
  return before + yaml.slice(found.e);
}

/** Sets `tool_timeout_sec` inside `[mcp_servers.<server>]` only; throws if that table does not exist. */
export function setCodexToolTimeout(toml: string, server: string, seconds: number): string {
  const lines = toml.split(/(?<=\n)/);
  const headerRe = /^\s*\[\[?\s*([A-Za-z0-9_.'" -]+?)\s*\]\]?\s*(#.*)?$/;
  const isHeader = (l: string) => /^\s*\[/.test(l) && headerRe.test(l.replace(/\r?\n$/, ''));
  const norm = (k: string) => k.replace(/["'\s]/g, '');
  const start = lines.findIndex((l) => {
    const m = headerRe.exec(l.replace(/\r?\n$/, ''));
    return !!m && /^\s*\[(?!\[)/.test(l) && norm(m[1]) === `mcp_servers.${server}`;
  });
  if (start < 0) throw new Error(`no [mcp_servers.${server}] table found; run \`codex mcp add\` first`);
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;

  const newLine = `tool_timeout_sec = ${seconds}`;
  for (let i = start + 1; i < end; i++) {
    if (/^\s*tool_timeout_sec\s*=/.test(lines[i])) {
      const eol = /\r?\n$/.exec(lines[i])?.[0] ?? '';
      if (lines[i] !== newLine + eol) lines[i] = newLine + eol;
      return lines.join('');
    }
  }
  let last = end - 1;
  while (last > start && lines[last].trim() === '') last--;
  const eol = lines[last].endsWith('\r\n') ? '\r\n' : '\n';
  if (!/\n$/.test(lines[last])) lines[last] += eol;
  lines.splice(last + 1, 0, newLine + eol);
  return lines.join('');
}

// ---------------------------------------------------------------- command line

export interface CliOptions {
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  nodePath?: string;
  home?: string;
  exec?: Exec;
  which?: (cmd: string) => boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

function onPath(cmd: string, pathVar: string | undefined): boolean {
  for (const d of (pathVar ?? '').split(delimiter)) {
    if (!d) continue;
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export async function runCli(argv: string[], cli: CliOptions = {}): Promise<number> {
  const env = cli.env ?? process.env;
  const out = cli.out ?? ((s: string) => void process.stdout.write(s));
  const err = cli.err ?? ((s: string) => void process.stderr.write(s));
  const [mode, ...rest] = argv;
  if (mode !== 'connect' && mode !== 'disconnect') {
    err('usage: connect.ts <connect|disconnect> [--apply] [codex] [claude] [opencode] [dsh]\n');
    return 2;
  }
  const apply = rest.includes('--apply');
  const named = rest.filter((a) => a !== '--apply');
  const bad = named.filter((a) => !(ALL_TARGETS as string[]).includes(a));
  if (bad.length) {
    err(`unknown argument: ${bad.join(', ')} (targets: ${ALL_TARGETS.join(', ')}; flag: --apply)\n`);
    return 2;
  }
  const requested = (named.length ? ALL_TARGETS.filter((t) => named.includes(t)) : ALL_TARGETS) as Target[];

  const fakeHome = env.AGENTCHAT_CONNECT_HOME !== undefined && env.AGENTCHAT_CONNECT_HOME !== '';
  const home = fakeHome ? (env.AGENTCHAT_CONNECT_HOME as string) : (cli.home ?? homedir());
  const repoRoot = cli.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (!cli.repoRoot && !existsSync(join(repoRoot, 'node_modules/tsx/dist/loader.mjs'))) {
    err(`tsx loader not found under ${repoRoot}/node_modules; run npm install first\n`);
    return 2;
  }
  const nodePath = cli.nodePath ?? process.execPath;
  const which = cli.which ?? ((c: string) => onPath(c, env.PATH));
  const dshProfiles = ['web', 'tui'].filter((p) => existsSync(dshFile(home, p)));

  const targets: Target[] = [];
  for (const t of requested) {
    if (t === 'dsh' ? dshProfiles.length === 0 : !which(t === 'claude' ? 'claude' : t)) {
      out(
        t === 'dsh'
          ? `[dsh] skipped: not installed (no cordis.patch.yml for profile web or tui under ${join(home, '.dsh/profiles')})\n`
          : `[${t}] skipped: not installed (\`${t}\` not found on PATH)\n`,
      );
    } else targets.push(t);
  }

  const planOpts: PlanOptions = { targets, repoRoot, home, nodePath, dshProfiles, exec: cli.exec };
  const steps = (mode === 'connect' ? planConnect : planDisconnect)(planOpts);

  out(`${mode === 'connect' ? 'Connect' : 'Disconnect'} plan (home: ${home}${fakeHome ? ', from AGENTCHAT_CONNECT_HOME' : ''})\n`);
  if (!apply) {
    steps.forEach((s, i) => out(`${i + 1}. [${s.target}] ${s.description}\n     ${s.display}\n`));
    out(`Nothing was changed. Add --apply to run the ${steps.length} step(s) above.\n`);
    return 0;
  }

  let failed = 0;
  const failedTargets = new Set<Target>();
  for (const s of steps) {
    if (fakeHome && s.target !== 'dsh') {
      out(`[${s.target}] skipped: AGENTCHAT_CONNECT_HOME is set and ${s.target}'s command would use the real home. ${s.display}\n`);
      continue;
    }
    if (failedTargets.has(s.target)) {
      out(`[${s.target}] skipped: an earlier ${s.target} step failed. ${s.display}\n`);
      continue;
    }
    out(`[${s.target}] ${s.display}\n`);
    try {
      await s.run();
      out('  ok\n');
    } catch (e) {
      failed++;
      failedTargets.add(s.target);
      out(`  FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (failed) out(`${failed} step(s) failed.\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
