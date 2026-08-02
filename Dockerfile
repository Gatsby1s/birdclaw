FROM node:26-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@10.34.3

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm prune --prod

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV BIRDCLAW_HOME=/data
ENV BIRDCLAW_HOST=0.0.0.0
ENV TZ=Asia/Shanghai
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY --from=build /app/dist ./dist
COPY --from=build /app/integrations ./integrations
COPY --from=build /app/CHANGELOG.md /app/LICENSE /app/README.md ./

EXPOSE 3000
CMD ["node", "bin/birdclaw.mjs", "serve"]
