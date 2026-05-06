# syntax=docker/dockerfile:1.7
# workers/ — Node 20 + TypeScript. Built from repo-root context.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.15.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY workers/package.json ./workers/
COPY web/package.json ./web/
COPY shared/types/package.json ./shared/types/
RUN pnpm install --frozen-lockfile=false

FROM deps AS dev
COPY tsconfig.base.json ./
COPY workers ./workers
COPY shared ./shared
WORKDIR /app/workers
EXPOSE 9103
CMD ["pnpm", "run", "dev"]

FROM deps AS builder
COPY tsconfig.base.json ./
COPY workers ./workers
COPY shared ./shared
WORKDIR /app/workers
RUN pnpm exec tsc -p tsconfig.json

FROM node:${NODE_VERSION}-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/workers/dist ./dist
COPY --from=builder /app/workers/node_modules ./node_modules
COPY --from=builder /app/workers/package.json ./
EXPOSE 9103
USER node
CMD ["node", "dist/index.js"]
