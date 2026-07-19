import type { MiddlewareHandler } from 'hono';
import { loadConfig } from '../config.js';

const ADMIN_USER = 'admin';
const REALM = 'Hermes Orchestrator Admin';

export const adminAuth: MiddlewareHandler = async (c, next) => {
  // CSRF guard for state-changing admin actions: browsers replay cached Basic
  // Auth on cross-site form POSTs, so an attacker page could auto-submit
  // destroy/hard-reset forms. Modern browsers send Sec-Fetch-Site on every
  // request — reject non-same-origin writes. curl/scripts don't send the
  // header (absent → allowed), so API workflows keep working.
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const site = c.req.header('Sec-Fetch-Site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return new Response('cross-site admin write rejected', { status: 403 });
    }
  }
  const expected = loadConfig().ADMIN_PASSWORD;
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Basic ')) {
    return challenge();
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return challenge();
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return challenge();
  const user = decoded.slice(0, idx);
  const pw = decoded.slice(idx + 1);
  if (user !== ADMIN_USER || !timingSafeEqual(pw, expected)) {
    return challenge();
  }
  await next();

  function challenge(): Response {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` },
    });
  }
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
