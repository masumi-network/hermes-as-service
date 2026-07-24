# Hermes Orchestrator — runs on Railway. NOT the user-facing Hermes image.
# Each user's Hermes runs as an always-on Fly Machine built from
# Dockerfile.hermes-user (see its header for build/push), not in this container.

# ---------- build stage ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate \
 && npm run build

# Strip dev deps for the runtime image.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# OpenSSL is needed by Prisma's query engine on Debian Bookworm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# masumi-agent-messenger CLI — used by src/notify/masumi.ts to post orchestrator
# alerts into the private "Masumi Team Channel". Pinned for reproducible builds.
RUN npm install -g @masumi_network/masumi-agent-messenger@0.0.32 \
 && masumi-agent-messenger --version

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# Hermes user-image artifacts (SOUL.md, config.yaml, denylist, skills) so the
# admin Images page can display the live image's actual contents at runtime.
COPY docker ./docker

EXPOSE 8080
# `prisma db push` syncs schema → DB on every boot. Safe for v1 (single-model,
# no existing data). Swap for `migrate deploy` once migrations are committed.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
