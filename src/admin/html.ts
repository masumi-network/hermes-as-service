// Minimal HTML rendering helpers. No template engine, no client JS framework —
// just typed string builders. Output is escaped where it matters.

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(opts: { title: string; body: string; active?: string }): string {
  const nav = (path: string, label: string): string => {
    const cls = opts.active === path ? 'nav-link active' : 'nav-link';
    return `<a class="${cls}" href="${path}">${esc(label)}</a>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(opts.title)} — Hermes Admin</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="dot"></span>
      <span>Hermes Orchestrator</span>
    </div>
    <nav>
      ${nav('/admin', 'Overview')}
      ${nav('/admin/instances', 'Instances')}
      ${nav('/admin/usage', 'Usage')}
      ${nav('/admin/chats', 'Chats')}
      ${nav('/admin/confirmations', 'Confirmations')}
      ${nav('/admin/events', 'Events')}
      ${nav('/admin/images', 'Images')}
      ${nav('/admin/tests', 'Tests')}
    </nav>
  </header>
  <main>${opts.body}</main>
</body>
</html>`;
}

/** A metric tile. `tone` colors the value for meaning (e.g. errors → danger). */
export function statCard(
  label: string,
  value: string | number,
  sub?: string,
  tone?: 'ok' | 'warn' | 'danger',
): string {
  const toneCls = tone ? ` stat-${tone}` : '';
  return `<div class="card stat${toneCls}">
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

export function relTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const s = Math.round(Math.abs(diffMs) / 1000);
  const fmt = (v: number, unit: string): string => (future ? `in ${v}${unit}` : `${v}${unit} ago`);
  if (s < 60) return fmt(s, 's');
  const m = Math.round(s / 60);
  if (m < 60) return fmt(m, 'm');
  const h = Math.round(m / 60);
  if (h < 48) return fmt(h, 'h');
  return fmt(Math.round(h / 24), 'd');
}

/** Status → pill class. Healthy = ok, in-flight = warn, idle = muted, bad = err. */
export function statusPill(status: string): string {
  const tone: Record<string, string> = {
    running: 'ok',
    ready: 'ok',
    provisioning: 'warn',
    onboarding: 'warn',
    infrastructure_ready: 'warn',
    suspended: 'muted',
    error: 'err',
    destroyed: 'err',
  };
  const cls = tone[status] ?? 'muted';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

const CSS = `
:root {
  --bg: #0a0a0b;
  --surface: #141416;
  --surface-2: #1b1b1e;
  --surface-3: #222226;
  --border: #262629;
  --border-strong: #34343a;
  --text: #ededee;
  --text-2: #b4b4ba;
  --muted: #85858c;
  --faint: #5a5a61;
  --accent: #4ade80;
  --accent-soft: rgba(74,222,128,0.12);
  --warn: #fbbf24;
  --warn-soft: rgba(251,191,36,0.12);
  --err: #f87171;
  --err-soft: rgba(248,113,113,0.12);
  --info: #7cb0f7;
  --r-sm: 6px;
  --r: 8px;
  --ease: cubic-bezier(0.25, 1, 0.5, 1);
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent-soft); }

/* ---- header / nav ---- */
header {
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 28px;
  background: rgba(16,16,18,0.72);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand { font-weight: 600; display: flex; align-items: center; gap: 9px; letter-spacing: -0.01em; }
.brand .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
nav { display: flex; gap: 2px; align-self: stretch; align-items: stretch; }
.nav-link {
  display: inline-flex; align-items: center;
  color: var(--muted); text-decoration: none;
  padding: 0 12px; font-size: 13px; font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: color .15s var(--ease), border-color .15s var(--ease);
}
.nav-link:hover { color: var(--text); }
.nav-link.active { color: var(--text); border-bottom-color: var(--accent); }

main { padding: 28px 24px 64px; max-width: 1280px; margin: 0 auto; }
.page-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
.subtle-line { color: var(--muted); font-size: 12px; margin-top: -10px; }

/* ---- typography ---- */
h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 18px; }
h2 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; margin: 32px 0 12px; }
h3 { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 24px 0 10px; }
p { margin: 0 0 16px; }
.dim { color: var(--muted); }
.faint { color: var(--faint); }
.num { font-variant-numeric: tabular-nums; }

