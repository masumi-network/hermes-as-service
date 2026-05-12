#!/usr/bin/env bash
# bootstrap-hermes-sprite.sh
# Runs INSIDE a sprite to install the FULL Hermes Agent (web + browser +
# shell + code-exec). The orchestrator uploads this via Sprites' fs API and
# invokes it via the Sprites exec API.
#
# Idempotent: keyed off /opt/data/.hermes-bootstrap-done. ~5–8 min on a cold
# sprite (apt + npm + uv all the way through Playwright Chromium download).
#
# Inputs (env): HERMES_GIT_REF (default: main), HERMES_REPO (default upstream).

set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  # No -E: we want HOME=/root so user-mode installers (uv) land in
  # /root/.local/bin where the symlink below expects them.
  exec sudo "$0" "$@"
fi

export PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

MARKER=/opt/data/.hermes-bootstrap-done
INSTALL_DIR=/opt/hermes
HERMES_HOME=/opt/data
HERMES_REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_GIT_REF="${HERMES_GIT_REF:-main}"

mkdir -p "$HERMES_HOME"

if [ -f "$MARKER" ]; then
  echo "[bootstrap] already installed; skipping"
  exit 0
fi

echo "[bootstrap] system packages (apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git tini procps \
  python3 python3-venv python3-dev \
  build-essential libffi-dev \
  ffmpeg ripgrep \
  nodejs npm

echo "[bootstrap] installing uv"
curl -LsSf https://astral.sh/uv/install.sh | sh
ln -sf /root/.local/bin/uv /usr/local/bin/uv
ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

echo "[bootstrap] cloning hermes-agent @ ${HERMES_GIT_REF}"
rm -rf "$INSTALL_DIR"
git clone --depth 1 --branch "$HERMES_GIT_REF" "$HERMES_REPO" "$INSTALL_DIR"

cd "$INSTALL_DIR"
touch README.md

echo "[bootstrap] npm install (Hermes web dashboard + TUI workspace)"
# Forces symlink installs even on older bundled npm; matches the upstream
# Dockerfile so the package-lock stays consistent.
export npm_config_install_links=false
npm install --prefer-offline --no-audit
(cd web && npm install --prefer-offline --no-audit) || true
(cd ui-tui && npm install --prefer-offline --no-audit) || true

echo "[bootstrap] installing Playwright Chromium"
npx playwright install --with-deps chromium --only-shell

echo "[bootstrap] uv sync (full extras for web/browser/shell)"
uv sync --frozen --no-install-project --extra all

echo "[bootstrap] editable install of hermes-agent"
uv pip install --no-cache-dir --no-deps -e "."

# CLI entrypoint
ln -sf "$INSTALL_DIR/.venv/bin/hermes" /usr/local/bin/hermes

# Wrapper that sources /opt/data/.env (HERMES_HOME, API_SERVER_*, OPENROUTER_*)
# before exec'ing hermes. Sprites' services API doesn't accept env vars.
cat > /usr/local/bin/hermes-gateway <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME=/opt/data
if [ -f /opt/data/.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/data/.env
  set +a
fi
cd /opt/data
exec /usr/local/bin/hermes gateway "$@"
WRAPPER
chmod 0755 /usr/local/bin/hermes-gateway

# config.yaml and SOUL.md are written by the orchestrator AFTER bootstrap,
# from src/provision/profile.ts. Keeping them out of this script lets us
# update them on live instances via /admin/instances/:userId/sync-config
# without re-running the (~5 min) install.

mkdir -p "$HERMES_HOME"/{sessions,logs,memories,skills,workspace,home}

# Curated skill packs (marketing, avoid-ai-writing, skill-factory). The
# orchestrator uploads install-skills.sh alongside this bootstrap script.
if [ -f /tmp/install-skills.sh ]; then
  bash /tmp/install-skills.sh || echo "[bootstrap] WARN: install-skills failed; continuing"
fi

touch "$MARKER"
echo "[bootstrap] done"
