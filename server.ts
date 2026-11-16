import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { db, getProfileById, initDatabase, verifySessionToken } from './src/server/db';
import {
  clearWsClientAuth,
  getSupportPresence,
  registerWsClient,
  resumeDispatch,
  sendSupportTyping,
  setWsClientAuth,
  setWsSupportVisitor,
  setWsTracking,
} from './src/server/dispatchEngine';
import { isAllowedBrowserOrigin, registerSaqoRoutes } from './src/server/appRoutes';
import type { RouteHandler, SaqoApp } from './src/server/webApp';

await initDatabase();

async function startServer() {
  const app = express();
  if (process.env.SAQO_TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const wsAlive = new WeakMap<import('ws').WebSocket, boolean>();

  const wsHeartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (wsAlive.get(client) === false) {
        client.terminate();
        continue;
      }
      wsAlive.set(client, false);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, 25000);
  wss.on('close', () => clearInterval(wsHeartbeat));

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      if (!isAllowedBrowserOrigin(req.headers.origin, req.headers.host)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws) => {
    let authVersion = 0;
    wsAlive.set(ws, true);
    ws.on('pong', () => wsAlive.set(ws, true));

    registerWsClient(ws);
    ws.send(
      JSON.stringify({
        type: 'connected',
        payload: { message: 'SAQO real-time stream connected' },
        timestamp: new Date().toISOString(),
      })
    );
    ws.send(
      JSON.stringify({
        type: 'support:presence',
        payload: getSupportPresence(),
        timestamp: new Date().toISOString(),
      })
    );

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'auth' && typeof msg.token === 'string') {
          const version = ++authVersion;
          await clearWsClientAuth(ws);
          if (version !== authVersion || ws.readyState !== 1) return;
          const payload = verifySessionToken(msg.token);
          if (payload) {
            const prof = await getProfileById(payload.userId);
            if (version !== authVersion || ws.readyState !== 1) return;
            if (prof && prof.accountStatus === 'active') {
              await setWsClientAuth(ws, prof.id, prof.role, payload.expiresAt);
              return;
            }
          }
        } else if (msg?.type === 'track' && typeof msg.trackingCode === 'string') {
          setWsTracking(ws, msg.trackingCode.trim().toUpperCase().slice(0, 32));
        } else if (msg?.type === 'logout') {
          authVersion += 1;
          await clearWsClientAuth(ws);
        } else if (msg?.type === 'support:subscribe' && typeof msg.visitorToken === 'string') {
          setWsSupportVisitor(ws, msg.visitorToken);
        } else if (msg?.type === 'support:typing' && typeof msg.conversationId === 'string') {
          await sendSupportTyping(ws, msg.conversationId, Boolean(msg.isTyping));
        }
      } catch {
        // ignore malformed frames
      }
    });
  });

  const urlencodedMiddleware = express.urlencoded({
    extended: false,
    limit: '24kb',
    parameterLimit: 150,
  }) as unknown as RouteHandler;

  registerSaqoRoutes(app as unknown as SaqoApp, { twilioUrlencodedMiddleware: urlencodedMiddleware });

  // Vite / Static Middleware
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        allowedHosts: true,
        ws: { server, path: '/vite-hmr' },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    const indexPath = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error('Production frontend is missing. Run npm run build first.');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => { res.sendFile(indexPath); });
  }

  const PORT = Number(process.env.PORT) || 3000;
  let stopDispatch = () => {};
  server.listen(PORT, '0.0.0.0', async () => {
    stopDispatch = await resumeDispatch();
    console.log(`SAQO Logistics server listening on http://localhost:${PORT}`);
  });
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') {
    const shutdown = () => {
      stopDispatch();
      clearInterval(wsHeartbeat);
      for (const socket of wss.clients) socket.terminate();
      const timeout = setTimeout(() => process.exit(1), 20_000).unref();
      server.close(async () => {
        clearTimeout(timeout);
        await db.close();
        process.exit(0);
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}

startServer().catch((err) => {
  console.error('Failed to start SAQO server:', err);
  process.exit(1);
});
