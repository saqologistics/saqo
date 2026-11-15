export const staticPreview = import.meta.env.VITE_SAQO_STATIC_PREVIEW === '1';

const apiOrigin = import.meta.env.VITE_SAQO_API_ORIGIN;

export function apiUrl(path: string): string {
  return apiOrigin ? `${apiOrigin}${path}` : path;
}

export function realtimeUrl(): string {
  const url = new URL('/ws', apiOrigin || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
