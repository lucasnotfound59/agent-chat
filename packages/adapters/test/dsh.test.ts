import { describe, expect, it } from 'vitest';
import { dshArgs, parseDsh, dshModelPatch, DshAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'DSH',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const sid = 'session-fead01dc-7569-438c-93d2-70e840639732';
const OK = [
  `{"type":"session","sessionId":"${sid}","cwd":"/w"}`,
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"text","text":"pong"}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  `{"type":"final","sessionId":"${sid}","reason":{"kind":"completed"},"text":"pong"}`,
].join('\n');
const FAIL = [
  `{"type":"session","sessionId":"${sid}","cwd":"/w"}`,
  `{"type":"final","sessionId":"${sid}","reason":{"kind":"error","error":{"message":"no adapter registered for provider \\"my-provider-responses\\"","code":"NO_ADAPTER"}},"text":""}`,
].join('\n');

describe('dshArgs', () => {
  it('runs headless, read-only, never asking', () => {
    expect(dshArgs(req, null)).toEqual([
      '--profile', 'headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never', '-',
    ]);
  });
  it('adds the model patch and the session id', () => {
    expect(dshArgs({ ...req, harnessSessionId: sid }, '/data/dsh-model.patch.yml')).toEqual([
      '--profile', 'headless', '--patch', '/data/dsh-model.patch.yml', '--json',
      '--permission-mode', 'read-only', '--approval-policy', 'never', '--session-id', sid, '-',
    ]);
  });
});

describe('parseDsh', () => {
  it('reads the final text and session id', () => {
    expect(parseDsh(OK, null)).toEqual({ text: 'pong', sessionId: sid });
  });
  it('throws the harness error message on a failed turn', () => {
    expect(() => parseDsh(FAIL, null)).toThrow(/no adapter registered/);
  });
  it('throws when there is no final event', () => {
    expect(() => parseDsh(`{"type":"session","sessionId":"${sid}"}`, null)).toThrow(/no final event/);
  });
});

describe('dshModelPatch', () => {
  it('renders a patch entry for the default model plugin', () => {
    expect(dshModelPatch('my-provider', 'my-provider/deepseek-flash')).toBe(
      [
        '- id: agent-default-model',
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        '  config:',
        '    provider: "my-provider"',
        '    model: "my-provider/deepseek-flash"',
        '',
      ].join('\n'),
    );
  });
});

describe('DshAdapter', () => {
  it('has stable identity', () => {
    expect(new DshAdapter().name).toBe('dsh');
  });
});
