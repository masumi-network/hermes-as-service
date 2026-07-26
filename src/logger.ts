import pino from 'pino';
import { loadConfig } from './config.js';

const cfg = loadConfig();

export const logger = pino({
  level: cfg.LOG_LEVEL,
  base: { service: 'hermes-orchestrator' },
  // Emit the level as a STRING ("warn"), not pino's default numeric code (40).
  // Railway's log viewer parses our JSON and renders every line it can't map to
  // a known level as [INFO] — which meant every warn and error in production
  // was displayed as info, and nothing ever looked wrong.
  formatters: { level: (label) => ({ level: label }) },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});
