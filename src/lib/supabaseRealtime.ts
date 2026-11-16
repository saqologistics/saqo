import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { LiveWsEvent } from '../shared/types';

const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseRealtimeConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = isSupabaseRealtimeConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null;

let activeChannel: RealtimeChannel | null = null;
const listeners = new Set<(event: LiveWsEvent) => void>();
const statusListeners = new Set<(connected: boolean) => void>();
let supabaseConnected = false;

const PUBLIC_REALTIME_EVENTS = new Set([
  'notifications:refresh',
  'delivery:created',
  'delivery:updated',
  'settings:updated',
  'support:refresh',
]);

function setSupabaseConnected(next: boolean) {
  if (supabaseConnected === next) return;
  supabaseConnected = next;
  statusListeners.forEach((cb) => cb(next));
}

function ensureChannel() {
  if (!supabase || activeChannel) return;
  try {
    const channel = supabase
      .channel('saqo-notifications')
      .on('broadcast', { event: 'saqo-event' }, (payload) => {
        if (activeChannel !== channel) return;
        if (payload?.payload) {
          const evt = payload.payload as LiveWsEvent;
          if (PUBLIC_REALTIME_EVENTS.has(evt.type)) {
            // Public broadcasts can request a refresh, but cannot supply tracking data.
            const event = evt.type === 'delivery:created' || evt.type === 'delivery:updated'
              ? { ...evt, payload: null }
              : evt;
            listeners.forEach((cb) => cb(event));
          }
        }
      });
    activeChannel = channel;
    channel.subscribe((status) => {
        if (activeChannel !== channel) return;
        setSupabaseConnected(status === 'SUBSCRIBED');
      });
  } catch {
    activeChannel = null;
    setSupabaseConnected(false);
  }
}

export function subscribeSupabaseNotifications(
  onEvent: (event: LiveWsEvent) => void,
  onStatusChange?: (connected: boolean) => void
): () => void {
  if (!supabase) {
    return () => {};
  }

  listeners.add(onEvent);
  if (onStatusChange) {
    statusListeners.add(onStatusChange);
    onStatusChange(supabaseConnected);
  }
  ensureChannel();

  return () => {
    listeners.delete(onEvent);
    if (onStatusChange) statusListeners.delete(onStatusChange);
    if (listeners.size === 0 && activeChannel) {
      const ch = activeChannel;
      activeChannel = null;
      setSupabaseConnected(false);
      supabase.removeChannel(ch);
    }
  };
}