/* ---- cards ---- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 10px; margin-bottom: 24px; }
.stat { padding: 14px 16px; }
.stat-value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; margin-top: 8px; }
.stat-sub { color: var(--faint); font-size: 12px; margin-top: 5px; }
.stat-ok .stat-value { color: var(--accent); }
.stat-warn .stat-value { color: var(--warn); }
.stat-danger .stat-value { color: var(--err); }
.status-strip { display: flex; flex-wrap: wrap; gap: 8px; margin: -8px 0 24px; }
.status-link, .filter-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px; border: 1px solid var(--border);
  background: var(--surface); border-radius: var(--r-sm);
  color: var(--text-2); font-size: 12px; text-decoration: none;
}
.status-link strong, .filter-chip strong { color: var(--text); font-weight: 600; }
.status-link:hover, .filter-chip:hover { background: var(--surface-2); text-decoration: none; }
.filter-chip.active { border-color: rgba(124,176,247,0.5); color: var(--info); }
.filter-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: -4px 0 12px; }
.ops-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-bottom: 24px; }
.op-card {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border-radius: var(--r); border: 1px solid var(--border);
  background: var(--surface); color: var(--text-2); text-decoration: none;
}
.op-card strong { color: var(--text); font-size: 18px; line-height: 1; }
.op-card.warn strong { color: var(--warn); }
.op-card.danger strong { color: var(--err); }
.op-card:hover { background: var(--surface-2); text-decoration: none; }

/* ---- tables ---- */
table { width: 100%; border-collapse: collapse; }
th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
th { color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-size: 10.5px; }
tbody tr { transition: background .12s var(--ease); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.mono, .mono { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }

a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ---- pills (status) — leading dot for scannability ---- */
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 1.5; white-space: nowrap; }
.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
.pill.ok { background: var(--accent-soft); color: var(--accent); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.muted { background: rgba(138,138,144,0.15); color: var(--muted); }
.pill.err { background: var(--err-soft); color: var(--err); }

/* ---- badges (metadata tags) ---- */
.badge { display: inline-block; padding: 2px 7px; border-radius: var(--r-sm); font-size: 11px; font-weight: 500; background: var(--surface-3); color: var(--text-2); border: 1px solid var(--border); white-space: nowrap; }
.badge.ok { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.badge.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.badge.danger { background: var(--err-soft); color: var(--err); border-color: transparent; }

.row { display: flex; gap: 16px; flex-wrap: wrap; }
.flex-1 { flex: 1; min-width: 320px; }

/* ---- chat ---- */
.chat-list { display: flex; flex-direction: column; gap: 10px; }
.chat-msg { background: var(--surface); border: 1px solid var(--border); border-left: 2px solid var(--border-strong); border-radius: var(--r); padding: 12px 14px; }
.chat-msg.user { border-left-color: var(--info); }
.chat-msg.assistant { border-left-color: var(--accent); }
.chat-msg.system { border-left-color: var(--muted); }
.chat-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: var(--faint); font-size: 11px; margin-bottom: 6px; }
.chat-content { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--text-2); }
.chat-role { font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.chat-role.user { color: var(--info); }
.chat-role.assistant { color: var(--accent); }
.chat-role.system { color: var(--muted); }
.chat-role.error { color: var(--err); }

pre.log {
  background: #060607; border: 1px solid var(--border); border-radius: var(--r);
  padding: 12px 14px; font-family: var(--mono); font-size: 12px; color: #cfcfd2;
  white-space: pre-wrap; word-break: break-word; max-height: 480px; overflow: auto; margin: 0; line-height: 1.55;
}

.empty { color: var(--faint); padding: 32px 24px; text-align: center; font-size: 13px; }

/* ---- controls ---- */
.actions { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.actions.no-margin { margin-bottom: 0; }
.filter-bar input[type="search"] { min-width: 320px; }
button, .btn {
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: 6px 12px; font-size: 12px; font-weight: 500;
  cursor: pointer; font-family: inherit; transition: background .15s var(--ease), border-color .15s var(--ease);
}
button:hover, .btn:hover { background: var(--surface-3); border-color: #41414a; }
button.primary { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
button.primary:hover { background: rgba(74,222,128,0.18); }
button.danger { background: transparent; color: var(--err); border-color: rgba(248,113,113,0.35); }
button.danger:hover { background: var(--err-soft); }
form.inline { display: inline; }

input, select {
  background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  padding: 6px 10px; color: var(--text); font-size: 13px; font-family: inherit;
}
input::placeholder { color: var(--faint); }

a:focus-visible, button:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible, .nav-link:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

/* ---- key-value + events ---- */
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 7px 16px; font-size: 13px; align-items: baseline; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; color: var(--text-2); }
.event-row { display: grid; grid-template-columns: 120px 200px 1fr; gap: 14px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; align-items: baseline; }
.event-row:last-child { border-bottom: 0; }
.event-row.ev-provision_failed, .event-row.ev-chat_failed { color: var(--err); }
.event-row.ev-ready, .event-row.ev-chat_proxied { color: var(--accent); }
.event-time { color: var(--faint); font-family: var(--mono); }
.event-name { font-weight: 500; }
.event-detail { color: var(--muted); font-family: var(--mono); font-size: 11px; word-break: break-all; }

/* ---- tool chips (test runs) + diffs ---- */
.tool-chip { display: inline-block; padding: 2px 7px; border-radius: var(--r-sm); font-family: var(--mono); font-size: 11px; background: rgba(124,176,247,0.12); color: var(--info); margin: 2px 4px 2px 0; }
.tool-none { color: var(--faint); font-size: 12px; }
.unchanged { color: var(--muted); }

/* ---- usage bars (spend-by-day) ---- */
.bar-row { display: grid; grid-template-columns: 84px 1fr max-content; gap: 12px; align-items: center; padding: 4px 0; font-size: 12px; }
.bar-track { background: var(--surface-2); border-radius: 3px; height: 14px; overflow: hidden; }
.bar-fill { background: var(--accent-soft); border-right: 2px solid var(--accent); height: 100%; min-width: 2px; }
.bar-label { color: var(--muted); font-family: var(--mono); }
.bar-value { font-family: var(--mono); color: var(--text-2); white-space: nowrap; }
.cmp { width: 100%; border-collapse: collapse; }
.cmp th, .cmp td { vertical-align: top; border: 1px solid var(--border); padding: 10px 12px; font-size: 12px; width: 1%; }
.cmp th { background: var(--surface-2); text-align: left; }
.cmp td .chat-content { font-size: 12px; }
`;
