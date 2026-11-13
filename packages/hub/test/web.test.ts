import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '@agent-chat/adapters';
import { AskService } from '../src/ask';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

function makeApp(webRoot?: string) {
  const store = new Store(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-web-'));
  const fa = new FakeAdapter('fake-a', 'A');
  seed(store, [fa]);
  const bus = new Bus();
  const scheduler = new Scheduler({
    store,
    adapters: new Map([[fa.name, fa]]),
    triage: () => null,
    emit: (e) => bus.emit(e),
    dataDir,
    isAvailable: () => true,
  });
  const ask = new AskService({ store, scheduler, isAvailable: () => true, availabilityReason: () => undefined, emit: (e) => bus.emit(e) });
  return buildServer({
    store,
    scheduler,
    config: new ConfigStore(dataDir),
    token: () => 'tok',
    bus,
    availability: new Map([['fake-a', { ok: true }]]),
    ask,
    refreshAvailability: async () => {},
    webRoot,
  });
}

function builtWeb(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentchat-dist-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root">INDEX</div>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log(1)');
  return root;
}

describe('web UI files', () => {
  it('serves index.html and assets without a token, and keeps /api behind the token', async () => {
    const app = makeApp(builtWeb());
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('INDEX');

    const js = await app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toContain('immutable');

    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
  });

  it('falls back to index.html for unknown pages and never leaves the web root', async () => {
    const app = makeApp(builtWeb());
    expect((await app.inject({ method: 'GET', url: '/some/page' })).body).toContain('INDEX');
    const escape = await app.inject({ method: 'GET', url: '/%2e%2e/%2e%2e/package.json' });
    expect(escape.body).toContain('INDEX');
    expect(escape.body).not.toContain('"name"');
  });

  it('answers unknown /api paths with a JSON 404, not the page', async () => {
    const app = makeApp(builtWeb());
    const r = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not found' });
  });

  it('still checks the Host header', async () => {
    const app = makeApp(builtWeb());
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  it('shows a build hint when the web UI has not been built', async () => {
    const app = makeApp(mkdtempSync(join(tmpdir(), 'agentchat-empty-')));
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('npm run build');
  });

  it('exposes nothing without a web root', async () => {
    const app = makeApp(undefined);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });
});
