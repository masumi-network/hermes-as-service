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
      ${nav('/admin/events', 'Events')}
    </nav>
  </header>
  <main>${opts.body}</main>
</body>
</html>`;
}

export function statCard(label: string, value: string | number, sub?: string): string {
  return `<div class="card stat">
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

export function relTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function statusPill(status: string): string {
  const cls =
    status === 'running'
      ? 'pill ok'
      : status === 'provisioning'
        ? 'pill warn'
        : status === 'suspended'
          ? 'pill muted'
          : 'pill err';
  return `<span class="${cls}">${esc(status)}</span>`;
}

const CSS = `
:root {
  --bg: #0a0a0a;
  --surface: #141414;
  --surface-2: #1c1c1c;
  --border: #262626;
  --border-strong: #333;
  --text: #e7e7e7;
  --muted: #8a8a8a;
  --accent: #4ade80;
  --warn: #fbbf24;
  --err: #f87171;
  --info: #60a5fa;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
header {
  border-bottom: 1px solid var(--border);
  padding: 16px 32px;
  display: flex;
  align-items: center;
  gap: 32px;
  background: rgba(20,20,20,0.6);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: -0.01em;
}
.brand .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 12px rgba(74,222,128,0.6);
}
nav { display: flex; gap: 4px; }
.nav-link {
  color: var(--muted);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  transition: background .15s, color .15s;
}
.nav-link:hover { color: var(--text); background: var(--surface); }
.nav-link.active { color: var(--text); background: var(--surface); }
main { padding: 32px; max-width: 1280px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 24px; }
h2 { font-size: 15px; font-weight: 600; margin: 32px 0 12px; color: var(--text); }
h3 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 24px 0 8px; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
.stat-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 6px; }
.stat-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
th { color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
tbody tr { transition: background .1s; }
tbody tr:hover { background: var(--surface-2); }
td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
.pill.ok { background: rgba(74,222,128,0.12); color: var(--accent); }
.pill.warn { background: rgba(251,191,36,0.12); color: var(--warn); }
.pill.muted { background: rgba(138,138,138,0.18); color: var(--muted); }
.pill.err { background: rgba(248,113,113,0.12); color: var(--err); }
.row { display: flex; gap: 24px; flex-wrap: wrap; }
.flex-1 { flex: 1; min-width: 320px; }
.chat-list { display: flex; flex-direction: column; gap: 12px; }
.chat-msg {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.chat-msg.user { border-left: 2px solid var(--info); }
.chat-msg.assistant { border-left: 2px solid var(--accent); }
.chat-msg.system { border-left: 2px solid var(--muted); }
.chat-meta { display: flex; gap: 12px; color: var(--muted); font-size: 11px; margin-bottom: 6px; }
.chat-content { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.chat-role { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.chat-role.user { color: var(--info); }
.chat-role.assistant { color: var(--accent); }
.chat-role.system { color: var(--muted); }
.chat-role.error { color: var(--err); }
pre.log {
  background: #050505;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 480px;
  overflow: auto;
  margin: 0;
}
.empty { color: var(--muted); padding: 24px; text-align: center; font-style: italic; }
.actions { display: flex; gap: 8px; margin-bottom: 16px; }
button, .btn {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
button:hover, .btn:hover { background: var(--surface-2); }
button.danger { color: var(--err); border-color: rgba(248,113,113,0.4); }
form.inline { display: inline; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.event-row { display: grid; grid-template-columns: 140px 180px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.event-row.ev-provision_failed, .event-row.ev-chat_failed { color: var(--err); }
.event-row.ev-ready, .event-row.ev-chat_proxied { color: var(--accent); }
.event-time { color: var(--muted); }
.event-name { font-weight: 500; }
.event-detail { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
`;
