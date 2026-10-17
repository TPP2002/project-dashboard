# Uses Docker's bundled Dockerfile frontend; no additional frontend image pull.
# Deployers may pin the official Node 24 Debian slim image to @sha256:...
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY core/ /app/core/
COPY web/ /app/web/
# Same build payload as core/scheduledJobs.cjs. The standalone Linux image
# does not contain the developer's shared scheduler. The controller must
# schedule/authorize the outer Docker build; workers must not build locally.
RUN node node_modules/vite/bin/vite.js build

FROM ${NODE_IMAGE} AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production \
    DASHBOARD_HOME=/data \
    DASHBOARD_NO_OPEN=1
WORKDIR /app
COPY package.json ./package.json
COPY core/ ./core/
COPY server/ ./server/
COPY cli/ ./cli/
COPY docs/self-hosting.md ./docs/self-hosting.md
COPY --from=web-build /app/web/dist/ ./web/dist/
# Do not produce a deployable image from the pre-collaboration worktree.
# This CLI is supplied by the backend integration, not by the packaging task.
RUN test -f cli/collaboration.cjs && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 6060
CMD ["node", "server/server.cjs"]
