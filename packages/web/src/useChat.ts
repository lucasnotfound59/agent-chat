import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { HubDownError, UnauthorizedError, createApi } from './api';
import { initialState, reduce } from './store';
import { forgetToken } from './token';
import { connectHub } from './ws';

export function useChat(token: string) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const api = useMemo(() => createApi(token), [token]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const stateRef = useRef(state);
  stateRef.current = state;

  /** An API call just succeeded, so the hub is reachable: clear an HTTP-set hub_down (never unauthorized). */
  const reachable = useCallback(() => {
    if (stateRef.current.connection === 'hub_down') dispatch({ type: 'connection', connection: 'open' });
  }, []);

  /** Handles errors every action shares; returns true when it did. */
  const handled = useCallback((e: unknown): boolean => {
    if (e instanceof UnauthorizedError) {
      forgetToken();
      dispatch({ type: 'connection', connection: 'unauthorized' });
      return true;
    }
    if (e instanceof HubDownError) {
      dispatch({ type: 'connection', connection: 'hub_down' });
      return true;
    }
    return false;
  }, []);

  const loadLatest = useCallback(
    async (id: string) => {
      const messages = await api.messages(id);
      reachable();
      dispatch({ type: 'messages', conversationId: id, messages, older: false });
    },
    [api, reachable],
  );

  // After every (re)connect: reload state and the open conversation so nothing missed stays missing.
  const resync = useCallback(async () => {
    try {
      const fresh = await api.state();
      reachable();
      dispatch({ type: 'state', state: fresh });
      const id = activeRef.current;
      if (id) await loadLatest(id);
    } catch (e) {
      handled(e);
    }
  }, [api, loadLatest, handled, reachable]);

  useEffect(() => {
    const conn = connectHub({
      token,
      onEvent: (event) => dispatch({ type: 'event', event }),
      onStatus: (s) => {
        const cur = stateRef.current.connection;
        if (cur === 'unauthorized') return;
        // A retry attempt must not hide the hub-down banner between failures.
        if (s === 'connecting' && (cur === 'closed' || cur === 'hub_down')) return;
        dispatch({ type: 'connection', connection: s });
      },
      onReady: () => void resync(),
      onUnauthorized: () => {
        forgetToken();
        dispatch({ type: 'connection', connection: 'unauthorized' });
      },
    });
    return () => conn.close();
  }, [token, resync]);

  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      loadLatest(id).catch(handled);
    },
    [loadLatest, handled],
  );

  const loadOlder = useCallback(async () => {
    const id = activeRef.current;
    const first = id ? stateRef.current.messages[id]?.[0] : undefined;
    if (!id || !first) return;
    try {
      const older = await api.messages(id, first.seq);
      reachable();
      dispatch({ type: 'messages', conversationId: id, messages: older, older: true });
    } catch (e) {
      if (!handled(e)) throw e;
    }
  }, [api, handled, reachable]);

  /** Errors reach the caller (the composer shows them); the message itself arrives over the websocket. */
  const send = useCallback(
    async (body: string) => {
      const id = activeRef.current;
      if (!id) return;
      try {
        await api.send(id, body);
        reachable();
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, handled, reachable],
  );

  const createGroup = useCallback(
    async (title: string, memberIds: string[]) => {
      try {
        const conversation = await api.createGroup(title, memberIds);
        reachable();
        dispatch({ type: 'event', event: { type: 'conversation', conversation } });
        select(conversation.id);
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, select, handled, reachable],
  );

  const togglePause = useCallback(async () => {
    const conv = stateRef.current.conversations.find((c) => c.id === activeRef.current);
    if (!conv) return;
    try {
      const conversation = await api.setPaused(conv.id, !conv.settings.paused);
      reachable();
      dispatch({ type: 'event', event: { type: 'conversation', conversation } });
    } catch (e) {
      handled(e);
    }
  }, [api, handled, reachable]);

  const setStopped = useCallback(
    async (stop: boolean) => {
      try {
        const r = stop ? await api.stop() : await api.resume();
        reachable();
        dispatch({ type: 'event', event: { type: 'stopped', stopped: r.stopped } });
      } catch (e) {
        handled(e);
      }
    },
    [api, handled, reachable],
  );

  const refreshAvailability = useCallback(async () => {
    try {
      const all = await api.refreshAvailability();
      reachable();
      for (const [adapter, availability] of Object.entries(all)) {
        dispatch({ type: 'event', event: { type: 'availability', adapter, availability } });
      }
    } catch (e) {
      handled(e);
    }
  }, [api, handled, reachable]);

  return {
    state,
    activeId,
    select,
    loadOlder,
    send,
    createGroup,
    togglePause,
    stop: () => setStopped(true),
    resume: () => setStopped(false),
    refreshAvailability,
  };
}
