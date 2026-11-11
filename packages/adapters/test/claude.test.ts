import { describe, expect, it } from 'vitest';
import { claudeArgs, parseClaude, parseClaudeAuth, ClaudeAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'Claude Code',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const TOOLS = 'Read,WebSearch,WebFetch';

describe('claudeArgs', () => {
  it('prints JSON with only read and web tools', () => {
    expect(claudeArgs(req)).toEqual([
      '-p', '--output-format', 'json', '--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config',
    ]);
  });
  it('resumes by session id', () => {
    expect(claudeArgs({ ...req, harnessSessionId: 'abc' })).toEqual([
      '-p', '--output-format', 'json', '--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config',
      '--resume', 'abc',
    ]);
  });
});

describe('parseClaude', () => {
  it('reads result and session id', () => {
    const out = '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"e7cf2f38"}';
    expect(parseClaude(out, null)).toEqual({ text: 'pong', sessionId: 'e7cf2f38' });
  });
  it('throws the result text when is_error is true', () => {
    const out = '{"type":"result","is_error":true,"result":"Not logged in · Please run /login","session_id":"x"}';
    expect(() => parseClaude(out, null)).toThrow(/Not logged in/);
  });
  it('ignores warning lines before the JSON', () => {
    const out = 'Warning: something\n{"type":"result","is_error":false,"result":"hi","session_id":"s"}\n';
    expect(parseClaude(out, null).text).toBe('hi');
  });
  it('throws when there is no result object', () => {
    expect(() => parseClaude('garbage', null)).toThrow(/no result/);
  });
});

describe('parseClaudeAuth', () => {
  it('is ok when logged in', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({ ok: true });
  });
  it('explains how to log in otherwise', () => {
    const a = parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}');
    expect(a.ok).toBe(false);
    expect(a.reason).toContain('/login');
  });
  it('treats unparseable output as not logged in', () => {
    expect(parseClaudeAuth('???').ok).toBe(false);
  });
});

describe('ClaudeAdapter', () => {
  it('has stable identity', () => {
    expect(new ClaudeAdapter().name).toBe('claude');
  });
});
