import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isEntryPoint,
  planConnect,
  planDisconnect,
  removeDshEntry,
  runCli,
  setCodexToolTimeout,
  upsertDshEntry,
  type Target,
} from '../src/connect';

const repoRoot = '/fake/repo';
const nodePath = '/fake/bin/node';
const LOADER = 'file:///fake/repo/node_modules/tsx/dist/loader.mjs';
const MAIN = '/fake/repo/packages/mcp/src/main.ts';
const ALL: Target[] = ['codex', 'claude', 'opencode', 'dsh'];

const tmp: string[] = [];
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentchat-connect-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function plan(fn: typeof planConnect, home = '/fake/home', targets: Target[] = ALL) {
  return fn({ targets, repoRoot, home, nodePath, dshProfiles: ['web', 'tui'], exec: async () => {} });
}
const cmd = (target: string) => `/fake/bin/node --import ${LOADER} ${MAIN} --as ${target}`;

describe('planConnect / planDisconnect display', () => {
  it('connect displays are exact', () => {
    const steps = plan(planConnect);
    expect(steps.map((s) => [s.target, s.display])).toEqual([
      ['codex', `copy /fake/home/.codex/config.toml to /fake/home/.codex/config.toml.agent-chat.bak (only if that backup does not exist yet)`],
      ['codex', 'codex mcp remove agent-chat'],
      ['codex', `codex mcp add agent-chat -- ${cmd('codex')}`],
      ['codex', `set tool_timeout_sec = 600 in [mcp_servers.agent-chat] of /fake/home/.codex/config.toml (backup: /fake/home/.codex/config.toml.agent-chat.bak)`],
      ['claude', 'claude mcp remove -s user agent-chat'],
      ['claude', `claude mcp add -s user agent-chat -- ${cmd('claude')}`],
      ['opencode', 'add "agent-chat" to "mcp" in /fake/home/.config/opencode/opencode.json (backup: /fake/home/.config/opencode/opencode.json.agent-chat.bak)'],
      [
        'dsh',
        `insert the agent-chat block into /fake/home/.dsh/profiles/web/cordis.patch.yml (backup: /fake/home/.dsh/profiles/web/cordis.patch.yml.agent-chat.bak)`,
      ],
      [
        'dsh',
        `insert the agent-chat block into /fake/home/.dsh/profiles/tui/cordis.patch.yml (backup: /fake/home/.dsh/profiles/tui/cordis.patch.yml.agent-chat.bak)`,
      ],
    ]);
  });

  it('disconnect displays are exact', () => {
    const steps = plan(planDisconnect);
    expect(steps.map((s) => [s.target, s.display])).toEqual([
      ['codex', 'codex mcp remove agent-chat'],
      ['claude', 'claude mcp remove -s user agent-chat'],
      ['opencode', 'remove "agent-chat" from "mcp" in /fake/home/.config/opencode/opencode.json (backup: /fake/home/.config/opencode/opencode.json.agent-chat.bak)'],
      ['dsh', 'remove the agent-chat block from /fake/home/.dsh/profiles/web/cordis.patch.yml'],
      ['dsh', 'remove the agent-chat block from /fake/home/.dsh/profiles/tui/cordis.patch.yml'],
    ]);
  });

  it('quotes arguments that need it', () => {
    const [s] = planConnect({ targets: ['claude'], repoRoot: '/my repo', home: '/h', nodePath: '/n o/node', dshProfiles: [], exec: async () => {} });
    expect(s.display).toBe('claude mcp remove -s user agent-chat');
    const add = planConnect({ targets: ['claude'], repoRoot: '/my repo', home: '/h', nodePath: '/n o/node', dshProfiles: [], exec: async () => {} })[1];
    expect(add.display).toContain(`'/n o/node' --import file:///my%20repo/node_modules/tsx/dist/loader.mjs '/my repo/packages/mcp/src/main.ts' --as claude`);
  });

  it('only plans the requested targets; dsh with no profiles plans nothing', () => {
    expect(plan(planConnect, '/h', ['claude']).map((s) => s.target)).toEqual(['claude', 'claude']);
    expect(planConnect({ targets: ['dsh'], repoRoot, home: '/h', nodePath, dshProfiles: [], exec: async () => {} })).toEqual([]);
  });
});

describe('commands run through the injected executor', () => {
  it('codex add, claude add, opencode add; remove commands', async () => {
    const calls: [string, string[]][] = [];
    const exec = async (f: string, a: string[]) => void calls.push([f, a]);
    const home = mk();
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), '[mcp_servers.agent-chat]\ncommand = "x"\n');
    for (const s of planConnect({ targets: ['codex', 'claude', 'opencode'], repoRoot, home, nodePath, dshProfiles: [], exec })) await s.run();
    for (const s of planDisconnect({ targets: ALL, repoRoot, home, nodePath, dshProfiles: [], exec })) await s.run();
    const c = (t: string) => ['/fake/bin/node', '--import', LOADER, MAIN, '--as', t];
    expect(calls).toEqual([
      ['codex', ['mcp', 'remove', 'agent-chat']],
      ['codex', ['mcp', 'add', 'agent-chat', '--', ...c('codex')]],
      ['claude', ['mcp', 'remove', '-s', 'user', 'agent-chat']],
      ['claude', ['mcp', 'add', '-s', 'user', 'agent-chat', '--', ...c('claude')]],
      ['codex', ['mcp', 'remove', 'agent-chat']],
      ['claude', ['mcp', 'remove', '-s', 'user', 'agent-chat']],
    ]);
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('tool_timeout_sec = 600');
  });
});

