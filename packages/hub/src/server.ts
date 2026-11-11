import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Availability } from '@agent-chat/adapters';
import type { ConfigStore, TriageConfig } from './config';
import { parseMentions } from './mentions';
import type { Scheduler } from './scheduler';
import type { Store } from './store';
import type { Attachment, HubEvent, Settings } from './types';

export class Bus {
  private readonly listeners = new Set<(e: HubEvent) => void>();
  emit(e: HubEvent): void {
    for (const fn of this.listeners) fn(e);
  }
  on(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface ServerDeps {
  store: Store;
  scheduler: Scheduler;
  config: ConfigStore;
  bus: Bus;
  availability: Map<string, Availability>;
}

const NUMERIC_SETTINGS = ['debounceMs', 'maxAgentRounds', 'dailyInvocationCap', 'timeoutMs'] as const;

function cleanSettings(input: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of NUMERIC_SETTINGS) {
    const v = input[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) patch[key] = Math.floor(v);
  }
  if (typeof input.paused === 'boolean') patch.paused = input.paused;
  return patch;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { store, scheduler, config, bus, availability } = deps;
  const app = Fastify({ bodyLimit: 50 * 1024 * 1024 });
  const attachmentsRoot = join(config.dataDir, 'attachments');
  const me = () => store.listMembers().find((m) => m.kind === 'human')!;

  const publicConfig = () => {
    const c = config.get();
    return {
      triage: c.triage ? { baseUrl: c.triage.baseUrl, model: c.triage.model, hasKey: Boolean(c.triage.apiKey) } : null,
      dsh: c.dsh,
    };
  };

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.headers.authorization !== `Bearer ${config.get().token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.register(async (ws) => {
    ws.get('/ws', { websocket: true }, (socket) => {
      let off: (() => void) | null = null;
      socket.on('message', (raw: Buffer) => {
        if (off) return;
        let msg: any = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          // handled below
        }
        if (msg?.type !== 'auth' || msg.token !== config.get().token) {
          socket.close(4001, 'unauthorized');
          return;
        }
        off = bus.on((e) => socket.send(JSON.stringify(e)));
        socket.send(JSON.stringify({ type: 'ready' }));
      });
      socket.on('close', () => off?.());
    });
  });

  app.get('/api/state', async () => ({
    me: me(),
    members: store.listMembers().map((m) => ({
      ...m,
      availability: m.adapter ? (availability.get(m.adapter) ?? { ok: false, reason: '尚未检查' }) : null,
    })),
    conversations: store.listConversations(),
    stopped: scheduler.isStopped(),
  }));

  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string; limit?: string } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      if (!store.getConversation(req.params.id)) return reply.code(404).send({ error: 'unknown conversation' });
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const beforeSeq = req.query.beforeSeq ? Number(req.query.beforeSeq) : undefined;
      return store.listMessages(req.params.id, { beforeSeq, limit });
    },
  );

  app.post<{ Body: { title?: string; memberIds?: string[] } }>('/api/conversations', async (req, reply) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const ids = Array.isArray(req.body?.memberIds) ? req.body.memberIds.filter((id) => store.getMember(id)) : [];
    if (!title || ids.length === 0) return reply.code(400).send({ error: 'title and memberIds are required' });
    const conversation = store.createConversation({ kind: 'group', title, memberIds: [me().id, ...ids] });
    bus.emit({ type: 'conversation', conversation });
    return conversation;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/conversations/:id/settings',
    async (req, reply) => {
      const before = store.getConversation(req.params.id);
      if (!before) return reply.code(404).send({ error: 'unknown conversation' });
      const conversation = store.updateSettings(req.params.id, cleanSettings(req.body ?? {}));
      if (conversation.settings.paused && !before.settings.paused) scheduler.abortConversation(conversation.id);
      if (!conversation.settings.paused && before.settings.paused) scheduler.kick(conversation.id);
      bus.emit({ type: 'conversation', conversation });
      return conversation;
    },
  );

  app.post<{ Params: { id: string }; Body: { body?: string; replyTo?: string; attachments?: Attachment[] } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      const conv = store.getConversation(req.params.id);
      if (!conv) return reply.code(404).send({ error: 'unknown conversation' });
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : []).filter(
        (a) => typeof a?.name === 'string' && typeof a?.file === 'string' && a.file.startsWith(`${conv.id}/`),
      );
      if (!body && attachments.length === 0) return reply.code(400).send({ error: 'empty message' });
      const sender = me();
      const message = store.addMessage({
        conversationId: conv.id,
        senderId: sender.id,
        body,
        mentions: parseMentions(body, store.listConversationMembers(conv.id), sender.id),
        replyTo: typeof req.body?.replyTo === 'string' ? req.body.replyTo : null,
        attachments,
      });
      bus.emit({ type: 'message', message });
      scheduler.onMessage(message);
      return message;
    },
  );

  app.post<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
    '/api/conversations/:id/attachments',
    async (req, reply) => {
      if (!store.getConversation(req.params.id)) return reply.code(404).send({ error: 'unknown conversation' });
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'send raw bytes as application/octet-stream' });
      const name = basename(req.query.name || 'file');
      const safe = name.replace(/[^\p{L}\p{N}._-]+/gu, '_');
      const file = `${req.params.id}/${randomUUID()}-${safe}`;
      mkdirSync(join(attachmentsRoot, req.params.id), { recursive: true });
      writeFileSync(join(attachmentsRoot, file), req.body);
      const attachment: Attachment = { name, file };
      return attachment;
    },
  );

  app.get<{ Params: { '*': string } }>('/api/attachments/*', async (req, reply) => {
    const full = resolve(attachmentsRoot, req.params['*']);
    if (!full.startsWith(resolve(attachmentsRoot) + sep) || !existsSync(full)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('application/octet-stream').send(readFileSync(full));
  });

  app.patch<{ Params: { id: string }; Body: { bio?: string } }>('/api/members/:id', async (req, reply) => {
    if (!store.getMember(req.params.id)) return reply.code(404).send({ error: 'unknown member' });
    if (typeof req.body?.bio !== 'string') return reply.code(400).send({ error: 'bio is required' });
    store.updateMemberBio(req.params.id, req.body.bio);
    return store.getMember(req.params.id);
  });

  app.post('/api/stop', async () => {
    scheduler.stopAll();
    return { stopped: true };
  });

  app.post('/api/resume', async () => {
    scheduler.resumeAll();
    return { stopped: false };
  });

  app.post<{ Params: { id: string } }>('/api/invocations/:id/retry', async (req) => {
    const inv = store.getInvocation(req.params.id);
    if (!inv) return { started: false };
    // Runs in the background; the outcome arrives as message events.
    const started = scheduler.retryInvocation(req.params.id);
    void started.catch(() => {});
    return { started: true };
  });

  app.get('/api/config', async () => publicConfig());

  app.put<{ Body: { triage?: TriageConfig | null; dsh?: { provider: string; model: string } | null } }>(
    '/api/config',
    async (req) => {
      const patch: Parameters<ConfigStore['update']>[0] = {};
      const b = req.body ?? {};
      if (b.triage === null) patch.triage = null;
      else if (b.triage && typeof b.triage.baseUrl === 'string' && typeof b.triage.model === 'string') {
        // An empty key keeps the stored one, so the UI can edit other fields without re-entering it.
        const apiKey = b.triage.apiKey || config.get().triage?.apiKey || '';
        patch.triage = { baseUrl: b.triage.baseUrl, model: b.triage.model, apiKey };
      }
      if (b.dsh === null) patch.dsh = null;
      else if (b.dsh && typeof b.dsh.provider === 'string' && typeof b.dsh.model === 'string') {
        patch.dsh = { provider: b.dsh.provider, model: b.dsh.model };
      }
      config.update(patch);
      return publicConfig();
    },
  );

  return app;
}
