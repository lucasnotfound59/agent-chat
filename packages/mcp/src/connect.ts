import { execFile } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Target = 'codex' | 'claude' | 'opencode' | 'dsh';
export interface Step {
  target: Target;
  description: string;
  /** May return a note, printed instead of "ok" (e.g. "manual action required: ..."). */
  run: () => Promise<void | string> | void | string;
  display: string;
}
/** Runs one external command and resolves with its stdout; rejects with the command's own message when it fails. */
export type Exec = (file: string, args: string[]) => Promise<string | void>;
export interface PlanOptions {
  targets: Target[];
  repoRoot: string;
  home: string;
  nodePath: string;
  dshProfiles: string[];
  exec?: Exec;
  /** Directory holding Codex's config.toml (CODEX_HOME); defaults to <home>/.codex. */
  codexHome?: string;
}

const NAME = 'agent-chat';
const TOOL_TIMEOUT_SEC = 600;
const START = `# >>> ${NAME}`;
const END = `# <<< ${NAME}`;
const BAK = '.agent-chat.bak';

export const ALL_TARGETS: Target[] = ['codex', 'claude', 'opencode', 'dsh'];

const defaultExec: Exec = (file, args) =>
  new Promise((ok, fail) => {
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (!err) return ok(String(stdout));
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

const codexConfig = (o: PlanOptions) => join(o.codexHome ?? join(o.home, '.codex'), 'config.toml');
const dshFile = (home: string, profile: string) => join(home, '.dsh/profiles', profile, 'cordis.patch.yml');

/** Copies `file` to `<file>.agent-chat.bak` unless that backup already exists (it is never overwritten). */
function backupOnce(file: string): void {
  try {
    copyFileSync(file, file + BAK, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/** Writes through a temp file in the same directory and renames it over `file`, keeping the file's mode. */
function atomicWrite(file: string, content: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.agent-chat.${process.pid}.tmp`);
  const mode = statSync(file).mode & 0o7777;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function commandStep(target: Target, description: string, file: string, args: string[], exec: Exec): Step {
  return { target, description, display: shellJoin([file, ...args]), run: async () => void (await exec(file, args)) };
}
/** A remove that may legitimately fail because there is nothing to remove. */
function removeStep(target: Target, description: string, file: string, args: string[], exec: Exec): Step {
  const s = commandStep(target, `${description}; a failure is ignored (the entry may not exist yet)`, file, args, exec);
  const run = s.run;
  return {
    ...s,
    run: async () => {
      try {
        await run();
      } catch {
        // nothing to remove
      }
    },
  };
}

export function planConnect(o: PlanOptions): Step[] {
  const exec = o.exec ?? defaultExec;
  const steps: Step[] = [];
  for (const target of o.targets) {
    const cmd = serverCommand(o, target);
    if (target === 'codex') {
      const file = codexConfig(o);
      let addFailed = false;
      steps.push(
        {
          target,
          description: `back up ${file} before anything touches it (skipped if it does not exist or the backup already exists)`,
          display: `copy ${file} to ${file}${BAK} (only if that backup does not exist yet)`,
          run: () => {
            if (existsSync(file)) backupOnce(file);
          },
        },
        removeStep('codex', `remove any old "${NAME}" from Codex first so connect can be re-run (codex edits ${file})`, 'codex', ['mcp', 'remove', NAME], exec),
        {
          ...commandStep('codex', `register "${NAME}" with Codex (codex writes ${file})`, 'codex', ['mcp', 'add', NAME, '--', ...cmd], exec),
          run: async () => {
            try {
              await exec('codex', ['mcp', 'add', NAME, '--', ...cmd]);
            } catch (e) {
              addFailed = true;
              throw e;
            }
          },
        },
        {
          target,
          description: `set the tool timeout to ${TOOL_TIMEOUT_SEC}s for "${NAME}" (edits only the [mcp_servers.${NAME}] table of ${file}; original saved once as ${file}${BAK}; \`codex mcp add\` has no timeout option). Runs whenever that table exists, even if the add step reported an error`,
          display: `set tool_timeout_sec = ${TOOL_TIMEOUT_SEC} in [mcp_servers.${NAME}] of ${file} (backup: ${file}${BAK})`,
          run: () => {
            try {
              const before = readFileSync(file, 'utf8');
              const after = setCodexToolTimeout(before, NAME, TOOL_TIMEOUT_SEC);
              if (after === before) return;
              backupOnce(file);
              atomicWrite(file, after);
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e);
              if (addFailed && /^no \[mcp_servers/.test(reason) || (addFailed && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
                throw new Error(`\`codex mcp add\` failed and Codex has no [mcp_servers.${NAME}] table, so there is nothing to set a timeout on (${reason})`);
              }
              throw new Error(
                `${NAME} is registered in Codex with Codex's default tool timeout: the timeout could not be set (${reason}). ` +
                  `Long questions may be cut off. To fix it, add this line by hand under [mcp_servers.${NAME}] in ${file}:\n    tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
              );
            }
          },
        },
      );
    } else if (target === 'claude') {
      steps.push(
        removeStep('claude', `remove any old "${NAME}" from Claude Code at user scope first so connect can be re-run (claude edits ~/.claude.json)`, 'claude', ['mcp', 'remove', '-s', 'user', NAME], exec),
        commandStep(
          'claude',
          `register "${NAME}" with Claude Code at user scope (claude writes ~/.claude.json). This script does not change Claude Code's MCP tool timeout; it is believed to be controlled by the MCP_TOOL_TIMEOUT environment variable of Claude Code itself, which has not been verified on this machine`,
          'claude',
          ['mcp', 'add', '-s', 'user', NAME, '--', ...cmd],
          exec,
        ),
      );
    } else if (target === 'opencode') {
      let present = false;
      steps.push(
        {
          target,
          description: 'check read-only whether OpenCode already lists "agent-chat" (opencode has no remove command, so an existing entry is left as it is)',
          display: 'opencode mcp list',
          run: async () => {
            try {
              present = new RegExp(`(?<![\\w-])${NAME}(?![\\w-])`).test(String((await exec('opencode', ['mcp', 'list'])) ?? ''));
            } catch {
              present = false;
            }
            return present ? `"${NAME}" is already listed by OpenCode` : undefined;
          },
        },
        {
          target,
          description: `register "${NAME}" with OpenCode in its global config (opencode writes ~/.config/opencode; \`opencode mcp add\` has no timeout option). Skipped if the check above found it already registered`,
          display: shellJoin(['opencode', 'mcp', 'add', '--global', NAME, '--', ...cmd]),
          run: async () => {
            if (present) return 'skipped: already registered';
            await exec('opencode', ['mcp', 'add', '--global', NAME, '--', ...cmd]);
          },
        },
      );
    } else {
      for (const profile of o.dshProfiles) {
        const file = dshFile(o.home, profile);
        steps.push({
          target,
          description: `add the "${NAME}" block to DSH profile "${profile}" (edits ${file}; original saved once as ${file}${BAK}; refuses a file that is not an empty/comment-only file or a top-level block sequence)`,
          display: `insert the ${NAME} block into ${file} (backup: ${file}${BAK})`,
          run: () => {
            if (!existsSync(file)) throw new Error(`${file} does not exist`);
            const before = readFileSync(file, 'utf8');
            checkDshShape(before, file);
            const after = upsertDshEntry(before, dshEntry(cmd));
            if (after === before) return;
            backupOnce(file);
            atomicWrite(file, after);
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
      steps.push(commandStep('codex', `remove "${NAME}" from Codex (codex edits ${codexConfig(o)})`, 'codex', ['mcp', 'remove', NAME], exec));
    } else if (target === 'claude') {
      steps.push(commandStep('claude', `remove "${NAME}" from Claude Code at user scope (claude edits ~/.claude.json)`, 'claude', ['mcp', 'remove', '-s', 'user', NAME], exec));
    } else if (target === 'opencode') {
      const how = `OpenCode has no "mcp remove" subcommand: delete the "${NAME}" entry under "mcp" in ~/.config/opencode/opencode.json (or opencode.jsonc) by hand`;
      steps.push({
        target,
        description: `${how}; this step changes nothing`,
        display: `no change: opencode has no "mcp remove"; delete the "${NAME}" entry under "mcp" in ~/.config/opencode/opencode.json (or opencode.jsonc) by hand`,
        run: () => `manual action required: ${how}`,
      });
    } else {
      for (const profile of o.dshProfiles) {
        const file = dshFile(o.home, profile);
        steps.push({
          target,
          description: `remove the "${NAME}" block from DSH profile "${profile}" (edits ${file}; the ${BAK} backup is kept)`,
          display: `remove the ${NAME} block from ${file}`,
          run: () => {
            if (!existsSync(file)) throw new Error(`${file} does not exist`);
            const before = readFileSync(file, 'utf8');
            const after = removeDshEntry(before);
            if (after === before) return;
            backupOnce(file);
            atomicWrite(file, after);
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

/** The patch file must be empty/comments-only or start (after comments) with a block sequence item. */
function checkDshShape(yaml: string, file: string): void {
  const first = yaml.split(/\r?\n/).find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (first !== undefined && !/^-(\s|$)/.test(first)) {
    throw new Error(`${file} is not a top-level block sequence (its first non-comment line is "${first.trim().slice(0, 40)}"); not changed`);
  }
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
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n';
  const body = (entry.endsWith('\n') ? entry : `${entry}\n`).replace(/\r?\n/g, eol);
  const found = findBlock(yaml);
  if (found) {
    const block = `${START}${eol}${body}${END}${found.endHadNewline ? eol : ''}`;
    return yaml.slice(0, found.s) + block + yaml.slice(found.e);
  }
  // A file without a final newline gets one added before the block and no newline after the end marker,
  // which is what lets removeDshEntry restore the original bytes exactly.
  const needsNl = yaml !== '' && !yaml.endsWith('\n');
  return `${yaml}${needsNl ? eol : ''}${START}${eol}${body}${END}${needsNl ? '' : eol}`;
}

export function removeDshEntry(yaml: string): string {
  const found = findBlock(yaml);
  if (!found) return yaml;
  let cut = found.s;
  if (cut > 0 && !found.endHadNewline && found.e === yaml.length) cut -= yaml.slice(0, cut).endsWith('\r\n') ? 2 : 1;
  return yaml.slice(0, cut) + yaml.slice(found.e);
}

// ---------------------------------------------------------------- minimal TOML line scanner

interface LineInfo {
  kind: 'blank' | 'comment' | 'header' | 'kv';
  /** kv only: this line continues a multi-line array or string started on an earlier line. */
  cont: boolean;
}

function skipString(body: string, i: number): number {
  const q = body[i];
  let j = i + 1;
  while (j < body.length) {
    if (q === '"' && body[j] === '\\') j += 2;
    else if (body[j] === q) return j + 1;
    else j++;
  }
  return body.length;
}
function findClose(body: string, from: number, delim: string): number {
  for (let j = from; j < body.length; ) {
    if (delim[0] === '"' && body[j] === '\\') j += 2;
    else if (body.startsWith(delim, j)) return j;
    else j++;
  }
  return -1;
}

/** Classifies each line; a `[` only starts a header when not inside a multi-line string or array value. */
function classifyToml(lines: string[]): LineInfo[] {
  const infos: LineInfo[] = [];
  let multi: string | null = null;
  let depth = 0;
  for (const line of lines) {
    const body = line.replace(/\r?\n$/, '');
    const cont = multi !== null || depth > 0;
    if (!cont) {
      const t = body.trimStart();
      if (t === '') {
        infos.push({ kind: 'blank', cont: false });
        continue;
      }
      if (t[0] === '#') {
        infos.push({ kind: 'comment', cont: false });
        continue;
      }
      if (t[0] === '[') {
        infos.push({ kind: 'header', cont: false });
        continue;
      }
    }
    infos.push({ kind: 'kv', cont });
    let i = 0;
    if (multi) {
      const close = findClose(body, 0, multi);
      if (close < 0) continue;
      i = close + 3;
      multi = null;
    }
    while (i < body.length) {
      const c = body[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (body.startsWith(c.repeat(3), i)) {
          const close = findClose(body, i + 3, c.repeat(3));
          if (close < 0) {
            multi = c.repeat(3);
            break;
          }
          i = close + 3;
        } else i = skipString(body, i);
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return infos;
}

/** Splits a (possibly dotted, possibly quoted) key into its parts; null if it is not understood. */
function parseKey(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '"' || text[i] === "'") {
      const end = skipString(text, i);
      const raw = text.slice(i, end);
      if (raw.length < 2 || raw[raw.length - 1] !== text[i]) return null;
      if (text[i] === '"') {
        try {
          parts.push(JSON.parse(raw));
        } catch {
          return null;
        }
      } else parts.push(raw.slice(1, -1));
      i = end;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i >= text.length) return parts;
    if (text[i] !== '.') return null;
    i++;
  }
}

/** The key parts of a table header line, and whether it is an array-of-tables header. */
function parseHeader(body: string): { array: boolean; key: string[] | null } {
  let t = body.trimStart();
  const array = t.startsWith('[[');
  t = t.slice(array ? 2 : 1);
  let i = 0;
  while (i < t.length && t[i] !== ']') i = t[i] === '"' || t[i] === "'" ? skipString(t, i) : i + 1;
  return { array, key: parseKey(t.slice(0, i)) };
}

/** Index of the `=` of a `key = value` line, outside quotes; -1 if none. */
function eqIndex(body: string): number {
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (c === '"' || c === "'") i = skipString(body, i);
    else if (c === '=') return i;
    else i++;
  }
  return -1;
}

const lineBody = (l: string) => l.replace(/\r?\n$/, '');

/**
 * Sets `tool_timeout_sec` inside `[mcp_servers.<server>]` only, leaving every byte outside that table alone.
 * Throws if the table does not exist or is written in a form (inline table, dotted keys) that cannot be edited safely.
 */
export function setCodexToolTimeout(toml: string, server: string, seconds: number): string {
  const lines = toml.split(/(?<=\n)/);
  const info = classifyToml(lines);
  const same = (k: string[] | null, want: string[]) => !!k && k.length === want.length && k.every((p, i) => p === want[i]);

  let start = -1;
  let path: string[] = [];
  let foreign: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const inf = info[i];
    if (inf.kind === 'header') {
      const h = parseHeader(lineBody(lines[i]));
      path = h.key ?? [];
      if (start < 0 && !h.array && same(h.key, ['mcp_servers', server])) start = i;
    } else if (inf.kind === 'kv' && !inf.cont) {
      const body = lineBody(lines[i]);
      const eq = eqIndex(body);
      const key = eq >= 0 ? parseKey(body.slice(0, eq)) : null;
      if (!key) continue;
      const full = [...path, ...key];
      const inOwn = path[0] === 'mcp_servers' && path[1] === server;
      if (full[0] === 'mcp_servers' && full[1] === server && !inOwn) foreign = 'dotted keys';
      else if (full.length === 1 && full[0] === 'mcp_servers' && body.slice(eq).includes(server)) foreign = 'an inline table';
    }
  }
  if (start < 0) {
    if (foreign) throw new Error(`[mcp_servers.${server}] is written with ${foreign}; it cannot be edited safely, add tool_timeout_sec by hand`);
    throw new Error(`no [mcp_servers.${server}] table found; run \`codex mcp add\` first`);
  }
  if (foreign) throw new Error(`[mcp_servers.${server}] is also defined with ${foreign}; it cannot be edited safely, add tool_timeout_sec by hand`);

  let end = start + 1;
  while (end < lines.length && info[end].kind !== 'header') end++;

  let last = start;
  for (let i = start + 1; i < end; i++) {
    if (info[i].kind === 'kv') last = i;
    if (info[i].kind !== 'kv' || info[i].cont) continue;
    const body = lineBody(lines[i]);
    const eq = eqIndex(body);
    if (!same(eq >= 0 ? parseKey(body.slice(0, eq)) : null, ['tool_timeout_sec'])) continue;
    const rest = body.slice(eq + 1);
    const hash = rest.indexOf('#');
    const value = hash >= 0 ? rest.slice(0, hash) : rest;
    if (/["'[{]/.test(value) || (info[i + 1]?.cont ?? false)) throw new Error('tool_timeout_sec has a value that cannot be edited safely');
    const lead = /^\s*/.exec(value)![0] || ' ';
    const trail = /\s*$/.exec(value)![0];
    const eol = /\r?\n$/.exec(lines[i])?.[0] ?? '';
    const next = `${body.slice(0, eq + 1)}${lead}${seconds}${trail}${hash >= 0 ? rest.slice(hash) : ''}${eol}`;
    if (next === lines[i]) return toml;
    lines[i] = next;
    return lines.join('');
  }

  const crlf = lines[last].endsWith('\r\n') || (!/\n$/.test(lines[last]) && toml.includes('\r\n'));
  const eol = crlf ? '\r\n' : '\n';
  if (!/\n$/.test(lines[last])) lines[last] += eol;
  lines.splice(last + 1, 0, `tool_timeout_sec = ${seconds}${eol}`);
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
    if (t === 'dsh' ? dshProfiles.length === 0 : !which(t)) {
      out(
        t === 'dsh'
          ? `[dsh] skipped: not installed (no cordis.patch.yml for profile web or tui under ${join(home, '.dsh/profiles')})\n`
          : `[${t}] skipped: not installed (\`${t}\` not found on PATH)\n`,
      );
    } else targets.push(t);
  }

  const codexHome = !fakeHome && env.CODEX_HOME ? env.CODEX_HOME : undefined;
  const planOpts: PlanOptions = { targets, repoRoot, home, nodePath, dshProfiles, exec: cli.exec, codexHome };
  const steps = (mode === 'connect' ? planConnect : planDisconnect)(planOpts);

  out(`${mode === 'connect' ? 'Connect' : 'Disconnect'} plan (home: ${home}${fakeHome ? ', from AGENTCHAT_CONNECT_HOME' : ''})\n`);
  if (!apply) {
    steps.forEach((s, i) => out(`${i + 1}. [${s.target}] ${s.description}\n     ${s.display}\n`));
    out(`Nothing was changed. Add --apply to run the ${steps.length} step(s) above.\n`);
    return 0;
  }

  let failed = 0;
  for (const s of steps) {
    if (fakeHome && s.target !== 'dsh') {
      out(`[${s.target}] skipped: AGENTCHAT_CONNECT_HOME is set and ${s.target}'s command would use the real home. ${s.display}\n`);
      continue;
    }
    out(`[${s.target}] ${s.display}\n`);
    try {
      const note = await s.run();
      out(typeof note === 'string' ? `  ${note}\n` : '  ok\n');
    } catch (e) {
      failed++;
      out(`  FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (failed) out(`${failed} step(s) failed.\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
