import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config';
import { ensureToken } from '../src/tokenStore';

describe('ConfigStore', () => {
  it('creates a private config without a token and persists updates', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agentchat-')), 'nested');
    const c1 = new ConfigStore(dir);
    expect('token' in c1.get()).toBe(false);
    expect(c1.takeLegacyToken()).toBeNull();
    expect(c1.get().triageAgent).toBeNull();
    expect(c1.get().dsh).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).not.toHaveProperty('token');
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);

    c1.update({ dsh: { provider: 'p', model: 'm' } });
    const c2 = new ConfigStore(dir);
    expect(c2.get().dsh).toEqual({ provider: 'p', model: 'm' });
  });

  const legacyFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentchat-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({ token: 'old-token', triage: { baseUrl: 'http://x/v1', secret: 'k', model: 'm' }, dsh: { provider: 'p', model: 'm' } }),
      { mode: 0o644 },
    );
    return { dir, file };
  };

  it('hands over a legacy token once without touching the file until commit', () => {
    const { dir, file } = legacyFile();
    const before = readFileSync(file);
    const c = new ConfigStore(dir);
    expect(c.takeLegacyToken()).toBe('old-token');
    expect(c.takeLegacyToken()).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('commitLegacyMigration rewrites the file without token and triage at 0600', () => {
    const { dir, file } = legacyFile();
    const c = new ConfigStore(dir);
    c.takeLegacyToken();
    c.commitLegacyMigration();
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk).not.toHaveProperty('token');
    expect(disk).not.toHaveProperty('triage');
    expect(disk.dsh).toEqual({ provider: 'p', model: 'm' });
    expect(readFileSync(file, 'utf8')).not.toContain('old-token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('commitLegacyMigration is a no-op when nothing was legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentchat-'));
    const c = new ConfigStore(dir);
    const before = readFileSync(join(dir, 'config.json'));
    c.commitLegacyMigration();
    expect(readFileSync(join(dir, 'config.json')).equals(before)).toBe(true);
  });

  it('update before commit keeps the legacy token on disk', () => {
    const { dir, file } = legacyFile();
    const c = new ConfigStore(dir);
    c.takeLegacyToken();
    c.update({ triageAgent: 'x' });
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.token).toBe('old-token');
    expect(disk.triageAgent).toBe('x');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the legacy token on disk when the keychain write fails', () => {
    const { dir, file } = legacyFile();
    const c = new ConfigStore(dir);
    const failing = { get: () => null, set: () => { throw new Error('boom'); } };
    expect(() => ensureToken(failing, c.takeLegacyToken())).toThrow('boom');
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('old-token');
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('old-token');
  });

  it('ignores an empty or non-string legacy token', () => {
    for (const bad of ['', 5]) {
      const dir = mkdtempSync(join(tmpdir(), 'agentchat-'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ token: bad, dsh: null }));
      const c = new ConfigStore(dir);
      expect(c.takeLegacyToken()).toBeNull();
      c.commitLegacyMigration();
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).not.toHaveProperty('token');
    }
  });
});
