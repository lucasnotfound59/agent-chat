import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  opencodeArgs, parseOpenCode, OpenCodeAdapter,
  OPENCODE_AGENT_NAME, opencodeConfigContent, ensureOpenCodeConfig,
} from '../src/index';
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
  it('uses the read-only agentchat agent and passes the prompt as the message, after --', () => {
    expect(opencodeArgs(req, 'PROMPT')).toEqual(['run', '--format', 'json', '--agent', 'agentchat', '--', 'PROMPT']);
  });
  it('adds the session when resuming', () => {
    expect(opencodeArgs({ ...req, harnessSessionId: sid }, 'PROMPT')).toEqual([
      'run', '--format', 'json', '--agent', 'agentchat', '--session', sid, '--', 'PROMPT',
    ]);
  });
  it('a prompt that starts with dashes stays the message (checked once against opencode v2.2.6)', () => {
    const args = opencodeArgs(req, '--help me');
    expect(args.slice(-2)).toEqual(['--', '--help me']);
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

describe('ensureOpenCodeConfig', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'oc-cfg-'));

  it('writes a config whose agent denies everything except read-only tools', () => {
    const dir = tmp();
    ensureOpenCodeConfig(dir);
    const text = readFileSync(join(dir, 'opencode.json'), 'utf8');
    expect(text).toBe(opencodeConfigContent());
    expect(text.endsWith('\n')).toBe(true);
    const cfg = JSON.parse(text);
    expect(OPENCODE_AGENT_NAME).toBe('agentchat');
    const perm = cfg.agent.agentchat.permission;
    expect(perm['*']).toBe('deny');
    expect(perm.read).toBe('allow');
    for (const k of ['shell', 'bash', 'edit', 'write']) expect(perm[k]).not.toBe('allow');
  });
  it('is idempotent', () => {
    const dir = tmp();
    ensureOpenCodeConfig(dir);
    ensureOpenCodeConfig(dir);
    expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe(opencodeConfigContent());
  });
  it('restores a tampered file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'opencode.json'), '{"agent":{"agentchat":{"permission":{"*":"allow"}}}}');
    ensureOpenCodeConfig(dir);
    expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe(opencodeConfigContent());
  });
  it('creates a missing directory', () => {
    const dir = join(tmp(), 'a', 'b');
    ensureOpenCodeConfig(dir);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(true);
  });
});
