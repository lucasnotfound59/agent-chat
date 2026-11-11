import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/mentions';
import { OpenAITriage, parseSpeakers } from '../src/triage';
import type { Member } from '../src/types';

const members: Member[] = [
  { id: 'h', kind: 'human', name: '我', bio: '', adapter: null },
  { id: 'a', kind: 'agent', name: 'Claude Code', bio: '', adapter: 'claude' },
  { id: 'b', kind: 'agent', name: 'Codex', bio: '', adapter: 'codex' },
];
const candidates = [
  { id: 'a', name: 'Claude Code', bio: 'x' },
  { id: 'b', name: 'Codex', bio: 'y' },
];

describe('parseMentions', () => {
  it('finds @Name for members, including names with spaces', () => {
    expect(parseMentions('@Claude Code 和 @Codex 看一下', members, 'h')).toEqual(['a', 'b']);
  });
  it('ignores self-mentions and unknown names', () => {
    expect(parseMentions('@Codex @Nobody', members, 'b')).toEqual([]);
  });
});

describe('parseSpeakers', () => {
  it('maps names to ids, keeps order, drops unknowns and duplicates', () => {
    expect(parseSpeakers('{"speakers":["Codex","Ghost","Claude Code","Codex"]}', candidates)).toEqual(['b', 'a']);
  });
  it('returns empty for a missing list', () => {
    expect(parseSpeakers('{}', candidates)).toEqual([]);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseSpeakers('nope', candidates)).toThrow();
  });
});

describe('OpenAITriage', () => {
  const cfg = { baseUrl: 'http://llm.test/v1/', apiKey: 'secret', model: 'small' };
  const input = { transcript: [{ sender: '我', body: '谁懂 Rust？' }], candidates };

  it('posts a chat completion and returns the picked ids', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"speakers":["Codex"]}' } }] }));
    }) as unknown as typeof fetch;

    expect(await new OpenAITriage(cfg, fakeFetch).pick(input)).toEqual(['b']);
    expect(seen!.url).toBe('http://llm.test/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    const body = JSON.parse(seen!.init.body as string);
    expect(body.model).toBe('small');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toContain('谁懂 Rust？');
    expect(body.messages[1].content).toContain('Claude Code: x');
  });

  it('throws on a non-2xx response', async () => {
    const fakeFetch = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(new OpenAITriage(cfg, fakeFetch).pick(input)).rejects.toThrow(/500/);
  });
});
