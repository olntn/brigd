# syntax=docker/dockerfile:1
# Fixed upstream versions; update pins deliberately and run both CI workflows.
FROM oven/bun:1.4.2-debian AS bun
FROM node:24.21.0-bookworm-slim AS runtime-base

ARG TRACKT_UID=1000
ARG TRACKT_GID=1000
ARG CODEX_VERSION=0.162.0
ARG CLAUDE_VERSION=2.1.295

# Tini forwards shutdown signals and reaps orphaned CLI descendants. Native
# sandbox dependencies are present, but host kernel/container policy still apply.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini ripgrep bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && test "$TRACKT_UID" -gt 0 && test "$TRACKT_GID" -gt 0 \
    && groupmod --gid "$TRACKT_GID" node \
    && usermod --uid "$TRACKT_UID" --gid "$TRACKT_GID" --login trackt --home /home/trackt --move-home node \
    && mkdir -p /app /opt/trackt-cli /var/lib/trackt /workspace/projects \
       /home/trackt/.codex /home/trackt/.claude \
    && chown -R trackt:node /app /opt/trackt-cli /var/lib/trackt /workspace/projects /home/trackt \
    && chmod 700 /home/trackt /var/lib/trackt /home/trackt/.codex /home/trackt/.claude
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV HOME=/home/trackt \
    CODEX_HOME=/home/trackt/.codex \
    PATH=/opt/trackt-cli/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1

# Official, exact-version npm packages. Optional dependencies contain the
# platform binaries; Claude's official postinstall links its native executable.
# Install as an unprivileged user, then make the CLI installation root-owned.
USER trackt
RUN npm_config_cache=/tmp/trackt-npm-build npm install --global --prefix /opt/trackt-cli \
      --registry=https://registry.npmjs.org --include=optional --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && rm -rf /tmp/trackt-npm-build \
    && codex --version && claude --version
USER root
RUN chown -R root:root /opt/trackt-cli \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /app
USER trackt

FROM runtime-base AS build
COPY --chown=trackt:node package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY --chown=trackt:node index.html vite.config.ts svelte.config.js tsconfig.json tsconfig.server.json ./
COPY --chown=trackt:node src ./src
COPY --chown=trackt:node public ./public
RUN bun run build

FROM runtime-base AS runtime
ENV NODE_ENV=production \
    PORT=4310 \
    TRACKT_HOST=0.0.0.0 \
    TRACKT_ALLOWED_HOSTS=127.0.0.1:4310,localhost:4310 \
    TRACKT_ALLOWED_ORIGINS=http://127.0.0.1:4310,http://localhost:4310 \
    TRACKT_DEFAULT_CWD=/workspace/projects \
    TRACKT_DB=/var/lib/trackt/trackt.sqlite
COPY --from=build /app/dist ./dist
COPY package.json bun.lock ./
COPY server ./server
COPY src/lib ./src/lib
COPY scripts ./scripts
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4310/api/info'); if (!r.ok || (await r.json()).scheduler !== 'running') process.exit(1)"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "server/index.ts"]
