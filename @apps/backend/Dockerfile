ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ARG PNPM_VERSION=11.6.0
ARG TURBO_VERSION=2.9.18

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
ENV CI=true

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

FROM base AS pruner
ARG TURBO_VERSION

RUN pnpm add --global turbo@${TURBO_VERSION}

COPY . .

RUN turbo prune @apps/backend --docker

FROM base AS installer

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=pruner /app/out/json/ ./
COPY .npmrc ./
COPY patches/ ./patches/

RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ ./

RUN pnpm turbo build --filter=@apps/backend^...

RUN rm -rf node_modules @apps/*/node_modules @libs/*/node_modules \
  && pnpm install --prod --frozen-lockfile --offline

FROM ${NODE_IMAGE} AS runtime

ENV HOST=0.0.0.0
ENV PORT=8000

WORKDIR /app

COPY --from=installer /app ./

RUN install -d -o node -g node /app/@apps/backend/node_modules/.vite-temp \
  && install -d /app/@apps/backend/dist/uploads

USER node

WORKDIR /app/@apps/backend

EXPOSE 8000

CMD ["./node_modules/.bin/vite-node", "src/app.bootstrap.ts"]
