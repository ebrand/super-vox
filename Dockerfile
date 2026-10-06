# super-vox: the world server, serving the built client too (one service: pages, /api and /ws).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# (UV_THREADPOOL_SIZE: Node's background threads, for compressing messages and the disk cache.)
# (MALLOC_MMAP_THRESHOLD_: blocks of 128 kB and more (terrain's columns and buffers) come straight
# from the system and go straight back when freed, rather than staying with the process after a
# world closes: measured in this image, 0.47 GB after a busy world closed instead of 0.95, about 3%
# slower to make terrain. The adaptive default lets the threshold climb, and then they don't.)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORLD_DATA_DIR=/data \
    UV_THREADPOOL_SIZE=16 \
    MALLOC_MMAP_THRESHOLD_=131072
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/package.json packages/client/
COPY --from=build /app/packages/client/dist packages/client/dist
# Worlds (settings and saved edits) live in /data: mount a volume there (Railway: a service
# volume; Railway rejects the VOLUME instruction).
EXPOSE 8787
# (--expose-gc: the server collects garbage when it closes an idle world, so what the world held is
# given back then, not kept, and charged for, until the idle server next collects by itself.)
CMD ["node", "--expose-gc", "packages/server/dist/main.js"]
