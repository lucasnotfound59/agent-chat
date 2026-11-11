import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, liveProcessCount, killAllProcessGroups, jsonLines, invokeCli, checkCommand, AdapterError } from '../src/index';
import type { InvokeRequest } from '../src/index';

const node = process.execPath;
const opts = (code: string, extra: Partial<Parameters<typeof runProcess>[0]> = {}) => ({
  cmd: node,
  args: ['-e', code],
  cwd: tmpdir(),
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...extra,
});

describe('runProcess', () => {
  it('sets PWD to cwd so tools that read $PWD (OpenCode) see the right directory', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pwd-')));
    const r = await runProcess(opts('console.log(process.env.PWD)', { cwd: dir }));
    expect(r.stdout.trim()).toBe(dir);
  });

  it('captures stdout, stderr and exit code, and passes stdin', async () => {
    const r = await runProcess(
      opts(`process.stdin.on('data', d => { console.log('got ' + d); console.error('warn'); process.exitCode = 3; })`, {
        stdin: 'hello',
      }),
    );
    expect(r.stdout.trim()).toBe('got hello');
    expect(r.stderr.trim()).toBe('warn');
    expect(r.code).toBe(3);
  });

  it('rejects with timeout', async () => {
    await expect(runProcess(opts('setTimeout(() => {}, 10000)', { timeoutMs: 100 }))).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects with aborted when the signal fires', async () => {
    const ac = new AbortController();
    const p = runProcess(opts('setTimeout(() => {}, 10000)', { signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('kills grandchildren too when aborted', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'runproc-')), 'written');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 10000)`;
    const ac = new AbortController();
    const p = runProcess(opts(code, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    await new Promise((r) => setTimeout(r, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('tracks live children and returns to zero after abort and close', async () => {
    const before = liveProcessCount();
    const ac = new AbortController();
    const p = runProcess(opts('setTimeout(() => {}, 10000)', { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 200));
    expect(liveProcessCount()).toBe(before + 1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    const end = Date.now() + 3000;
    while (liveProcessCount() > before && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(liveProcessCount()).toBe(before);
  });

  it('killAllProcessGroups kills a running child and its grandchild', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'runproc-')), 'written');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 10000)`;
    const p = runProcess(opts(code));
    await new Promise((r) => setTimeout(r, 300));
    killAllProcessGroups('SIGKILL');
    await p;
    await new Promise((r) => setTimeout(r, 2000));
    expect(existsSync(marker)).toBe(false);
    expect(liveProcessCount()).toBe(0);
  });

  it('rejects with unavailable when the command does not exist', async () => {
    await expect(runProcess({ ...opts(''), cmd: 'definitely-not-a-command-xyz' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('jsonLines', () => {
  it('parses JSON lines and skips everything else', () => {
    expect(jsonLines('{"a":1}\nnot json\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('invokeCli', () => {
  const req: InvokeRequest = {
    conversationId: 'c',
    agentName: 'A',
    conversationTitle: 't',
    isGroup: true,
    harnessSessionId: 'old',
    newMessages: [],
    workdir: tmpdir(),
    signal: new AbortController().signal,
    timeoutMs: 5000,
  };

  it('runs the command, parses output and reports typing', async () => {
    let typed = 0;
    const r = await invokeCli(
      { cmd: node, args: ['-e', `console.log(JSON.stringify({text:'hi',sid:'s9'}))`] },
      { ...req, onTyping: () => typed++ },
      (stdout) => {
        const e = jsonLines(stdout)[0];
        return { text: e.text, sessionId: e.sid };
      },
    );
    expect(r).toEqual({ kind: 'reply', body: 'hi', harnessSessionId: 's9' });
    expect(typed).toBe(1);
  });

  it('wraps parse failures as crashed with stderr tail', async () => {
    const p = invokeCli({ cmd: node, args: ['-e', `console.error('boom'); process.exit(2)`] }, req, () => {
      throw new Error('no output');
    });
    await expect(p).rejects.toBeInstanceOf(AdapterError);
    await expect(p).rejects.toMatchObject({ code: 'crashed' });
    await expect(p).rejects.toThrow(/no output.*exit 2.*boom/s);
  });
});

describe('checkCommand', () => {
  it('is ok for an existing command and explains a missing one', async () => {
    expect(await checkCommand(node, 'Node')).toEqual({ ok: true });
    const bad = await checkCommand('definitely-not-a-command-xyz', 'Xyz');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('Xyz');
  });
});
