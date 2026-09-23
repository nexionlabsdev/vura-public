# Stage 1: Build stage
FROM node:20-slim AS builder

WORKDIR /build

COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
COPY schemas/ ./schemas/
COPY packages/ ./packages/
COPY docker/ ./docker/

RUN bash ./docker/generate-catalog-manifest.sh
RUN npm ci
RUN npm run compile --workspaces --if-present
RUN bash ./docker/build-plugins.sh --mode=npm --out-dir=/build/dist/plugins-catalog

# Stage 2: Final runtime stage
FROM node:20-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    tini \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/vura/venv
ENV PATH="/opt/vura/venv/bin:$PATH"
ENV VURA_PYTHON_VENV_PATH="/opt/vura/venv"

WORKDIR /opt/vura/app

COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
COPY packages/ ./packages/

RUN npm ci --omit=dev

COPY packages/core/vura-io-py /tmp/vura-io-py
RUN /opt/vura/venv/bin/pip install --no-cache-dir pandas pyarrow duckdb jsonschema /tmp/vura-io-py && rm -rf /tmp/vura-io-py

COPY --from=builder /build/packages /opt/vura/app/packages
COPY --from=builder /build/schemas /opt/vura/app/schemas
COPY --from=builder /build/dist/plugins-catalog /opt/vura/plugins-catalog
COPY --from=builder /build/docker/plugins-catalog.json /opt/vura/plugins-catalog.json

RUN npm link ./packages/core/vura-runner

COPY docker/vura-runner/docker-entrypoint.sh /opt/vura/docker-entrypoint.sh
RUN chmod +x /opt/vura/docker-entrypoint.sh

ENV VURA_HOME="/data/.vura"
ENV VURA_PORT="3000"
ENV VURA_NOTEBOOKS_DIR="/notebooks"

RUN mkdir -p /notebooks /data/.vura /opt/vura/plugins-catalog \
    && groupadd -r vura && useradd -r -g vura -d /data vura \
    && chown -R vura:vura /notebooks /data /opt/vura /opt/vura/app

USER vura
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${VURA_PORT}/api/flows || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/vura/docker-entrypoint.sh"]
CMD []
