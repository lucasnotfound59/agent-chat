import { describe, expect, it } from 'vitest';
import { parsePort } from '../src/env';

describe('parsePort (AGENTCHAT_PORT)', () => {
  it('defaults to 4317 when unset', () => {
    expect(parsePort(undefined)).toBe(4317);
  });

  it('accepts a decimal port 1-65535', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('4396')).toBe(4396);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects what Number() would quietly turn into a different port', () => {
    // '' -> 0 (a random port), '0x10' -> 16, ' 80' -> 80, '1e3' -> 1000, 'abc' -> NaN
    for (const bad of ['', '0', '65536', '0x10', ' 80', '80 ', '1e3', '-1', '4317.5', 'abc', '123456']) {
      expect(() => parsePort(bad), bad).toThrow(/AGENTCHAT_PORT/);
    }
  });
});
