import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Routes that serve the web UI; the auth hook lets them through (they hold no secrets). */
export const WEB_ROUTES = new Set(['/', '/*']);

export const MISSING_BUILD_PAGE =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent Chat</title>' +
  '<p>界面还没有构建。请在仓库目录运行 <code>npm run build</code>，然后刷新本页。</p></html>';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Serves the built UI from `webRoot`; unknown pages fall back to index.html. */
export function registerWeb(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const index = join(root, 'index.html');

  const send = (rel: string, reply: FastifyReply) => {
    if (!existsSync(index)) return reply.code(503).type('text/html; charset=utf-8').send(MISSING_BUILD_PAGE);
    let full = resolve(root, rel);
    if (!full.startsWith(root + sep) || !isFile(full)) full = index;
    const immutable = full !== index && rel.startsWith('assets/');
    return reply
      .type(TYPES[extname(full)] ?? 'application/octet-stream')
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(readFileSync(full));
  };

  app.get('/', async (_req, reply) => send('index.html', reply));
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const rel = req.params['*'];
    if (rel === 'api' || rel.startsWith('api/') || rel === 'ws') return reply.code(404).send({ error: 'not found' });
    return send(rel, reply);
  });
}
