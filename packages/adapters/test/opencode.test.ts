import { describe, expect, it } from 'vitest';
import { opencodeArgs, parseOpenCode, OpenCodeAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'OpenCode',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const sid = 'ses_e36a6f745ffetZxOQMlP3EF8dd';
const ev = (type: string, part: object) => JSON.stringify({ type, timestamp: 1, sessionID: sid, part });
const OK = [
  ev('step_start', { type: 'step-start' }),
  ev('text', { type: 'text', text: 'let me look' }),
  ev('step_finish', { type: 'step-finish', reason: 'tool-calls' }),
  ev('step_start', { type: 'step-start' }),
  ev('text', { type: 'text', text: 'first part' }),
  ev('text', { type: 'text', text: 'second part' }),
  ev('step_finish', { type: 'step-finish', reason: 'stop' }),
].join('\n');

describe('opencodeArgs', () => {
  it('uses the read-only plan agent and passes the prompt as the message', () => {
    expect(opencodeArgs(req, 'PROMPT')).toEqual(['run', '--format', 'json', '--agent', 'plan', 'PROMPT']);
  });
  it('adds the session when resuming', () => {
    expect(opencodeArgs({ ...req, harnessSessionId: sid }, 'PROMPT')).toEqual([
      'run', '--format', 'json', '--agent', 'plan', '--session', sid, 'PROMPT',
    ]);
  });
});

describe('parseOpenCode', () => {
  it('joins the text parts of the final step', () => {
    expect(parseOpenCode(OK, null)).toEqual({ text: 'first part\n\nsecond part', sessionId: sid });
  });
  it('throws when there is no text', () => {
    expect(() => parseOpenCode(ev('step_start', {}), null)).toThrow(/no text/);
  });
  it('throws when there is no session id', () => {
    expect(() => parseOpenCode('{"type":"text","part":{"type":"text","text":"x"}}', null)).toThrow(/no session id/);
  });
});

describe('OpenCodeAdapter', () => {
  it('has stable identity', () => {
    expect(new OpenCodeAdapter().name).toBe('opencode');
  });
});
