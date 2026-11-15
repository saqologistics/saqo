export const staticPreview = import.meta.env.VITE_SAQO_STATIC_PREVIEW === '1';

const rawApiOrigin = (import.meta.env.VITE_SAQO_API_ORIGIN as string | undefined)?.trim();
const apiOrigin = rawApiOrigin ? rawApiOrigin.replace(/\/+$/, '') : '';
export const isSupabaseEdgeApi = Boolean(apiOrigin && /\/functions\/v1\//.test(apiOrigin));

export function apiUrl(path: string): string {
  return apiOrigin ? `${apiOrigin}${path}` : path;
}

export function realtimeUrl(): string {
  const url = new URL('/ws', apiOrigin || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
