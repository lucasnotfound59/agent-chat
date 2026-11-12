import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
      ['codex', `codex mcp add agent-chat -- ${cmd('codex')}`],
      ['codex', `set tool_timeout_sec = 600 in [mcp_servers.agent-chat] of /fake/home/.codex/config.toml`],
      ['claude', `claude mcp add -s user agent-chat -- ${cmd('claude')}`],
      ['opencode', `opencode mcp add --global agent-chat -- ${cmd('opencode')}`],
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
      ['opencode', 'no change: opencode has no "mcp remove"; delete the "agent-chat" entry under "mcp" in ~/.config/opencode/opencode.json (or opencode.jsonc) by hand'],
      ['dsh', 'remove the agent-chat block from /fake/home/.dsh/profiles/web/cordis.patch.yml'],
      ['dsh', 'remove the agent-chat block from /fake/home/.dsh/profiles/tui/cordis.patch.yml'],
    ]);
  });

  it('quotes arguments that need it', () => {
    const [s] = planConnect({ targets: ['claude'], repoRoot: '/my repo', home: '/h', nodePath: '/n o/node', dshProfiles: [] });
    expect(s.display).toContain(`'/n o/node' --import file:///my%20repo/node_modules/tsx/dist/loader.mjs '/my repo/packages/mcp/src/main.ts' --as claude`);
  });

  it('only plans the requested targets; dsh with no profiles plans nothing', () => {
    expect(plan(planConnect, '/h', ['claude']).map((s) => s.target)).toEqual(['claude']);
    expect(planConnect({ targets: ['dsh'], repoRoot, home: '/h', nodePath, dshProfiles: [] })).toEqual([]);
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
      ['codex', ['mcp', 'add', 'agent-chat', '--', ...c('codex')]],
      ['claude', ['mcp', 'add', '-s', 'user', 'agent-chat', '--', ...c('claude')]],
      ['opencode', ['mcp', 'add', '--global', 'agent-chat', '--', ...c('opencode')]],
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
    const opts = { targets: ['dsh'] as Target[], repoRoot, home, nodePath, dshProfiles: ['web'] };

    for (const s of planConnect(opts)) await s.run();
    const once = readFileSync(file, 'utf8');
    expect(readFileSync(`${file}.agent-chat.bak`, 'utf8')).toBe(original);
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain('# >>> agent-chat\n');
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
    const [s] = planConnect({ targets: ['dsh'], repoRoot, home, nodePath, dshProfiles: ['web'] });
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
    expect(o.out).toContain('opencode mcp add --global agent-chat --');
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
      exec: async (f) => {
        calls.push(f);
        if (f === 'codex') throw new Error('boom');
      },
      ...w,
    });
    expect(code).toBe(1);
    expect(calls).toEqual(['codex', 'claude']); // the codex timeout step is not attempted after its add failed
    expect(o.out).toMatch(/FAILED.*boom/);
  });

  it('rejects unknown arguments', async () => {
    const { o, w } = io();
    expect(await runCli(['connect', 'vim'], { ...base(mk(), async () => {}), ...w })).toBe(2);
    expect(o.err).toMatch(/vim/);
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
    for (const frag of ['codex mcp add agent-chat --', 'tool_timeout_sec = 600', 'claude mcp add -s user agent-chat --', 'opencode mcp add --global agent-chat --', 'cordis.patch.yml']) {
      expect(out).toContain(frag);
    }
    expect(existsSync(marker)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  }, 30000);
});
