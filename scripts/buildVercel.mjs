import WebSocket from 'ws';

function httpsOrigin(value, name, allowPath = false) {
  let url;
  try { url = new URL(value); } catch { /* Report the setting name below. */ }
  const cleanPath = url ? url.pathname.replace(/\/+$/, '') : '';
  const validPath = allowPath || cleanPath === '';
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !validPath) {
    throw new Error(`${name} must be a public HTTPS origin.`);
  }
  return `${url.origin}${cleanPath}`;
}

async function assertApiReady(api, site) {
  const get = async (path) => {
    const response = await fetch(`${api}${path}`, {
      headers: { Origin: site }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (api !== site && response.headers.get('access-control-allow-origin') !== site)) {
      throw new Error(`The SAQO backend did not allow ${site} to access ${path}.`);
    }
    return response.json();
  };
  const health = await get('/api/health');
  const settings = await get('/api/settings/public');
  if (health.service !== 'saqo-dispatch' || health.ok !== true || typeof settings.maxActiveParcelsPerRider !== 'number') {
    throw new Error('The configured origin is not a ready SAQO API.');
  }
  if (site !== api) {
    const preflight = await fetch(`${api}/api/auth/me`, {
      method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {
        Origin: site, 'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const headers = preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(/,\s*/);
    if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== site ||
        !headers?.includes('authorization') || !headers.includes('content-type')) {
      throw new Error('The SAQO API must allow authenticated requests from the production site.');
    }
  }
}

function assertRealtimeReady(api, site) {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', api);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, { origin: site, handshakeTimeout: 5000 });
    const finish = (error) => {
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const unavailable = new Error('The SAQO WebSocket did not accept the production site.');
    const timer = setTimeout(() => finish(unavailable), 6500);
    socket.on('error', () => finish(unavailable));
    socket.once('message', (raw) => {
      try { finish(JSON.parse(String(raw)).type === 'connected' ? null : unavailable); }
      catch { finish(unavailable); }
    });
  });
}

if (process.env.VERCEL_ENV === 'production') {
  const api = httpsOrigin(process.env.VITE_SAQO_API_ORIGIN?.trim(), 'VITE_SAQO_API_ORIGIN', true);
  const site = httpsOrigin(
    process.env.SAQO_FRONTEND_ORIGIN?.trim() || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || ''}`,
    'SAQO_FRONTEND_ORIGIN',
  );
  await assertApiReady(api, site);
  if (api.includes('/functions/v1/')) {
    httpsOrigin(process.env.VITE_SUPABASE_URL?.trim(), 'VITE_SUPABASE_URL');
    if (!process.env.VITE_SUPABASE_ANON_KEY?.trim()) {
      throw new Error('VITE_SUPABASE_ANON_KEY is required for Supabase Realtime.');
    }
  } else {
    await assertRealtimeReady(api, site);
  }
  process.env.VITE_SAQO_API_ORIGIN = api;
  process.env.VITE_SAQO_STATIC_PREVIEW = '0';
} else if (['preview', 'development'].includes(process.env.VERCEL_ENV)) {
  process.env.VITE_SAQO_API_ORIGIN = '';
  process.env.VITE_SAQO_STATIC_PREVIEW = '1';
} else {
  throw new Error('Enable Vercel system environment variables so VERCEL_ENV identifies the deployment target.');
}

const { build } = await import('vite');
await build();
