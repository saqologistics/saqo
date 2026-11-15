import React, { useEffect, useState } from 'react';
import { CloudOff, Wifi, WifiOff } from 'lucide-react';
import { apiUrl } from '../lib/deployment';

type ConnectionStatus = 'checking' | 'online' | 'offline' | 'unreachable';

const connectionMessages = {
  offline: 'You’re offline',
  unreachable: 'Can’t reach SAQO. Reconnecting…',
  restored: 'Connection restored',
};

export const OfflineIndicator: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(
    () => navigator.onLine ? 'checking' : 'offline'
  );
  const [showRestored, setShowRestored] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: number;
    let request: AbortController | undefined;
    let failures = 0;

    const checkConnection = async () => {
      window.clearTimeout(timer);
      if (request || stopped || document.hidden || !navigator.onLine) return;
      const controller = new AbortController();
      request = controller;
      const timeout = window.setTimeout(() => controller.abort(), 4500);
      try {
        const response = await fetch(apiUrl('/api/health'), { cache: 'no-store', signal: controller.signal });
        if (!response.ok || (await response.json()).service !== 'saqo-dispatch') {
          throw new Error('SAQO health check failed');
        }
        if (!stopped && request === controller && navigator.onLine) {
          failures = 0;
          setStatus('online');
        }
      } catch {
        if (!stopped && request === controller && navigator.onLine) {
          failures += 1;
          if (failures >= 2) setStatus('unreachable');
        }
      } finally {
        window.clearTimeout(timeout);
        if (request === controller) {
          request = undefined;
          if (!stopped && !document.hidden && navigator.onLine) {
            timer = window.setTimeout(checkConnection, failures ? 3500 : 25000);
          }
        }
      }
    };

    const onOffline = () => {
      window.clearTimeout(timer);
      request?.abort();
      request = undefined;
      failures = 0;
      setStatus('offline');
    };
    const onVisibility = () => {
      if (document.hidden) window.clearTimeout(timer);
      else if (navigator.onLine) void checkConnection();
      else onOffline();
    };

    window.addEventListener('online', checkConnection);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    void checkConnection();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      request?.abort();
      window.removeEventListener('online', checkConnection);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (status === 'offline' || status === 'unreachable') {
      setShowRestored(true);
    } else if (status === 'online' && showRestored) {
      const timer = window.setTimeout(() => setShowRestored(false), 3200);
      return () => window.clearTimeout(timer);
    }
  }, [status, showRestored]);

  const message = status === 'offline' || status === 'unreachable'
    ? status
    : status === 'online' && showRestored ? 'restored' : null;
  const Icon = message === 'offline' ? WifiOff : message === 'unreachable' ? CloudOff : Wifi;

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="pointer-events-none fixed bottom-20 md:bottom-4 left-4 z-[110]">
      {message && (
        <div className="inline-flex items-center gap-2 rounded-lg border border-white/25 bg-black px-3.5 py-2 text-xs font-semibold text-white shadow-lg">
          <Icon aria-hidden="true" className="w-3.5 h-3.5" />
          <span>{connectionMessages[message]}</span>
        </div>
      )}
    </div>
  );
};
