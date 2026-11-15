import type { UserRole } from '../shared/types';

export interface SaqoRequest {
  method: string;
  url: string;
  originalUrl: string;
  path: string;
  protocol: string;
  ip: string;
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  rawBody?: string;
  auth?: { userId: string; role: UserRole };
  get(name: string): string | undefined;
  is(type: string): string | false | null;
}

export interface SaqoResponse {
  headersSent: boolean;
  status(code: number): this;
  set(field: string, value: string): this;
  setHeader(name: string, value: string): void;
  vary(field: string): this;
  type(contentType: string): this;
  json(body: unknown): this;
  send(body?: unknown): this;
  sendStatus(code: number): this;
}

export type NextFn = (err?: unknown) => void;
export type RouteHandler = (req: SaqoRequest, res: SaqoResponse, next: NextFn) => unknown;
export type ErrorHandler = (err: unknown, req: SaqoRequest, res: SaqoResponse, next: NextFn) => unknown;

export interface SaqoApp {
  set?(setting: string, val: unknown): unknown;
  disable?(setting: string): unknown;
  use(...handlers: unknown[]): unknown;
  get(path: string, ...handlers: unknown[]): unknown;
  post(path: string, ...handlers: unknown[]): unknown;
  put(path: string, ...handlers: unknown[]): unknown;
  patch(path: string, ...handlers: unknown[]): unknown;
  delete(path: string, ...handlers: unknown[]): unknown;
}

interface Layer {
  method: string | null; // null = middleware (.use)
  prefix: string | null;
  pattern: RegExp | null;
  paramNames: string[];
  handler: RouteHandler | ErrorHandler;
  isError: boolean;
}

