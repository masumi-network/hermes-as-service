import type { Context } from 'hono';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public userId?: string,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function problemJson(c: Context, err: HttpError) {
  c.header('Content-Type', 'application/problem+json');
  return c.json(
    {
      type: `https://hermes-as-service/errors/${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      ...(err.userId ? { userId: err.userId } : {}),
      ...(err.detail ?? {}),
    },
    err.status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503,
  );
}

export const notFound = (userId: string) =>
  new HttpError(404, 'instance_not_found', 'No Hermes instance exists for this user', userId);

export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'Missing or invalid bearer token');

export const conflict = (userId: string, message: string) =>
  new HttpError(409, 'conflict', message, userId);

export const upstream = (userId: string | undefined, message: string, detail?: Record<string, unknown>) =>
  new HttpError(502, 'upstream_error', message, userId, detail);
