import { prisma } from '../db.js';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { costUsd } from './pricing.js';

// Small in-process cache so we don't hammer the DB on every request. Sum
// changes only after we write a LlmUsage row, so we just invalidate on write.
const mtdCache = new Map<string, { value: number; computedAt: number }>();
const CACHE_TTL_MS = 30_000;

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function userMonthlySpend(userId: string): Promise<number> {
  const key = `${userId}:${monthKey()}`;
  const cached = mtdCache.get(key);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.value;
  const agg = await prisma.llmUsage.aggregate({
    where: { userId, createdAt: { gte: startOfMonthUtc() } },
    _sum: { costUsd: true },
  });
  const value = Number(agg._sum.costUsd ?? 0);
  mtdCache.set(key, { value, computedAt: Date.now() });
  return value;
}

export function invalidateUserSpend(userId: string): void {
  mtdCache.delete(`${userId}:${monthKey()}`);
}

export interface CapCheck {
  allowed: boolean;
  monthlySpendUsd: number;
  capUsd: number;
}

export async function checkUserCap(userId: string): Promise<CapCheck> {
  const cap = loadConfig().MONTHLY_USD_CAP_PER_USER;
  const spend = await userMonthlySpend(userId);
  return { allowed: spend < cap, monthlySpendUsd: spend, capUsd: cap };
}

export async function recordLlmUsage(args: {
  instanceId: string;
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  streamed: boolean;
}): Promise<void> {
  const cost = costUsd(args.model, args.promptTokens, args.completionTokens);
  try {
    await prisma.llmUsage.create({
      data: {
        instanceId: args.instanceId,
        userId: args.userId,
        model: args.model,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costUsd: cost,
        streamed: args.streamed,
      },
    });
    invalidateUserSpend(args.userId);
  } catch (err) {
    logger.error({ err, args }, 'record_llm_usage_failed');
  }
}