function compileRoutePattern(pathPattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = pathPattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${escaped}/?$`), paramNames };
}

function parseFormEncoded(raw: string, maxParams = 150): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const params = new URLSearchParams(raw);
  let count = 0;
  for (const [key, value] of params.entries()) {
    count += 1;
    if (count > maxParams) {
      throw Object.assign(new Error('Too many form parameters.'), { status: 413 });
    }
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

/** Lightweight Express-compatible router over standard Web Request/Response APIs for Edge Runtime. */
export class WebApp implements SaqoApp {
  private readonly layers: Layer[] = [];

  set(_setting: string, _val: unknown): this {
    return this;
  }

  disable(_setting: string): this {
    return this;
  }

  use(...args: unknown[]): this {
    let prefix: string | null = null;
    let handlers = args;
    if (typeof args[0] === 'string') {
      prefix = args[0] === '/' ? '' : args[0].replace(/\/+$/, '');
      handlers = args.slice(1);
    }
    for (const h of handlers) {
      if (typeof h !== 'function') continue;
      this.layers.push({
        method: null,
        prefix,
        pattern: null,
        paramNames: [],
        handler: h as RouteHandler | ErrorHandler,
        isError: h.length === 4,
      });
    }
    return this;
  }

  private addMethod(method: string, path: string, handlers: unknown[]): this {
    const { regex, paramNames } = compileRoutePattern(path);
    for (const h of handlers) {
      if (typeof h !== 'function') continue;
      this.layers.push({
        method,
        prefix: null,
        pattern: regex,
        paramNames,
        handler: h as RouteHandler,
        isError: false,
      });
    }
    return this;
  }

  get(path: string, ...handlers: unknown[]): this { return this.addMethod('GET', path, handlers); }
  post(path: string, ...handlers: unknown[]): this { return this.addMethod('POST', path, handlers); }
  put(path: string, ...handlers: unknown[]): this { return this.addMethod('PUT', path, handlers); }
  patch(path: string, ...handlers: unknown[]): this { return this.addMethod('PATCH', path, handlers); }
  delete(path: string, ...handlers: unknown[]): this { return this.addMethod('DELETE', path, handlers); }

  async handle(request: Request, stripPrefix = ''): Promise<Response> {
    const parsedUrl = new URL(request.url);
    let pathname = parsedUrl.pathname || '/';
    if (stripPrefix && pathname.startsWith(stripPrefix)) {
      pathname = pathname.slice(stripPrefix.length) || '/';
    }
    if (!pathname.startsWith('/')) pathname = `/${pathname}`;
    const originalUrl = `${pathname}${parsedUrl.search}`;

    const headersRecord: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersRecord[key.toLowerCase()] = value;
    });

    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((value, key) => {
      if (!(key in query)) query[key] = value;
    });

    const forwardedFor = headersRecord['x-forwarded-for']?.split(',')[0]?.trim();
    const clientIp = headersRecord['cf-connecting-ip'] || forwardedFor || headersRecord['x-real-ip'] || 'unknown';

    let rawBody = '';
    let parsedBody: any = {};
    let bodyError: unknown = null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      try {
        const buf = await request.arrayBuffer();
        const contentType = (headersRecord['content-type'] || '').toLowerCase();
        const limitBytes = contentType.includes('application/x-www-form-urlencoded') ? 24 * 1024 : 256 * 1024;
        if (buf.byteLength > limitBytes) {
          bodyError = Object.assign(new Error('Request body is too large.'), { status: 413 });
        } else {
          rawBody = new TextDecoder().decode(buf);
          if (contentType.includes('application/json')) {
            parsedBody = rawBody ? JSON.parse(rawBody) : {};
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            parsedBody = parseFormEncoded(rawBody, 150);
          } else {
            parsedBody = rawBody;
          }
        }
      } catch (err) {
        bodyError = Object.assign(err instanceof Error ? err : new Error('Invalid request body.'), {
          status: (err as { status?: number } | null)?.status || 400,
        });
      }
    }

    const req: SaqoRequest = {
      method: request.method.toUpperCase(),
      url: originalUrl,
      originalUrl,
      path: pathname,
      protocol: parsedUrl.protocol.replace(/:$/, '') || 'https',
      ip: clientIp,
      socket: { remoteAddress: clientIp },
      headers: headersRecord,
      params: {},
      query,
      body: parsedBody,
      rawBody,
      get(name: string) {
        return headersRecord[name.toLowerCase()];
      },
      is(type: string) {
        const ct = headersRecord['content-type'] || '';
        return ct.toLowerCase().includes(type.toLowerCase()) ? type : false;
      },
    };

    let statusCode = 200;
    const responseHeaders = new Headers();
    let responseBody: BodyInit | null = null;
    let sent = false;
    let onSendNotify: (() => void) | null = null;
    const markSent = () => {
      sent = true;
      onSendNotify?.();
      onSendNotify = null;
    };

    const res: SaqoResponse = {
      get headersSent() { return sent; },
      status(code: number) { statusCode = code; return this; },
      set(field: string, value: string) {
        if (field.toLowerCase() === 'vary') return this.vary(value);
        responseHeaders.set(field, value);
        return this;
      },
      setHeader(name: string, value: string) {
        if (name.toLowerCase() === 'vary') this.vary(value);
        else responseHeaders.set(name, value);
      },
      vary(field: string) {
        const existing = responseHeaders.get('Vary');
        if (!existing) {
          responseHeaders.set('Vary', field);
        } else {
          const items = existing.split(',').map((s) => s.trim().toLowerCase());
          if (!items.includes(field.toLowerCase())) responseHeaders.set('Vary', `${existing}, ${field}`);
        }
        return this;
      },
      type(contentType: string) {
        const resolved = contentType.includes('/')
          ? contentType
          : contentType === 'text/xml' || contentType === 'xml'
            ? 'text/xml; charset=utf-8'
            : 'text/plain; charset=utf-8';
        responseHeaders.set('Content-Type', resolved);
        return this;
      },
      json(body: unknown) {
        if (!responseHeaders.has('Content-Type')) {
          responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
        }
        responseBody = JSON.stringify(body);
        markSent();
        return this;
      },
      send(body?: unknown) {
        if (body === undefined || body === null) {
          responseBody = null;
        } else if (typeof body === 'string') {
          if (!responseHeaders.has('Content-Type')) {
            responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
          }
          responseBody = body;
        } else {
          return this.json(body);
        }
        markSent();
        return this;
      },
      sendStatus(code: number) {
        statusCode = code;
        responseBody = code === 204 ? null : String(code);
        markSent();
        return this;
      },
    };

    const runLayer = (invoke: (next: NextFn) => unknown): Promise<{ nextCalled: boolean; err?: unknown }> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (nextCalled: boolean, err?: unknown) => {
          if (settled) return;
          settled = true;
          onSendNotify = null;
          resolve({ nextCalled, err });
        };
        onSendNotify = () => finish(false);
        try {
          const maybePromise = invoke((err?: unknown) => finish(true, err));
          if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
            (maybePromise as Promise<unknown>).then(
              () => { if (!settled && sent) finish(false); },
              (err) => finish(true, err)
            );
          } else if (sent) {
            finish(false);
          }
        } catch (err) {
          finish(true, err);
        }
      });

    let currentError: unknown = bodyError;
    for (const layer of this.layers) {
      if (sent) break;
      if (currentError) {
        if (!layer.isError) continue;
        const outcome = await runLayer((next) => (layer.handler as ErrorHandler)(currentError, req, res, next));
        currentError = outcome.nextCalled ? outcome.err : undefined;
        continue;
      }

      if (layer.isError) continue;
      if (layer.method !== null) {
        if (layer.method !== req.method) continue;
        const match = layer.pattern!.exec(pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        layer.paramNames.forEach((name, idx) => {
          params[name] = decodeURIComponent(match[idx + 1] || '');
        });
        req.params = params;
      } else if (layer.prefix !== null && layer.prefix !== '') {
        if (pathname !== layer.prefix && !pathname.startsWith(`${layer.prefix}/`)) continue;
      }

      const outcome = await runLayer((next) => (layer.handler as RouteHandler)(req, res, next));
      if (outcome.err !== undefined) currentError = outcome.err;
      else if (!sent && !outcome.nextCalled) break;
    }

    if (!sent) {
      if (currentError) {
        console.error('Unhandled API error:', currentError);
        responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
        return new Response(JSON.stringify({ error: 'Unexpected server error.' }), { status: 500, headers: responseHeaders });
      }
      responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: responseHeaders });
    }

    return new Response(statusCode === 204 ? null : responseBody, { status: statusCode, headers: responseHeaders });
  }
}
