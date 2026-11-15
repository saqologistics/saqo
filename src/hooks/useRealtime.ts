import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredToken } from '../lib/api';
import { isSupabaseEdgeApi, realtimeUrl, staticPreview } from '../lib/deployment';
import { subscribeSupabaseNotifications } from '../lib/supabaseRealtime';
import type { LiveWsEvent } from '../shared/types';

type EventListener = (event: LiveWsEvent) => void;
type ConnectionListener = (connected: boolean) => void;

let sharedWs: WebSocket | null = null;
let sharedConnected = false;
let reconnectTimer: number | null = null;
let idleTimer: number | null = null;
let unsubscribeSupabase: (() => void) | null = null;
let latestPresenceEvent: LiveWsEvent | null = null;

const eventListeners = new Set<EventListener>();
const connectionListeners = new Set<ConnectionListener>();

function notifyConnection(next: boolean) {
  sharedConnected = next;
  connectionListeners.forEach((cb) => cb(next));
}

function dispatchEvent(evt: LiveWsEvent) {
  if (evt.type === 'support:presence') {
    latestPresenceEvent = evt;
  }
  eventListeners.forEach((cb) => cb(evt));
}

function sendAuthSync() {
  if (!sharedWs || sharedWs.readyState !== WebSocket.OPEN) return;
  const token = getStoredToken();
  if (token) {
    sharedWs.send(JSON.stringify({ type: 'auth', token }));
  } else {
    sharedWs.send(JSON.stringify({ type: 'logout' }));
  }
}

function ensureSharedConnection() {
  if (staticPreview || typeof window === 'undefined') return;

  if (!unsubscribeSupabase) {
    unsubscribeSupabase = subscribeSupabaseNotifications((evt) => {
      if (!sharedConnected) dispatchEvent(evt);
    });
  }

  if (isSupabaseEdgeApi) return;

  if (
    sharedWs &&
    (sharedWs.readyState === WebSocket.OPEN || sharedWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const ws = new WebSocket(realtimeUrl());
  sharedWs = ws;

  ws.onopen = () => {
    if (sharedWs !== ws) return;
    notifyConnection(true);
    sendAuthSync();
  };

  ws.onmessage = (evt) => {
    if (sharedWs !== ws) return;
    try {
      const parsed = JSON.parse(evt.data) as LiveWsEvent;
      dispatchEvent(parsed);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => {
    if (sharedWs !== ws) return;
    sharedWs = null;
    latestPresenceEvent = null;
    notifyConnection(false);
    if (eventListeners.size > 0 && reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (eventListeners.size > 0) {
          ensureSharedConnection();
        }
      }, 2000);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('saqo:auth-changed', () => {
    sendAuthSync();
  });
}

export function useRealtime(onEvent: (event: LiveWsEvent) => void): {
  connected: boolean;
  sendEvent: (payload: Record<string, unknown>) => void;
} {
  const [connected, setConnected] = useState(sharedConnected);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const listener: EventListener = (evt) => {
      handlerRef.current(evt);
    };
    const connListener: ConnectionListener = (next) => {
      setConnected(next);
    };

    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    eventListeners.add(listener);
    connectionListeners.add(connListener);
    ensureSharedConnection();
    setConnected(sharedConnected);

    if (latestPresenceEvent) {
      handlerRef.current(latestPresenceEvent);
    }

    return () => {
      eventListeners.delete(listener);
      connectionListeners.delete(connListener);
      if (eventListeners.size === 0) {
        idleTimer = window.setTimeout(() => {
          idleTimer = null;
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          unsubscribeSupabase?.();
          unsubscribeSupabase = null;
          const socket = sharedWs;
          sharedWs = null;
          latestPresenceEvent = null;
          socket?.close();
          notifyConnection(false);
        }, 1000);
      }
    };
  }, []);

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    if (sharedWs && sharedWs.readyState === WebSocket.OPEN) {
      sharedWs.send(JSON.stringify(payload));
    }
  }, []);

  return { connected, sendEvent };
}
