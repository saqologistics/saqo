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

function ensureChannel() {
  if (!supabase || activeChannel) return;
  try {
    activeChannel = supabase
      .channel('saqo-notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          const row = payload.new as any;
          const evt: LiveWsEvent = {
            type: 'notification:created',
            payload: {
              id: row.id,
              userId: row.user_id,
              title: row.title,
              message: row.message,
              deliveryId: row.delivery_id,
              isRead: Boolean(row.is_read),
              createdAt: row.created_at,
            },
            timestamp: new Date().toISOString(),
          };
          listeners.forEach((cb) => cb(evt));
        }
      )
      .on('broadcast', { event: 'saqo-event' }, (payload) => {
        if (payload?.payload) {
          const evt = payload.payload as LiveWsEvent;
          listeners.forEach((cb) => cb(evt));
        }
      })
      .subscribe();
  } catch {
    activeChannel = null;
  }
}

export function subscribeSupabaseNotifications(
  onEvent: (event: LiveWsEvent) => void
): () => void {
  if (!supabase) {
    return () => {};
  }

  listeners.add(onEvent);
  ensureChannel();

  return () => {
    listeners.delete(onEvent);
    if (listeners.size === 0 && activeChannel) {
      const ch = activeChannel;
      activeChannel = null;
      supabase.removeChannel(ch);
    }
  };
}
