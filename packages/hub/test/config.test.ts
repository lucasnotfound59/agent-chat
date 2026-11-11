import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config';

describe('ConfigStore', () => {
  it('creates a private config with a token and persists updates', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agentchat-')), 'nested');
    const c1 = new ConfigStore(dir);
    const token = c1.get().token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(c1.get().triage).toBeNull();
    expect(c1.get().dsh).toBeNull();
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);

    c1.update({ triage: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } });
    const c2 = new ConfigStore(dir);
    expect(c2.get().token).toBe(token);
    expect(c2.get().triage).toEqual({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' });
  });

  it('regenerates a missing, empty or non-string token', () => {
    for (const bad of [undefined, '', 5]) {
      const dir = mkdtempSync(join(tmpdir(), 'agentchat-'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ token: bad, triage: null, dsh: null }));
      const c = new ConfigStore(dir);
      expect(c.get().token).toMatch(/^[0-9a-f]{48}$/);
      expect(new ConfigStore(dir).get().token).toBe(c.get().token);
    }
  });
});
