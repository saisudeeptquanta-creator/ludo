# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build ----
# The client is built here and its output copied into the runtime image, so the
# final image carries no build tooling.
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first: this layer is cached until dependencies actually change.
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# One install for the whole workspace.
#
# npm workspaces HOIST dependencies into the root node_modules, and each
# `npm ci` rewrites that directory from scratch. Installing the workspaces in
# two separate commands therefore left only the last one's packages behind —
# the server's express vanished when the client install ran, and the container
# died on startup with ERR_MODULE_NOT_FOUND.
RUN npm ci

COPY . .
RUN npm run build --workspace client

# Drop dev dependencies (vite, playwright, …) now that the client is built, so
# the runtime image carries only what the server actually imports.
RUN npm prune --omit=dev

# -------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime

# Node 22 ships node:sqlite, so there is no native module to compile and no
# build toolchain needed at runtime.
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DB_FILE=/data/ludo.db

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist

# The database lives on a mounted volume so games survive a redeploy.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 4000

# Fails the container if the API stops answering, so the platform can restart it.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
