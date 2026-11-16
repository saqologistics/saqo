import { Buffer } from 'node:buffer';
import process from 'node:process';
globalThis.Buffer ??= Buffer;
globalThis.process ??= process;

declare const Deno: {
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

let appPromise: Promise<import('../../../src/server/webApp').WebApp> | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const [{ WebApp }, { initDatabase }, { registerSaqoRoutes }] = await Promise.all([
        import('../../../src/server/webApp'),
        import('../../../src/server/db'),
        import('../../../src/server/appRoutes'),
      ]);
      await initDatabase();
      const app = new WebApp();
      registerSaqoRoutes(app);
      return app;
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

Deno.serve(async (request: Request) => {
  try {
    const pathname = new URL(request.url).pathname;
    const stripPrefix = pathname.startsWith('/functions/v1/saqo-api') ? '/functions/v1/saqo-api' : '/saqo-api';
    const app = await getApp();
    return await app.handle(request, stripPrefix);
  } catch (err) {
    console.error('Edge function initialization or request failed:', err instanceof Error ? err.name : 'Unknown error');
    return Response.json(
      { error: 'SAQO API could not process the request.' },
      { status: 500 }
    );
  }
});
