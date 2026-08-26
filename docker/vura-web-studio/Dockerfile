# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /build

COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
COPY schemas/ ./schemas/
COPY Makefile ./
COPY packages/ ./packages/
COPY docker/ ./docker/

RUN bash ./docker/generate-catalog-manifest.sh
RUN npm ci
RUN npm run compile --workspaces --if-present

RUN bash ./scripts/install-local-deps.sh core-extension && \
    bash ./scripts/package-extension.sh core-extension -o /build/dist/vura-core.vsix

RUN bash ./docker/build-plugins.sh --mode=vsix --out-dir=/build/dist/plugins-catalog

# Stage 2: Final
FROM codercom/code-server:latest AS final

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    python3-pip \
    tini \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3.11 -m venv /opt/vura/venv
ENV PATH="/opt/vura/venv/bin:$PATH"
ENV VURA_PYTHON_VENV_PATH="/opt/vura/venv"

COPY packages/vura-io-py /tmp/vura-io-py
RUN /opt/vura/venv/bin/pip install --no-cache-dir pandas pyarrow duckdb jsonschema /tmp/vura-io-py && rm -rf /tmp/vura-io-py

COPY --from=builder /build/dist/vura-core.vsix /tmp/vura-core.vsix
COPY --from=builder /build/dist/plugins-catalog /opt/vura/plugins-catalog
COPY --from=builder /build/docker/plugins-catalog.json /opt/vura/plugins-catalog.json

COPY docker/vura-web-studio/docker-entrypoint.sh /opt/vura/docker-entrypoint.sh
RUN chmod +x /opt/vura/docker-entrypoint.sh

RUN mkdir -p /home/coder/project /home/coder/.local/share/code-server /data/.vura \
    && chown -R coder:coder /opt/vura /home/coder /data

USER coder

RUN code-server --install-extension /tmp/vura-core.vsix && rm -f /tmp/vura-core.vsix

ENV VURA_HOME="/data/.vura"
ENV VURA_WORKSPACE_DIR="/home/coder/project"

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/vura/docker-entrypoint.sh"]
CMD []
