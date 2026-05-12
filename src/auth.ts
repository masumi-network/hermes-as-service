import type { MiddlewareHandler } from 'hono';
import { loadConfig } from './config.js';
import { problemJson, unauthorized } from './errors.js';

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const expected = loadConfig().ORCHESTRATOR_API_TOKEN;
  const header = c.req.header('Authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !timingSafeEqual(token, expected)) {
    return problemJson(c, unauthorized());
  }
  await next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
