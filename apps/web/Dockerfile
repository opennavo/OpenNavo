# Web image (Nitro Node server, port 3000). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t opennavo-web .
# Inject URLs at runtime through NUXT_* environment variables (05 §9); the image contains no environment-specific configuration.
FROM node:24.19.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@opennavo/web..."
RUN pnpm --filter @opennavo/web build

FROM node:24.19.0-alpine
# Production only runs Node; package managers and their dependency trees are unnecessary.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /repo/apps/web/.output ./.output
COPY --chown=node:node docs/legal/third-party/ /usr/share/licenses/opennavo/
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
