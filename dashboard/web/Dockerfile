# syntax=docker/dockerfile:1.7
FROM public.ecr.aws/docker/library/node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm run build:services

FROM public.ecr.aws/docker/library/node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:67ddd12b963c28e44126f9732075caae333cc5f55e902623bd6a107ead2bcc56 https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.814.0/ubuntu_64bit/session-manager-plugin.deb /tmp/session-manager-plugin.deb
RUN dpkg -i /tmp/session-manager-plugin.deb && rm /tmp/session-manager-plugin.deb
RUN groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/dist/services ./services
COPY --from=build --chown=app:app /app/dist/gateway-assets ./services/gateway-assets
USER app
EXPOSE 3000
CMD ["node", "server.js"]
