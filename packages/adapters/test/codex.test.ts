import { describe, expect, it } from 'vitest';
import { codexArgs, parseCodex, CodexAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'Codex',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/data/workspaces/codex',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const OK = [
  '{"type":"thread.started","thread_id":"01a1c958-fbff-7b70-84bd-9647eb7f1ae4"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"thinking out loud"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":24088,"output_tokens":5}}',
].join('\n');

describe('codexArgs', () => {
  it('starts a read-only session in the workdir', () => {
    expect(codexArgs(req)).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', '/data/workspaces/codex', '-',
    ]);
  });
  it('resumes with the sandbox set through config', () => {
    expect(codexArgs({ ...req, harnessSessionId: 'abc' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'abc', '-',
    ]);
  });
});

describe('parseCodex', () => {
  it('takes the thread id and the last agent message', () => {
    expect(parseCodex(OK, null)).toEqual({ text: 'pong', sessionId: '01a1c958-fbff-7b70-84bd-9647eb7f1ae4' });
  });
  it('falls back to the known session id when none is emitted', () => {
    const noThread = OK.split('\n').slice(1).join('\n');
    expect(parseCodex(noThread, 'known').sessionId).toBe('known');
  });
  it('throws when there is no agent message', () => {
    expect(() => parseCodex('{"type":"thread.started","thread_id":"x"}\n', null)).toThrow(/no agent message/);
  });
  it('throws when there is no session id at all', () => {
    expect(() => parseCodex('{"type":"item.completed","item":{"type":"agent_message","text":"x"}}', null)).toThrow(
      /no session id/,
    );
  });
});

describe('CodexAdapter', () => {
  it('has stable identity', () => {
    const a = new CodexAdapter();
    expect(a.name).toBe('codex');
    expect(a.displayName).toBe('Codex');
  });
});
