FROM node:24-bookworm-slim

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.10"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY examples/agent-web-ui/package.json examples/agent-web-ui/bun.lock ./examples/agent-web-ui/
RUN cd examples/agent-web-ui && bun install --frozen-lockfile

COPY . .
RUN npm run ui:build

ENV HOST=0.0.0.0
ENV PORT=3300
ENV NATS_URL=nats://nats-synadia-dev_nats:4222

EXPOSE 3300

CMD ["node", "scripts/start-production.js"]
