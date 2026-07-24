import type { MiddlewareHandler } from 'hono';
import { timingSafeEqualString as timingSafeEqual } from './crypto.js';
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

