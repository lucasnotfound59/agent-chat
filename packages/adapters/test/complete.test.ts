import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterError, FakeAdapter, INVOCATION_ENV, claudeArgs, codexArgs, completeCli, dshArgs, jsonLines, opencodeArgs,
} from '../src/index';
import type { CompleteRequest } from '../src/index';

const node = process.execPath;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'complete-')));
const creq = (): CompleteRequest => ({
  prompt: 'p', workdir: dir, signal: new AbortController().signal, timeoutMs: 5000,
});
const parse = (stdout: string) => {
  const e = jsonLines(stdout)[0];
  return { text: e.text, sessionId: 's' };
};

describe('completeCli', () => {
  it('returns the trimmed parsed text', async () => {
    const out = await completeCli(
      { cmd: node, args: ['-e', `console.log(JSON.stringify({text:'  [[PASS]] hi \\n'}))`] },
      creq(),
      parse,
    );
    expect(out).toBe('[[PASS]] hi');
  });

  it('throws crashed on empty text', async () => {
    const p = completeCli({ cmd: node, args: ['-e', `console.log(JSON.stringify({text:'  '}))`] }, creq(), parse);
    await expect(p).rejects.toBeInstanceOf(AdapterError);
    await expect(p).rejects.toMatchObject({ code: 'crashed' });
  });

  it('wraps parse failures as crashed', async () => {
    const p = completeCli({ cmd: node, args: ['-e', `console.error('boom')`] }, creq(), () => {
      throw new Error('no output');
    });
    await expect(p).rejects.toMatchObject({ code: 'crashed' });
  });

  it('marks the child environment and sets PWD', async () => {
    const out = await completeCli(
      {
        cmd: node,
        args: ['-e', `console.log(JSON.stringify({text: process.env.AGENTCHAT_INVOCATION + '|' + process.env.PWD}))`],
      },
      creq(),
      parse,
    );
    expect(out).toBe(`1|${dir}`);
    expect(INVOCATION_ENV).toEqual({ AGENTCHAT_INVOCATION: '1' });
  });

  it('passes stdin', async () => {
    const out = await completeCli(
      {
        cmd: node,
        args: ['-e', `process.stdin.on('data', d => console.log(JSON.stringify({text: 'got ' + d})))`],
        stdin: 'raw',
      },
      creq(),
      parse,
    );
    expect(out).toBe('got raw');
  });
});

describe('complete args carry no session id', () => {
  const fresh = { workdir: '/w', harnessSessionId: null };
  it('codex', () => {
    expect(codexArgs(fresh).join(' ')).not.toMatch(/resume/);
  });
  it('claude', () => {
    expect(claudeArgs(fresh)).not.toContain('--resume');
  });
  it('dsh', () => {
    expect(dshArgs(fresh, null)).not.toContain('--session-id');
  });
  it('opencode', () => {
    expect(opencodeArgs(fresh, 'x')).not.toContain('--session');
  });
});

describe('FakeAdapter.complete', () => {
  it('records calls and returns the scripted result', async () => {
    const a = new FakeAdapter('f', 'F');
    expect(await a.complete(creq())).toBe('{"speakers":[]}');
    a.completeHandler = async () => 'scripted';
    expect(await a.complete(creq())).toBe('scripted');
    expect(a.completeCalls).toHaveLength(2);
    expect(a.completeCalls[0].prompt).toBe('p');
  });
});