describe('setCodexToolTimeout', () => {
  const other = '# my config\nmodel = "x"\n\n[mcp_servers.rea]\ncommand = "rea"\ntool_timeout_sec = 450\n\n';
  const tail = '\n[mcp_servers.zzz]\ncommand = "z"\nargs = [ "a" ]\n';

  it('throws when the table is absent', () => {
    expect(() => setCodexToolTimeout(other + tail, 'agent-chat', 600)).toThrow(/mcp_servers\.agent-chat/);
  });

  it('adds the key to a table without it, touching nothing else', () => {
    const before = `${other}[mcp_servers.agent-chat]\ncommand = "n"\nargs = [ "a" ]\n${tail}`;
    expect(setCodexToolTimeout(before, 'agent-chat', 600)).toBe(
      `${other}[mcp_servers.agent-chat]\ncommand = "n"\nargs = [ "a" ]\ntool_timeout_sec = 600\n${tail}`,
    );
  });

  it('adds the key when the table is last and the file lacks a trailing newline', () => {
    expect(setCodexToolTimeout('[mcp_servers.agent-chat]\ncommand = "n"', 'agent-chat', 600)).toBe(
      '[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\n',
    );
  });

  it('replaces a different value in place', () => {
    const before = `${other}[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 30\nstartup_timeout_sec = 5\n${tail}`;
    expect(setCodexToolTimeout(before, 'agent-chat', 600)).toBe(
      `${other}[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\nstartup_timeout_sec = 5\n${tail}`,
    );
  });

  it('is idempotent and leaves another table\'s tool_timeout_sec alone', () => {
    const before = `${other}[mcp_servers.agent-chat]\ncommand = "n"\n${tail}`;
    const once = setCodexToolTimeout(before, 'agent-chat', 600);
    expect(setCodexToolTimeout(once, 'agent-chat', 600)).toBe(once);
    expect(once).toContain('[mcp_servers.rea]\ncommand = "rea"\ntool_timeout_sec = 450\n');
  });

  it('inserts before a sub-table of agent-chat and ignores agent-chat-two', () => {
    const before = '[mcp_servers.agent-chat-two]\ncommand = "t"\n[mcp_servers.agent-chat]\ncommand = "n"\n[mcp_servers.agent-chat.env]\nA = "b"\n';
    expect(setCodexToolTimeout(before, 'agent-chat', 600)).toBe(
      '[mcp_servers.agent-chat-two]\ncommand = "t"\n[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\n[mcp_servers.agent-chat.env]\nA = "b"\n',
    );
  });
});

describe('upsertDshEntry / removeDshEntry', () => {
  const entry = '- id: mcp-agent-chat\n  name: x\n';
  const START = '# >>> agent-chat\n';
  const END = '# <<< agent-chat\n';

  it('inserts into an empty file', () => {
    expect(upsertDshEntry('', entry)).toBe(`${START}${entry}${END}`);
  });

  it('appends after existing entries without touching them', () => {
    const base = '# header\n- id: a\n  config:\n    k: 1\n';
    const out = upsertDshEntry(base, entry);
    expect(out).toBe(`${base}${START}${entry}${END}`);
    expect(removeDshEntry(out)).toBe(base);
  });

  it('replaces an old block instead of duplicating, in place', () => {
    const base = '- id: a\n';
    const old = `${base}${START}- id: old\n${END}- id: b\n`;
    const out = upsertDshEntry(old, entry);
    expect(out).toBe(`${base}${START}${entry}${END}- id: b\n`);
    expect(upsertDshEntry(out, entry)).toBe(out);
    expect(removeDshEntry(out)).toBe('- id: a\n- id: b\n');
  });

  it('round-trips byte for byte when the file lacks a trailing newline, and for CRLF-free empty', () => {
    for (const base of ['- id: a', '', '\n', '- id: a\n\n']) {
      const out = upsertDshEntry(base, entry);
      expect(upsertDshEntry(out, entry)).toBe(out);
      expect(removeDshEntry(out)).toBe(base);
    }
  });

  it('recognises markers that were re-indented (seen after a running dsh web reloaded the file)', () => {
    const base = '- id: a\n  config:\n    deep:\n      k: 1\n';
    const old = `${base}        ${START}- id: old\n${END}`;
    const out = upsertDshEntry(old, entry);
    expect(out).toBe(`${base}${START}${entry}${END}`);
    expect(removeDshEntry(old)).toBe(base);
  });

  it('collapses duplicate blocks into one, and remove takes them all out', () => {
    const base = '- id: a\n';
    const twice = `${base}    ${START}- id: old\n${END}${START}- id: newer\n${END}`;
    expect(upsertDshEntry(twice, entry)).toBe(`${base}${START}${entry}${END}`);
    expect(removeDshEntry(twice)).toBe(base);
  });

  it('remove is a no-op without markers', () => {
    expect(removeDshEntry('- id: a\n')).toBe('- id: a\n');
  });

  it('refuses a start marker without an end marker', () => {
    expect(() => upsertDshEntry(`${START}- id: x\n`, entry)).toThrow(/agent-chat/);
    expect(() => removeDshEntry(`${START}- id: x\n`)).toThrow(/agent-chat/);
  });
});

