ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ARG CADDY_IMAGE=caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
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

RUN turbo prune @apps/front --docker

FROM base AS installer

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=pruner /app/out/json/ ./
COPY .npmrc ./
COPY patches/ ./patches/

RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ ./

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV VITE_MOCK_API=false

RUN pnpm turbo build --filter=@apps/front...

RUN test -f @apps/front/dist/index.html \
  && ls @apps/front/dist/assets/main-*.js > /dev/null \
  && if grep -rlF 'mockServiceWorker.js' --include='*.js' --exclude='mockServiceWorker.js' @apps/front/dist; then \
       echo "ERREUR : le bundle démarre encore MSW (VITE_MOCK_API n'a pas atteint vite build)." >&2; \
       exit 1; \
     fi

FROM ${CADDY_IMAGE}

COPY --from=installer /app/@apps/front/dist /srv
COPY @apps/front/Caddyfile /etc/caddy/Caddyfile

USER 1000:1000

EXPOSE 80
