FROM node:26-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		chromium \
		fonts-noto-color-emoji \
		fonts-noto-cjk \
		unzip \
		xauth \
		xvfb \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY integrations/twillot-cloud-worker/package.json ./integrations/twillot-cloud-worker/package.json
RUN npm install --omit=dev --no-audit --no-fund --prefix integrations/twillot-cloud-worker
COPY integrations/twillot-companion ./integrations/twillot-companion
COPY integrations/twillot-cloud-worker ./integrations/twillot-cloud-worker

ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV BIRDCLAW_TWILLOT_PROFILE_DIR=/data/twillot-browser

CMD ["xvfb-run", "-a", "node", "integrations/twillot-cloud-worker/cloud-worker.mjs"]