describe('dsh steps on a temp home', () => {
  const original = '# patch\n- id: other\n  config:\n    a: 1\n';

  it('backs up, writes, is idempotent, and disconnect restores the file', async () => {
    const home = mk();
    const dir = join(home, '.dsh/profiles/web');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, original);
    const opts = { targets: ['dsh'] as Target[], repoRoot, home, nodePath, dshProfiles: ['web'], exec: async () => {} };

    for (const s of planConnect(opts)) await s.run();
    const once = readFileSync(file, 'utf8');
    expect(readFileSync(`${file}.agent-chat.bak`, 'utf8')).toBe(original);
    expect(once.startsWith(original)).toBe(true);
    // DSH patch lists only override existing ids; a new plugin entry must sit under `insert:`
    // (a bare `- id: mcp-agent-chat` makes dsh report `patch: entry "mcp-agent-chat" not found` and ignore it).
    expect(once).toContain('# >>> agent-chat\n- insert:\n    - id: mcp-agent-chat\n      name: \'@deepseek-ai/dsh-mcp-client\'\n');
    expect(once).toContain('name: \'@deepseek-ai/dsh-mcp-client\'');
    expect(once).toContain('serverName: agent-chat');
    expect(once).toContain('toolCallTimeoutMs: 600000');
    expect(once).toContain(`"${nodePath}"`);
    expect(once).toContain(`"--import", "${LOADER}", "${MAIN}", "--as", "dsh"`);

    for (const s of planConnect(opts)) await s.run();
    expect(readFileSync(file, 'utf8')).toBe(once);

    // an existing backup is never overwritten
    writeFileSync(`${file}.agent-chat.bak`, 'keep me');
    for (const s of planConnect(opts)) await s.run();
    expect(readFileSync(`${file}.agent-chat.bak`, 'utf8')).toBe('keep me');

    for (const s of planDisconnect(opts)) await s.run();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('fails clearly when the profile file is missing', async () => {
    const home = mk();
    const [s] = planConnect({ targets: ['dsh'], repoRoot, home, nodePath, dshProfiles: ['web'], exec: async () => {} });
    await expect(Promise.resolve().then(() => s.run())).rejects.toThrow(/cordis\.patch\.yml/);
  });
});

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p.slice(dir.length)}:${readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe('runCli with a fake home', () => {
  function fakeEnv() {
    const home = mk();
    const dsh = join(home, '.dsh/profiles/web');
    mkdirSync(dsh, { recursive: true });
    writeFileSync(join(dsh, 'cordis.patch.yml'), '- id: other\n');
    return home;
  }
  function io() {
    const o = { out: '', err: '' };
    return { o, w: { out: (s: string) => (o.out += s), err: (s: string) => (o.err += s) } };
  }
  const base = (home: string, exec: (f: string, a: string[]) => Promise<void>) => ({
    env: { AGENTCHAT_CONNECT_HOME: home },
    home,
    repoRoot,
    nodePath,
    exec,
    which: () => true,
  });

  it('prints the plan and changes nothing without --apply', async () => {
    const home = fakeEnv();
    const before = snapshot(home);
    const calls: string[] = [];
    const { o, w } = io();
    const code = await runCli(['connect'], { ...base(home, async (f) => void calls.push(f)), ...w });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(snapshot(home)).toEqual(before);
    expect(o.out).toContain('codex mcp add agent-chat --');
    expect(o.out).toContain('claude mcp add -s user agent-chat --');
    expect(o.out).toContain('add "agent-chat" to "mcp" in');
    expect(o.out).toContain(join(home, '.dsh/profiles/web/cordis.patch.yml'));
    expect(o.out).toMatch(/--apply/);
  });

  it('with --apply and a fake home, skips real commands and only edits dsh', async () => {
    const home = fakeEnv();
    const calls: string[] = [];
    const { o, w } = io();
    const code = await runCli(['connect', '--apply'], { ...base(home, async (f) => void calls.push(f)), ...w });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(o.out).toMatch(/skipped.*AGENTCHAT_CONNECT_HOME/);
    expect(readFileSync(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toContain('# >>> agent-chat');
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('skips targets that are not installed and says so', async () => {
    const home = fakeEnv();
    const { o, w } = io();
    const code = await runCli(['disconnect', 'codex', 'dsh'], { ...base(home, async () => {}), which: () => false, ...w });
    expect(code).toBe(0);
    expect(o.out).toMatch(/codex.*not installed/);
    expect(o.out).toMatch(/Nothing was changed/i);
  });

  it('a failing step does not stop other targets and the exit code is non-zero', async () => {
    const home = fakeEnv();
    const realHome = { ...base(home, async () => {}) };
    delete (realHome.env as Record<string, string>).AGENTCHAT_CONNECT_HOME;
    const calls: string[] = [];
    const { o, w } = io();
    const code = await runCli(['connect', '--apply', 'codex', 'claude'], {
      ...realHome,
      home,
      exec: async (f, a) => {
        calls.push(f);
        if (f === 'codex' && a[1] === 'add') throw new Error('boom');
      },
      ...w,
    });
    expect(code).toBe(1);
    expect(calls).toEqual(['codex', 'codex', 'claude', 'claude']); // remove+add for each; the failed codex add does not stop claude
    expect(o.out).toMatch(/FAILED.*boom/);
  });

  it('rejects unknown arguments', async () => {
    const { o, w } = io();
    expect(await runCli(['connect', 'vim'], { ...base(mk(), async () => {}), ...w })).toBe(2);
    expect(o.err).toMatch(/vim/);
  });
});

describe('safe by construction', () => {
  const o = { targets: ['codex'] as Target[], repoRoot, home: '/fake/home', nodePath, dshProfiles: [] as string[] };
  it('planConnect and planDisconnect throw at plan time without an exec', () => {
    expect(() => planConnect(o as never)).toThrow(/exec/);
    expect(() => planDisconnect(o as never)).toThrow(/exec/);
  });

  const full = () => ({ exec: async () => {}, home: mk(), env: {}, repoRoot, nodePath, which: () => true, out: () => {}, err: () => {} });
  it.each(['exec', 'home', 'env'])('runCli throws without %s and does nothing', async (missing) => {
    const cli: Record<string, unknown> = full();
    delete cli[missing];
    await expect(runCli(['connect'], cli as never)).rejects.toThrow(new RegExp(missing));
    await expect(runCli(['connect'], undefined as never)).rejects.toThrow();
  });
});

describe('entry point process', () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), '../src/connect.ts');
  const loader = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/loader.mjs')).href;

  it('without --apply exits 0, lists every step, runs nothing and changes nothing', async () => {
    const home = mk();
    const profile = join(home, '.dsh/profiles/web');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: other\n');
    const bin = mk();
    const marker = join(bin, 'RAN');
    for (const n of ['codex', 'claude', 'opencode']) {
      const p = join(bin, n);
      writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(p, 0o755);
    }
    const before = snapshot(home);
    const child = spawn(process.execPath, ['--import', loader, entry, 'connect'], {
      env: { PATH: bin, AGENTCHAT_CONNECT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const code = await new Promise((r) => child.on('close', r));
    expect(err).toBe('');
    expect(code).toBe(0);
    for (const frag of ['codex mcp add agent-chat --', 'tool_timeout_sec = 600', 'claude mcp add -s user agent-chat --', 'agent-chat.bak', 'add "agent-chat" to "mcp" in', 'cordis.patch.yml']) {
      expect(out).toContain(frag);
    }
    expect(existsSync(marker)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  }, 30000);
});

describe('setCodexToolTimeout: table boundaries and forms', () => {
  const T = '[mcp_servers.agent-chat]\ncommand = "n"\n';
  const insert = (before: string, after: string) => {
    const out = setCodexToolTimeout(before, 'agent-chat', 600);
    expect(out).toBe(after);
  };

  it.each([
    ['projects table with a slash in a quoted key', '[projects."/a b/c"]\ntrust_level = "trusted"\ntool_timeout_sec = 7\n'],
    ['plugins table with @ in a quoted key', '[plugins."x@y"]\nenabled = true\ntool_timeout_sec = 7\n'],
    ['array-of-tables', '[[array]]\nname = "a"\ntool_timeout_sec = 7\n'],
    ['header with trailing comment', '[other] # note\ntool_timeout_sec = 7\n'],
  ])('stops at a foreign header: %s', (_n, foreign) => {
    insert(`# top\n${T}${foreign}`, `# top\n${T}tool_timeout_sec = 600\n${foreign}`);
  });

  it('is not fooled by [ on a continuation line of a multi-line array', () => {
    const t = '[mcp_servers.agent-chat]\nargs = [\n  "a",\n[1, 2],\n  # [x]\n]\n';
    insert(`${t}[o]\ntool_timeout_sec = 7\n`, `${t}tool_timeout_sec = 600\n[o]\ntool_timeout_sec = 7\n`);
  });

  it('is not fooled by a header-looking line inside a multi-line string', () => {
    const t = '[mcp_servers.agent-chat]\nnote = """\n[not.a.header]\ntext"""\nlit = \'\'\'\n[nor.this]\n\'\'\'\n';
    insert(`${t}[o]\nx = 1\n`, `${t}tool_timeout_sec = 600\n[o]\nx = 1\n`);
  });

  it('keeps a comment block that precedes the next header after the new key', () => {
    insert(`${T}\n# about o\n# more\n[o]\nx = 1\n`, `${T}tool_timeout_sec = 600\n\n# about o\n# more\n[o]\nx = 1\n`);
  });

  it('replaces a quoted key and keeps the trailing comment', () => {
    insert(
      '[mcp_servers.agent-chat]\n  "tool_timeout_sec"   =  30   # keep\ncommand = "n"\n[o]\ntool_timeout_sec = 7\n',
      '[mcp_servers.agent-chat]\n  "tool_timeout_sec"   =  600   # keep\ncommand = "n"\n[o]\ntool_timeout_sec = 7\n',
    );
  });

  it('preserves CRLF line endings', () => {
    insert('[a]\r\nx = 1\r\n[mcp_servers.agent-chat]\r\ncommand = "n"\r\n\r\n[o]\r\ny = 2\r\n', '[a]\r\nx = 1\r\n[mcp_servers.agent-chat]\r\ncommand = "n"\r\ntool_timeout_sec = 600\r\n\r\n[o]\r\ny = 2\r\n');
    insert('[mcp_servers.agent-chat]\r\ncommand = "n"\r\ntool_timeout_sec = 1\r\n', '[mcp_servers.agent-chat]\r\ncommand = "n"\r\ntool_timeout_sec = 600\r\n');
  });

  it('handles a table that ends the file without a final newline', () => {
    insert('[mcp_servers.agent-chat]\ncommand = "n"', '[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\n');
    insert('[mcp_servers.agent-chat]', '[mcp_servers.agent-chat]\ntool_timeout_sec = 600\n');
    insert('[a]\nx = 1\n[mcp_servers.agent-chat]\r\ncommand = "n"', '[a]\nx = 1\n[mcp_servers.agent-chat]\r\ncommand = "n"\r\ntool_timeout_sec = 600\r\n');
  });

  it.each([
    ['inline table', 'mcp_servers = { agent-chat = { command = "x" } }\n'],
    ['dotted key at the root', 'mcp_servers.agent-chat.command = "x"\n'],
    ['dotted key under [mcp_servers]', '[mcp_servers]\nagent-chat.command = "x"\n'],
    ['inline table under [mcp_servers]', '[mcp_servers]\nagent-chat = { command = "x" }\n'],
  ])('throws for a form it cannot edit safely: %s', (_n, toml) => {
    expect(() => setCodexToolTimeout(toml, 'agent-chat', 600)).toThrow(/cannot be edited safely|inline|dotted/);
  });
});

describe('codex config backup and atomic write', () => {
  function codexSetup(content = '[mcp_servers.agent-chat]\ncommand = "n"\n') {
    const home = mk();
    const dir = join(home, '.codex');
    mkdirSync(dir);
    const file = join(dir, 'config.toml');
    writeFileSync(file, content);
    return { home, dir, file };
  }
  const run = async (o: { home: string; codexHome?: string }, which: 'connect' | 'disconnect' = 'connect') => {
    for (const s of (which === 'connect' ? planConnect : planDisconnect)({ targets: ['codex'], repoRoot, nodePath, dshProfiles: [], exec: async () => {}, ...o })) await s.run();
  };

  it('backs up once, keeps the mode, leaves no temp file', async () => {
    const { home, dir, file } = codexSetup();
    chmodSync(file, 0o600);
    await run({ home });
    expect(readFileSync(`${file}.agent-chat.bak`, 'utf8')).toBe('[mcp_servers.agent-chat]\ncommand = "n"\n');
    expect(readFileSync(file, 'utf8')).toBe('[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['config.toml', 'config.toml.agent-chat.bak']);
    writeFileSync(file, '[mcp_servers.agent-chat]\ncommand = "changed"\n');
    await run({ home });
    expect(readFileSync(`${file}.agent-chat.bak`, 'utf8')).toBe('[mcp_servers.agent-chat]\ncommand = "n"\n');
  });

  it('honours codexHome', async () => {
    const { home } = codexSetup('# real\n');
    const other = mk();
    writeFileSync(join(other, 'config.toml'), '[mcp_servers.agent-chat]\n');
    await run({ home, codexHome: other });
    expect(readFileSync(join(other, 'config.toml'), 'utf8')).toContain('tool_timeout_sec = 600');
    expect(readFileSync(join(other, 'config.toml.agent-chat.bak'), 'utf8')).toBe('[mcp_servers.agent-chat]\n');
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('# real\n');
  });

  it('runCli reads CODEX_HOME and names the backup in the plan', async () => {
    const codexHome = mk();
    const o = { out: '' };
    const code = await runCli(['connect', 'codex'], {
      env: { CODEX_HOME: codexHome },
      home: '/nowhere',
      repoRoot,
      nodePath,
      exec: async () => {},
      which: () => true,
      out: (s) => (o.out += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(o.out).toContain(`${join(codexHome, 'config.toml')}.agent-chat.bak`);
    expect(o.out).not.toContain('/nowhere/.codex');
  });
});

describe('connect is re-runnable (fake executor)', () => {
  function world() {
    const home = mk();
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir);
    const file = join(codexDir, 'config.toml');
    writeFileSync(file, '[projects."/x y"]\ntool_timeout_sec = 7\n');
    const reg = { codex: false, claude: false };
    const calls: string[] = [];
    const exec = async (f: string, a: string[]): Promise<string | void> => {
      calls.push(`${f} ${a.slice(0, 2).join(' ')}`);
      const k = f as 'codex' | 'claude';
      if (a[1] === 'remove') {
        if (!reg[k]) throw new Error('not found');
        reg[k] = false;
        if (k === 'codex') writeFileSync(file, '[projects."/x y"]\ntool_timeout_sec = 7\n');
      } else if (a[1] === 'add') {
        if (reg[k as 'codex']) throw new Error('already exists');
        reg[k as 'codex'] = true;
        if (k === 'codex') writeFileSync(file, `${readFileSync(file, 'utf8')}\n[mcp_servers.agent-chat]\ncommand = "n"\n`);
      }
    };
    return { home, file, reg, calls, exec };
  }
  const go = async (w: ReturnType<typeof world>, argv = ['connect', '--apply', 'codex', 'claude', 'opencode']) => {
    const o = { out: '' };
    const code = await runCli(argv, { env: {}, home: w.home, repoRoot, nodePath, exec: w.exec, which: () => true, out: (s) => (o.out += s), err: () => {} });
    return { code, out: o.out };
  };

  it('a second run ends in the same state with exit 0', async () => {
    const w = world();
    const first = await go(w);
    expect(first.code).toBe(0);
    const state = readFileSync(w.file, 'utf8');
    expect(state).toBe('[projects."/x y"]\ntool_timeout_sec = 7\n\n[mcp_servers.agent-chat]\ncommand = "n"\ntool_timeout_sec = 600\n');
    const second = await go(w);
    expect(second.code).toBe(0);
    expect(readFileSync(w.file, 'utf8')).toBe(state);
    expect(w.reg).toEqual({ codex: true, claude: true });
    expect(second.out).toMatch(/already registered/);
    expect(w.calls.filter((c) => c.startsWith('opencode'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(w.home, '.config/opencode/opencode.json'), 'utf8')).mcp['agent-chat'].enabled).toBe(true);
  });

  it('runs the timeout step even when add fails, as long as the table exists', async () => {
    const w = world();
    writeFileSync(w.file, '[mcp_servers.agent-chat]\ncommand = "n"\n');
    const exec = async (f: string, a: string[]) => {
      if (f === 'codex' && a[1] === 'add') throw new Error('already exists');
    };
    const o = { out: '' };
    const code = await runCli(['connect', '--apply', 'codex'], { env: {}, home: w.home, repoRoot, nodePath, exec, which: () => true, out: (s) => (o.out += s), err: () => {} });
    expect(code).toBe(1);
    expect(readFileSync(w.file, 'utf8')).toContain('tool_timeout_sec = 600');
    expect(o.out).toMatch(/FAILED: already exists/);
  });

  it('says plainly that Codex is registered with the default timeout when the edit fails after add', async () => {
    const w = world();
    writeFileSync(w.file, 'mcp_servers.agent-chat.command = "n"\n'); // a form the edit refuses
    const o = { out: '' };
    const code = await runCli(['connect', '--apply', 'codex'], { env: {}, home: w.home, repoRoot, nodePath, exec: async () => {}, which: () => true, out: (s) => (o.out += s), err: () => {} });
    expect(code).toBe(1);
    expect(o.out).toMatch(/agent-chat is registered in Codex with Codex's default tool timeout/);
    expect(o.out).toMatch(/cut off/);
    expect(o.out).toContain('tool_timeout_sec = 600');
    expect(o.out).toContain('[mcp_servers.agent-chat]');
    expect(readFileSync(w.file, 'utf8')).toBe('mcp_servers.agent-chat.command = "n"\n');
  });
});

describe('wording and manual steps', () => {
  it('claude step does not claim the timeout is a verified global setting', () => {
    const claude = planConnect({ targets: ['claude'], repoRoot, home: '/h', nodePath, dshProfiles: [], exec: async () => {} }).find((s) => /register/.test(s.description))!;
    expect(claude.description).toMatch(/does not change Claude Code's MCP tool timeout/);
    expect(claude.description).toMatch(/believed to be controlled by the MCP_TOOL_TIMEOUT environment variable/);
    expect(claude.description).toMatch(/not been verified on this machine/);
    expect(claude.description).not.toMatch(/is a global/);
  });
});

describe('dsh file shape and line endings', () => {
  const setup = (content: string) => {
    const home = mk();
    const dir = join(home, '.dsh/profiles/web');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, content);
    return { home, file };
  };
  const opts = (home: string) => ({ targets: ['dsh'] as Target[], repoRoot, home, nodePath, dshProfiles: ['web'], exec: async () => {} });

  it.each([['a flow sequence', '[]\n'], ['a mapping', 'foo: bar\n'], ['a mapping after comments', '# c\n\nfoo: bar\n']])('refuses %s and changes nothing', async (_n, content) => {
    const { home, file } = setup(content);
    for (const s of planConnect(opts(home))) await expect(Promise.resolve().then(() => s.run())).rejects.toThrow(/top-level block sequence/);
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(existsSync(`${file}.agent-chat.bak`)).toBe(false);
  });

  it.each([['empty', ''], ['comments only', '# a\n# b\n'], ['sequence', '# a\n- id: x\n']])('accepts %s', async (_n, content) => {
    const { home, file } = setup(content);
    for (const s of planConnect(opts(home))) await s.run();
    expect(readFileSync(file, 'utf8')).toContain('# >>> agent-chat');
  });

  it('keeps CRLF and restores the file exactly; written atomically with the same mode', async () => {
    const original = '# a\r\n- id: x\r\n  config:\r\n    k: 1\r\n';
    const { home, file } = setup(original);
    chmodSync(file, 0o640);
    for (const s of planConnect(opts(home))) await s.run();
    const out = readFileSync(file, 'utf8');
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(file)).sort()).toEqual(['cordis.patch.yml', 'cordis.patch.yml.agent-chat.bak']);
    for (const s of planDisconnect(opts(home))) await s.run();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('OpenCode global config edit', () => {
  const OC = (home: string) => join(home, '.config/opencode/opencode.json');
  const opts = (home: string) => ({ targets: ['opencode'] as Target[], repoRoot, home, nodePath, dshProfiles: [] as string[], exec: async () => {} });
  const run = async (fn: typeof planConnect, home: string) => {
    const notes: unknown[] = [];
    for (const s of fn(opts(home))) notes.push(await s.run());
    return notes;
  };
  const entry = () => ({
    type: 'local',
    command: ['/fake/bin/node', '--import', LOADER, MAIN, '--as', 'opencode'],
    enabled: true,
    timeout: 600000,
  });
  const put = (home: string, text: string) => {
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    writeFileSync(OC(home), text);
  };

  it('creates the file when it does not exist', async () => {
    const home = mk();
    await run(planConnect, home);
    expect(JSON.parse(readFileSync(OC(home), 'utf8'))).toEqual({ mcp: { 'agent-chat': entry() } });
    expect(existsSync(`${OC(home)}.agent-chat.bak`)).toBe(false);
  });

  it('keeps every other key and the indentation, backs up once, and never overwrites the backup', async () => {
    const home = mk();
    const original = '{\n    "$schema": "https://opencode.ai/config.json",\n    "skills": ["a", "b"],\n    "mcp": {\n        "other": { "type": "remote", "url": "https://x" }\n    }\n}\n';
    put(home, original);
    await run(planConnect, home);
    const text = readFileSync(OC(home), 'utf8');
    expect(text.startsWith('{\n    "$schema"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.skills).toEqual(['a', 'b']);
    expect(parsed.mcp.other).toEqual({ type: 'remote', url: 'https://x' });
    expect(parsed.mcp['agent-chat']).toEqual(entry());
    expect(readFileSync(`${OC(home)}.agent-chat.bak`, 'utf8')).toBe(original);
    const notes = await run(planConnect, home);
    expect(readFileSync(OC(home), 'utf8')).toBe(text);
    expect(readFileSync(`${OC(home)}.agent-chat.bak`, 'utf8')).toBe(original);
    expect(String(notes[0])).toMatch(/already registered/);
  });

  it('connect then disconnect gives back the original bytes, with no empty "mcp": {} left behind', async () => {
    const home = mk();
    // the shape of the real global config this was registered into
    const original = '{\n  "$schema": "https://opencode.ai/config.json",\n  "skills": [\n    "~/.codex/skills",\n    "~/.codex/skills/.system"\n  ]\n}\n';
    put(home, original);
    await run(planConnect, home);
    await run(planDisconnect, home);
    expect(readFileSync(OC(home), 'utf8')).toBe(original);
  });

  it('disconnect keeps an "mcp" object that still holds other servers, and one that was already empty', async () => {
    const home = mk();
    put(home, JSON.stringify({ mcp: { other: { type: 'remote', url: 'https://x' }, 'agent-chat': entry() } }, null, 2));
    await run(planDisconnect, home);
    expect(JSON.parse(readFileSync(OC(home), 'utf8'))).toEqual({ mcp: { other: { type: 'remote', url: 'https://x' } } });
    const home2 = mk();
    const already = '{\n  "mcp": {}\n}\n';
    put(home2, already);
    await run(planDisconnect, home2);
    expect(readFileSync(OC(home2), 'utf8')).toBe(already);
  });

  it('replaces an outdated agent-chat entry and removes a stale mcp.servers entry left by `opencode mcp add`', async () => {
    const home = mk();
    put(home, JSON.stringify({ mcp: { 'agent-chat': { type: 'local', command: ['old'] }, servers: { 'agent-chat': { type: 'local', command: ['old'] }, keep: { type: 'local', command: ['k'] } } } }, null, 2));
    await run(planConnect, home);
    const parsed = JSON.parse(readFileSync(OC(home), 'utf8'));
    expect(parsed.mcp['agent-chat']).toEqual(entry());
    expect(parsed.mcp.servers).toEqual({ keep: { type: 'local', command: ['k'] } });
  });

  it.each([
    ['a comment', '{\n  // note\n  "mcp": {}\n}\n'],
    ['a trailing comma', '{ "mcp": {}, }\n'],
    ['a non-object mcp', '{ "mcp": [] }\n'],
    ['a non-object root', '[]\n'],
  ])('refuses %s: changes nothing and says to edit by hand with the entry', async (_n, content) => {
    const home = mk();
    put(home, content);
    for (const s of planConnect(opts(home))) {
      await expect(Promise.resolve().then(() => s.run())).rejects.toThrow(/by hand.*"agent-chat"/s);
    }
    expect(readFileSync(OC(home), 'utf8')).toBe(content);
    expect(existsSync(`${OC(home)}.agent-chat.bak`)).toBe(false);
  });

  it('uses opencode.jsonc when it is the file that exists', async () => {
    const home = mk();
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    writeFileSync(join(home, '.config/opencode/opencode.jsonc'), '{}\n');
    await run(planConnect, home);
    expect(JSON.parse(readFileSync(join(home, '.config/opencode/opencode.jsonc'), 'utf8')).mcp['agent-chat']).toEqual(entry());
    expect(existsSync(OC(home))).toBe(false);
  });

  it('honours an explicit config directory (XDG_CONFIG_HOME)', async () => {
    const home = mk();
    const dir = mk();
    for (const s of planConnect({ ...opts(home), opencodeConfigDir: join(dir, 'opencode') })) await s.run();
    expect(JSON.parse(readFileSync(join(dir, 'opencode/opencode.json'), 'utf8')).mcp['agent-chat']).toEqual(entry());
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('disconnect removes only agent-chat (and the stale servers entry), leaving the rest', async () => {
    const home = mk();
    put(home, JSON.stringify({ skills: ['s'], mcp: { 'agent-chat': entry(), other: { type: 'local', command: ['o'] }, servers: { 'agent-chat': { type: 'local', command: ['x'] } } } }, null, 2) + '\n');
    await run(planDisconnect, home);
    expect(JSON.parse(readFileSync(OC(home), 'utf8'))).toEqual({ skills: ['s'], mcp: { other: { type: 'local', command: ['o'] } } });
    expect(existsSync(`${OC(home)}.agent-chat.bak`)).toBe(true);
    const again = await run(planDisconnect, home);
    expect(String(again[0])).toMatch(/not registered/);
  });

  it('disconnect with no config file changes nothing; with unparseable config fails and leaves it', async () => {
    const home = mk();
    expect(String((await run(planDisconnect, home))[0])).toMatch(/does not exist/);
    expect(existsSync(OC(home))).toBe(false);
    put(home, '{ // c\n}');
    for (const s of planDisconnect(opts(home))) await expect(Promise.resolve().then(() => s.run())).rejects.toThrow(/by hand/);
    expect(readFileSync(OC(home), 'utf8')).toBe('{ // c\n}');
  });

  it('runCli passes XDG_CONFIG_HOME to the plan', async () => {
    const home = mk();
    const xdg = mk();
    const o = { out: '' };
    const code = await runCli(['connect', 'opencode'], { env: { XDG_CONFIG_HOME: xdg }, home, repoRoot, nodePath, exec: async () => {}, which: () => true, out: (s) => (o.out += s), err: () => {} });
    expect(code).toBe(0);
    expect(o.out).toContain(join(xdg, 'opencode/opencode.json'));
  });
});

describe('writes go through symlinks', () => {
  it('a symlinked OpenCode config stays a symlink and its target is updated', async () => {
    const home = mk();
    const real = join(mk(), 'real.json');
    writeFileSync(real, '{\n  "skills": []\n}\n');
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    const link = join(home, '.config/opencode/opencode.json');
    symlinkSync(real, link);
    for (const s of planConnect({ targets: ['opencode'], repoRoot, home, nodePath, dshProfiles: [], exec: async () => {} })) await s.run();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).mcp['agent-chat'].enabled).toBe(true);
  });

  it('a dangling OpenCode config symlink stays a symlink and the file is created at its target', async () => {
    const home = mk();
    const realDir = mk();
    const real = join(realDir, 'dotfiles-opencode.json'); // does not exist yet
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    const link = join(home, '.config/opencode/opencode.json');
    symlinkSync(real, link);
    for (const s of planConnect({ targets: ['opencode'], repoRoot, home, nodePath, dshProfiles: [], exec: async () => {} })) await s.run();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).mcp['agent-chat'].enabled).toBe(true);
  });

  it('a relative, chained symlink is followed to the final file', async () => {
    const home = mk();
    const dir = join(home, '.config/opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'final.json'), '{}\n');
    symlinkSync('final.json', join(dir, 'middle.json'));
    symlinkSync('middle.json', join(dir, 'opencode.json'));
    for (const s of planConnect({ targets: ['opencode'], repoRoot, home, nodePath, dshProfiles: [], exec: async () => {} })) await s.run();
    expect(lstatSync(join(dir, 'opencode.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'middle.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8')).mcp['agent-chat']).toBeTruthy();
  });

  it('the same for a DSH patch file', async () => {
    const home = mk();
    const dir = join(home, '.dsh/profiles/web');
    mkdirSync(dir, { recursive: true });
    const real = join(mk(), 'real.yml');
    writeFileSync(real, '- id: x\n');
    const link = join(dir, 'cordis.patch.yml');
    symlinkSync(real, link);
    for (const s of planConnect({ targets: ['dsh'], repoRoot, home, nodePath, dshProfiles: ['web'], exec: async () => {} })) await s.run();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('# >>> agent-chat');
  });

  it('the same for the Codex config.toml timeout edit', async () => {
    const home = mk();
    mkdirSync(join(home, '.codex'));
    const real = join(mk(), 'real.toml');
    writeFileSync(real, '[mcp_servers.agent-chat]\ncommand = "n"\n');
    const link = join(home, '.codex/config.toml');
    symlinkSync(real, link);
    for (const s of planConnect({ targets: ['codex'], repoRoot, home, nodePath, dshProfiles: [], exec: async () => {} })) await s.run();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('tool_timeout_sec = 600');
  });
});

describe('a failed re-add after the old registration was removed', () => {
  const runTarget = async (target: 'codex' | 'claude', removeFails: boolean) => {
    const home = mk();
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), '');
    const exec = async (_f: string, a: string[]) => {
      if (a.includes('remove')) {
        if (removeFails) throw new Error('not found');
        return;
      }
      throw new Error('add exploded');
    };
    const o = { out: '' };
    const code = await runCli(['connect', '--apply', target], { env: {}, home, repoRoot, nodePath, exec, which: () => true, out: (s) => (o.out += s), err: () => {} });
    return { code, out: o.out };
  };

  it.each([['codex'], ['claude']] as const)('%s: says the previous registration was removed and how to retry', async (t) => {
    const r = await runTarget(t, false);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/add exploded/);
    expect(r.out).toMatch(/previous "agent-chat" registration was removed/);
    expect(r.out).toMatch(/now absent/);
    expect(r.out).toContain(`npm run connect -- --apply ${t}`);
  });

  it.each([['codex'], ['claude']] as const)('%s: does not claim a removal when there was nothing to remove', async (t) => {
    const r = await runTarget(t, true);
    expect(r.out).toMatch(/add exploded/);
    expect(r.out).not.toMatch(/was removed/);
  });
});

describe('isEntryPoint', () => {
  it('is true for the module itself, also when reached through a symlinked checkout', () => {
    const dir = mk();
    const real = join(dir, 'real');
    mkdirSync(real);
    const file = join(real, 'connect.ts');
    writeFileSync(file, '');
    symlinkSync(real, join(dir, 'link'));
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(url, file)).toBe(true);
    // before the fix this compared URLs literally and the script exited 0 without doing anything
    expect(isEntryPoint(url, join(dir, 'link', 'connect.ts'))).toBe(true);
  });

  it('is false for another file, a missing argv path, or one that does not exist', () => {
    const dir = mk();
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, '');
    writeFileSync(b, '');
    expect(isEntryPoint(pathToFileURL(a).href, b)).toBe(false);
    expect(isEntryPoint(pathToFileURL(a).href, undefined)).toBe(false);
    expect(isEntryPoint(pathToFileURL(a).href, join(dir, 'missing.ts'))).toBe(false);
  });
});
