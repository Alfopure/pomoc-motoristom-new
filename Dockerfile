FROM node:22-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27 AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG DEPLOYMENT_VERSION
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID

ENV DEPLOYMENT_VERSION="$DEPLOYMENT_VERSION"
ENV NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL"
ENV NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL"
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY"
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY="$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY"
ENV NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID="$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID"

RUN pnpm build:production

FROM node:22-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27 AS runner

ENV NODE_ENV="production"
ENV HOSTNAME="0.0.0.0"
ENV PORT="3000"
WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /app/.next/cache /app/tmp \
  && chown -R nextjs:nodejs /app

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/dist/worker.mjs ./worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/one-shot.mjs ./one-shot.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/viptel-listener.mjs ./viptel-listener.mjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/runtime-entrypoint.mjs ./runtime-entrypoint.mjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/runtime-env-parser.mjs ./runtime-env-parser.mjs

USER root
EXPOSE 3000

CMD ["node", "runtime-entrypoint.mjs", "web"]
