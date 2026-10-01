# Orbis hub + web in one image.
# build:  docker build -t orbis .
# run:    docker compose up -d   (see docker-compose.yml – host networking is needed for device discovery)

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# manifests first so the dependency layer caches
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json tsconfig.base.json turbo.json ./
COPY apps/hub/package.json apps/hub/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/sdk/package.json packages/sdk/
COPY packages/ui/package.json packages/ui/
COPY packages/module-tools/package.json packages/module-tools/
COPY modules ./modules
RUN find modules -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} + \
 && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter "./modules/*" build \
 && pnpm --filter @orbis/web build \
 && pnpm --filter @orbis/hub build \
 && pnpm --filter @orbis/hub deploy --prod /out/hub \
 && mkdir -p /out/modules \
 && for d in modules/*/; do n=$(basename "$d"); mkdir -p "/out/modules/$n"; cp -r "$d/module.json" "$d/dist" "/out/modules/$n/"; done

FROM node:22-bookworm-slim
# iputils-ping + iproute2 for the network scanner (ping sweep, arp table)
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping iproute2 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3001 ORBIS_DATA_DIR=/data ORBIS_WEB_DIR=/app/web ORBIS_BUILTIN_MODULES_DIR=/app/modules
WORKDIR /app
COPY --from=build /out/hub/node_modules ./node_modules
COPY --from=build /out/hub/dist ./dist
COPY --from=build /app/apps/hub/assets ./assets
COPY --from=build /app/apps/web/out ./web
COPY --from=build /out/modules ./modules
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
