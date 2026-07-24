import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { esc, relTime } from './html.js';

// ---------- helpers ----------

export function renderToolChips(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0)
    return '<span class="tool-none">no tool calls</span>';
  return (toolCalls as Array<{ name?: string; detail?: string }>)
    .map((t) => `<span class="tool-chip" title="${esc(t.detail ?? '')}">${esc(t.name ?? '?')}</span>`)
    .join('');
}

export function renderTestTurn(t: {
  caseName: string;
  prompt: string;
  responseText: string | null;
  toolCalls: unknown;
  model: string | null;
  totalTokens: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}): string {
  return `<div class="card" style="margin-bottom:10px">
    <div class="chat-meta">
      <span class="chat-role">${esc(t.caseName)}</span>
      ${t.latencyMs != null ? `<span>${esc(String(t.latencyMs))}ms</span>` : ''}
      ${t.totalTokens ? `<span>${esc(String(t.totalTokens))} tok</span>` : ''}
      ${t.model ? `<span class="mono">${esc(t.model)}</span>` : ''}
    </div>
    <div class="chat-content" style="color:var(--info);margin-bottom:8px">${esc(t.prompt)}</div>
    ${
      t.errorMessage
        ? `<div class="chat-content" style="color:var(--err)">⚠ ${esc(t.errorMessage)}</div>`
        : `<div class="chat-content">${esc(t.responseText ?? '')}</div>`
    }
    <div style="margin-top:8px">${renderToolChips(t.toolCalls)}</div>
  </div>`;
}

export function renderChatMsg(m: {
  role: string;
  content: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  finishReason: string | null;
  createdAt: Date;
  requestId: string;
}): string {
  const role = m.errorMessage ? 'error' : m.role;
  const tokens = m.totalTokens
    ? `${m.totalTokens} tok (${m.promptTokens ?? '?'} in / ${m.completionTokens ?? '?'} out)`
    : '';
  return `<div class="chat-msg ${esc(m.role)}">
    <div class="chat-meta">
      <span class="chat-role ${esc(role)}">${esc(m.role)}${m.errorMessage ? ' · error' : ''}</span>
      <span>${esc(relTime(m.createdAt))}</span>
      ${m.model ? `<span class="mono">${esc(m.model)}</span>` : ''}
      ${tokens ? `<span>${esc(tokens)}</span>` : ''}
      ${m.latencyMs != null ? `<span>${esc(m.latencyMs)}ms</span>` : ''}
      ${m.finishReason ? `<span>finish: ${esc(m.finishReason)}</span>` : ''}
      <span class="mono" style="color:var(--muted)">req ${esc(m.requestId.slice(0, 8))}</span>
    </div>
    <div class="chat-content">${esc(m.content)}</div>
    ${m.errorMessage ? `<div class="chat-content" style="color:var(--err);margin-top:6px">⚠ ${esc(m.errorMessage)}</div>` : ''}
  </div>`;
}

export function renderEventRow(e: {
  event: string;
  userId: string;
  detail: unknown;
  createdAt: Date;
}): string {
  const detail = e.detail ? JSON.stringify(e.detail) : '';
  return `<div class="event-row ev-${esc(e.event)}">
    <span class="event-time">${esc(relTime(e.createdAt))}</span>
    <span class="event-name"><a href="/admin/instances/${encodeURIComponent(e.userId)}">${esc(e.userId.slice(0, 16))}</a> · ${esc(e.event)}</span>
    <span class="event-detail">${esc(detail)}</span>
  </div>`;
}

export function userLabel(u: { userId: string; name: string | null; email: string | null }): string {
  if (u.name) {
    return `<strong>${esc(u.name)}</strong>${u.email ? `<div class="dim mono" style="font-size:11px">${esc(u.email)}</div>` : ''}`;
  }
  if (u.email) return `<span class="mono">${esc(u.email)}</span>`;
  return `<span class="mono dim" title="${esc(u.userId)}">${esc(u.userId.slice(0, 14))}…</span>`;
}

export function compactText(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function shortProvider(provider: string): string {
  const names: Record<string, string> = {
    gmail: 'gmail',
    google_calendar: 'gcal',
    outlook: 'outlook',
    outlook_calendar: 'ocal',
  };
  return names[provider] ?? provider;
}

/**
 * Valid docker-tag token. Also blocks Prisma LIKE wildcards (% _) so a
 * crafted ?image= can't silently match everything.
 */
export const IMAGE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Match instances whose imageTag carries this tag, in every stored form:
 * full ref ("registry…/img:v21"), bare tag ("v21", from reconcile), or
 * digest-suffixed ref ("registry…/img:v21@sha256:…").
 */
export function imageTagWhere(tag: string): Prisma.HermesInstanceWhereInput {
  if (!IMAGE_TAG_RE.test(tag)) return { id: '__invalid_image_tag__' };
  return {
    OR: [
      { imageTag: { endsWith: `:${tag}` } },
      { imageTag: tag },
      { imageTag: { contains: `:${tag}@` } },
    ],
  };
}

export function dayAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

export function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

export function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function startOfDayUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Daily LLM spend buckets, newest first. Raw SQL because Prisma's groupBy
 * can't truncate timestamps. `userId` narrows to one user; omit for global.
 */
export async function usageByDay(
  days: number,
  userId?: string,
): Promise<Array<{ day: string; cost: number; tokens: number; calls: number }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = userId
    ? await prisma.$queryRaw<Array<{ day: Date; cost: number; tokens: bigint; calls: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("costUsd"), 0)::float8 AS cost,
               COALESCE(SUM("promptTokens" + "completionTokens"), 0)::bigint AS tokens,
               COUNT(*)::bigint AS calls
        FROM "LlmUsage"
        WHERE "createdAt" >= ${since} AND "userId" = ${userId}
        GROUP BY 1 ORDER BY 1 DESC`
    : await prisma.$queryRaw<Array<{ day: Date; cost: number; tokens: bigint; calls: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("costUsd"), 0)::float8 AS cost,
               COALESCE(SUM("promptTokens" + "completionTokens"), 0)::bigint AS tokens,
               COUNT(*)::bigint AS calls
        FROM "LlmUsage"
        WHERE "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1 DESC`;
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    cost: Number(r.cost),
    tokens: Number(r.tokens),
    calls: Number(r.calls),
  }));
}

export async function perUserMonthlyAtCap(
  capUsd: number,
): Promise<{ userId: string; spend: number; pct: number }[]> {
  const rows = await prisma.llmUsage.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: startOfMonthUtc() } },
    _sum: { costUsd: true },
  });
  const out = rows
    .map((r) => {
      const spend = Number(r._sum.costUsd ?? 0);
      return { userId: r.userId, spend, pct: (spend / capUsd) * 100 };
    })
    .filter((x) => x.pct >= 50)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20);
  return out;
}

