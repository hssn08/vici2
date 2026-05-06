# syntax=docker/dockerfile:1.7
# api/ — Fastify + Prisma. Multi-stage with dev (tsx watch), builder, prod.
# Build context is the repo root so we can pull in pnpm-workspace.yaml.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.15.0

# ----- base ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ----- deps (workspace install) ---------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY workers/package.json ./workers/
COPY web/package.json ./web/
COPY shared/types/package.json ./shared/types/
RUN pnpm install --frozen-lockfile=false

# ----- dev (hot reload via tsx watch) ---------------------------------------
FROM deps AS dev
COPY tsconfig.base.json ./
COPY api ./api
COPY shared ./shared
WORKDIR /app/api
EXPOSE 3000 9101
CMD ["pnpm", "run", "dev"]

# ----- builder (compile TS, runs prisma generate) ---------------------------
FROM deps AS builder
COPY tsconfig.base.json ./
COPY api ./api
COPY shared ./shared
WORKDIR /app/api
RUN pnpm exec tsc -p tsconfig.json

# ----- prod ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/api/dist ./dist
COPY --from=builder /app/api/node_modules ./node_modules
COPY --from=builder /app/api/package.json ./
EXPOSE 3000 9101
USER node
CMD ["node", "dist/server.js"]
