# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV LEFTHOOK=0
ENV COREPACK_ENABLE_PROJECT_SPEC=0
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

# ---- dependencies (cached separately from source so edits to src/ don't bust it) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod --ignore-scripts

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

COPY master ./master
COPY .env* ./
COPY pipeline.policy*.json ./

RUN mkdir -p ./tmp/workspaces && chown -R node:node ./tmp

USER node

EXPOSE 8000

CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
