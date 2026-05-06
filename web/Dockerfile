# syntax=docker/dockerfile:1.7
# web/ — Next.js 14. Built from repo-root context for pnpm workspace install.

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
COPY web ./web
COPY shared ./shared
WORKDIR /app/web
EXPOSE 4000
CMD ["pnpm", "run", "dev"]

FROM deps AS builder
COPY web ./web
COPY shared ./shared
WORKDIR /app/web
RUN pnpm run build

FROM node:${NODE_VERSION}-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/web/.next ./.next
COPY --from=builder /app/web/public ./public
COPY --from=builder /app/web/package.json ./
COPY --from=builder /app/web/node_modules ./node_modules
COPY --from=builder /app/web/next.config.mjs ./
EXPOSE 4000
USER node
CMD ["node_modules/.bin/next", "start", "-p", "4000", "-H", "0.0.0.0"]
