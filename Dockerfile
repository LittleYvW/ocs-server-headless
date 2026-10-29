# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV HUSKY=0
RUN npm install --global pnpm@10.21.0 --ignore-scripts --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/common/ packages/common/
COPY packages/server/ packages/server/
COPY packages/web-ui/ packages/web-ui/
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm build:web \
    && pnpm --filter @ocs-server/server deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    OCS_HOST=0.0.0.0 \
    OCS_PORT=15319 \
    OCS_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /out/ ./
# Install only the Chromium revision required by the locked runtime dependency.
RUN node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
    && apt-get update \
    && apt-get install --yes --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data \
    && chown node:node /data \
    && chmod 700 /data
COPY --chmod=755 deploy/container-entrypoint.sh /usr/local/bin/ocs-entrypoint
USER node
EXPOSE 15319
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.OCS_PORT+'/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/ocs-entrypoint"]
CMD ["node", "dist/index.js"]
