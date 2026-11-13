import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredToken } from '../lib/api';
import { subscribeSupabaseNotifications } from '../lib/supabaseRealtime';
import type { LiveWsEvent } from '../shared/types';

export function useRealtime(onEvent: (event: LiveWsEvent) => void): {
  connected: boolean;
  sendEvent: (payload: Record<string, unknown>) => void;
} {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  const wsRef = useRef<WebSocket | null>(null);
  handlerRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closedByEffect = false;

    const unsubscribeSupabase = subscribeSupabaseNotifications((evt) => {
      handlerRef.current(evt);
    });

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        const token = getStoredToken();
        if (token && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'auth', token }));
        }
      };

      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as LiveWsEvent;
          handlerRef.current(parsed);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (!closedByEffect) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      unsubscribeSupabase();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  return { connected, sendEvent };
}
