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

RUN npm ci --omit=dev --workspace server \
 && npm ci --workspace client

COPY . .
RUN npm run build --workspace client

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
