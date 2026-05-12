import { logger } from '../logger.js';

interface ModelPrice {
  promptPerToken: number;
  completionPerToken: number;
}

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}

let priceMap: Map<string, ModelPrice> = new Map();
let lastFetched = 0;
let inFlight: Promise<void> | null = null;

const REFRESH_MS = 60 * 60_000; // hourly

async function refresh(): Promise<void> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'openrouter_pricing_fetch_failed');
      return;
    }
    const data = (await res.json()) as { data?: OpenRouterModel[] };
    const next = new Map<string, ModelPrice>();
    for (const m of data.data ?? []) {
      const p = m.pricing;
      if (!p) continue;
      const inP = Number(p.prompt ?? 0);
      const outP = Number(p.completion ?? 0);
      if (!Number.isFinite(inP) || !Number.isFinite(outP)) continue;
      next.set(m.id, { promptPerToken: inP, completionPerToken: outP });
    }
    if (next.size > 0) {
      priceMap = next;
      lastFetched = Date.now();
      logger.info({ models: priceMap.size }, 'openrouter_pricing_loaded');
    }
  } catch (err) {
    logger.warn({ err }, 'openrouter_pricing_fetch_failed');
  }
}

export async function ensurePricingLoaded(): Promise<void> {
  if (priceMap.size > 0 && Date.now() - lastFetched < REFRESH_MS) return;
  if (!inFlight) inFlight = refresh().finally(() => (inFlight = null));
  await inFlight;
}

export function priceFor(modelId: string): ModelPrice | null {
  // Exact hit.
  const exact = priceMap.get(modelId);
  if (exact) return exact;
  // OpenRouter responses include a date-pinned snapshot suffix (e.g.
  // "xiaomi/mimo-v2.5-pro-20260422" or ":20260422" / ":latest") while the
  // /models endpoint only lists the canonical id. Strip and retry.
  const stripped = modelId
    .replace(/:[a-z0-9_.-]+$/i, '') // ":20260422", ":latest", ":free"
    .replace(/-(20\d{6}|latest)$/i, ''); // "-20260422", "-latest"
  if (stripped !== modelId) {
    const hit = priceMap.get(stripped);
    if (hit) return hit;
  }
  return null;
}

export function costUsd(modelId: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return promptTokens * p.promptPerToken + completionTokens * p.completionPerToken;
}

// Kick off initial load in background; consumers can `await ensurePricingLoaded()`
// for a guaranteed-fresh price.
void refresh();
