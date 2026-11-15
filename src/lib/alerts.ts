const MUTE_KEY = 'saqo_sound_muted';

let sharedAudioCtx: AudioContext | null = null;
let audioUnlocked = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    try {
      sharedAudioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  return sharedAudioCtx;
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    audioUnlocked = true;
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

export function isSoundMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

function playTone(
  ctx: AudioContext,
  startOffsetSec: number,
  freq: number,
  durationSec: number,
  gainPeak: number
) {
  const start = ctx.currentTime + startOffsetSec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, start + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationSec + 0.02);
}

/** Play a clean synthesized notification tone ('offer' for urgent rider dispatch, 'status' for parcel updates). */
export function playNotificationSound(kind: 'offer' | 'status' = 'status'): void {
  if (isSoundMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    if (!audioUnlocked) return;
    void ctx.resume().catch(() => {});
  }
  try {
    if (kind === 'offer') {
      // Crisp incoming-request ring pattern (C5 -> E5 -> G5, repeated cleanly)
      playTone(ctx, 0, 587.33, 0.14, 0.2);
      playTone(ctx, 0.16, 783.99, 0.16, 0.24);
      playTone(ctx, 0.42, 587.33, 0.14, 0.2);
      playTone(ctx, 0.58, 880.0, 0.22, 0.25);
    } else {
      playTone(ctx, 0, 659.25, 0.12, 0.14);
      playTone(ctx, 0.13, 880.0, 0.16, 0.16);
    }
  } catch {
    // ignore audio synthesis failures
  }
}

export function vibrateDevice(pattern: number | number[] = [220, 120, 220]): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      // ignore vibration errors
    }
  }
}

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestPushNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showPushNotification(title: string, body: string, tag?: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body,
      tag,
      icon: '/pwa-192x192.png',
    });
  } catch {
    // Fallback gracefully on browsers requiring SW registration for Notification constructor
  }
}
