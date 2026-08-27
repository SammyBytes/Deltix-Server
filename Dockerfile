# syntax=docker/dockerfile:1

# ---- Stage 1: install dependencies (production only) ----
# NOTE: this image intentionally does NOT use `bun build --compile`. Bun's
# compiled-binary asset embedding only works for statically-analyzable
# imports; the Admin Web UI reads its HTML/JS via `Bun.file(join(import.meta.dir,
# 'assets', ...))` at runtime, which the compiler does not detect, so the
# compiled binary fails at boot inside the sandboxed /$bunfs virtual FS
# (confirmed while building this image). Running `bun run src/index.ts`
# directly — the exact same entrypoint every test in this repo uses — avoids
# the issue entirely and is Bun's supported way to run a server in a
# container (Bun itself is the runtime, no extra Node needed).
FROM oven/bun:1.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/addon-sdk/package.json packages/addon-sdk/package.json
RUN bun install --frozen-lockfile --production

# ---- Stage 2: runtime image ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
  && curl -Lo /tmp/dolt-install.sh https://github.com/dolthub/dolt/releases/latest/download/install.sh \
  && bash /tmp/dolt-install.sh \
  && rm -rf /tmp/dolt-install.sh /var/lib/apt/lists/* \
  && apt-get purge -y unzip \
  && apt-get autoremove -y
# NOTE: curl is kept (not purged) — the HEALTHCHECK below needs it.

RUN useradd --system --create-home --uid 10001 deltix

COPY --from=deps --chown=deltix:deltix /app/node_modules /app/node_modules
COPY --chown=deltix:deltix package.json bun.lock ./
COPY --chown=deltix:deltix packages ./packages
COPY --chown=deltix:deltix src ./src
COPY --chown=deltix:deltix proto ./proto

USER deltix

# Data volumes: Dolt repo (anti-tamper log), libSQL files (sessions,
# tickets, transfer jobs, addon trust store), NAS-sim/staging directories.
# All paths are configurable via env (see .env.example) — this is just the
# conventional mount point for a single-node piloto deployment.
VOLUME ["/var/lib/deltix"]

EXPOSE 9090 50051

# No dedicated /health endpoint yet (tracked as pilot follow-up). Any HTTP
# response (even a routed 404) proves the Hono app is up and listening, so
# the check accepts 2xx/3xx/4xx and only fails on connection errors / 5xx.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT:-9090}/" | grep -qE '^[234]' || exit 1

ENTRYPOINT ["bun", "run", "src/index.ts"]
