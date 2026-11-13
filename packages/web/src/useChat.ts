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
      dispatch({ type: 'messages', conversationId: id, messages, older: false });
    },
    [api],
  );

  // After every (re)connect: reload state and the open conversation so nothing missed stays missing.
  const resync = useCallback(async () => {
    try {
      dispatch({ type: 'state', state: await api.state() });
      const id = activeRef.current;
      if (id) await loadLatest(id);
    } catch (e) {
      handled(e);
    }
  }, [api, loadLatest, handled]);

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
      dispatch({ type: 'messages', conversationId: id, messages: await api.messages(id, first.seq), older: true });
    } catch (e) {
      if (!handled(e)) throw e;
    }
  }, [api, handled]);

  /** Errors reach the caller (the composer shows them); the message itself arrives over the websocket. */
  const send = useCallback(
    async (body: string) => {
      const id = activeRef.current;
      if (!id) return;
      try {
        await api.send(id, body);
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, handled],
  );

  const createGroup = useCallback(
    async (title: string, memberIds: string[]) => {
      try {
        const conversation = await api.createGroup(title, memberIds);
        dispatch({ type: 'event', event: { type: 'conversation', conversation } });
        select(conversation.id);
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, select, handled],
  );

  const togglePause = useCallback(async () => {
    const conv = stateRef.current.conversations.find((c) => c.id === activeRef.current);
    if (!conv) return;
    try {
      const conversation = await api.setPaused(conv.id, !conv.settings.paused);
      dispatch({ type: 'event', event: { type: 'conversation', conversation } });
    } catch (e) {
      handled(e);
    }
  }, [api, handled]);

  const setStopped = useCallback(
    async (stop: boolean) => {
      try {
        const r = stop ? await api.stop() : await api.resume();
        dispatch({ type: 'event', event: { type: 'stopped', stopped: r.stopped } });
      } catch (e) {
        handled(e);
      }
    },
    [api, handled],
  );

  const refreshAvailability = useCallback(async () => {
    try {
      const all = await api.refreshAvailability();
      for (const [adapter, availability] of Object.entries(all)) {
        dispatch({ type: 'event', event: { type: 'availability', adapter, availability } });
      }
    } catch (e) {
      handled(e);
    }
  }, [api, handled]);

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
