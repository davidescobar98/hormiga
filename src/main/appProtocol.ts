import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'hormiga';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/**
 * Serves the compiled renderer from `app://hormiga/…` instead of file:// (no extra file:// privileges, proper origin
 * for ES modules). Only files inside the renderer directory are reachable; everything else is 404/403.
 */
export function handleAppScheme(rendererDir: string, csp: string): void {
  const root = resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST || request.method !== 'GET') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(full);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
