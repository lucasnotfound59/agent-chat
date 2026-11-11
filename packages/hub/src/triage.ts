import type { TriageConfig } from './config';

export interface TriageInput {
  transcript: { sender: string; body: string }[];
  candidates: { id: string; name: string; bio: string }[];
}

export interface Triage {
  /** Returns candidate ids in speaking order; may be empty. */
  pick(input: TriageInput): Promise<string[]>;
}

const SYSTEM = [
  'You moderate a group chat between a human and several AI agents.',
  'Given the recent messages and the agents who could speak, decide which agents should speak next and in what order.',
  'Pick an agent only if it can add something the conversation needs. Prefer few speakers.',
  'Return an empty list when nobody needs to respond, for example after a simple acknowledgement or when the topic has reached a natural end.',
  'Answer with JSON only: {"speakers": ["exact agent name", ...]}',
].join(' ');

export function parseSpeakers(content: string, candidates: TriageInput['candidates']): string[] {
  const obj = JSON.parse(content);
  const names: unknown[] = Array.isArray(obj?.speakers) ? obj.speakers : [];
  const ids: string[] = [];
  for (const name of names) {
    const c = candidates.find((x) => x.name === name);
    if (c && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}

export class OpenAITriage implements Triage {
  constructor(
    private readonly cfg: TriageConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pick(input: TriageInput): Promise<string[]> {
    const user = [
      'Agents who could speak:',
      ...input.candidates.map((c) => `- ${c.name}: ${c.bio}`),
      '',
      'Recent messages:',
      ...input.transcript.map((m) => `${m.sender}: ${m.body}`),
    ].join('\n');
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`triage request failed with HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return parseSpeakers(data?.choices?.[0]?.message?.content ?? '', input.candidates);
  }
}
