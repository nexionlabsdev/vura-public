# VURA in the browser: codercom/code-server with core-extension and
# vura-dataverse pre-installed, so opening the container in a browser gives
# the full VURA notebook experience without a local VS Code install.
#
# Builds both .vsix's from THIS commit's own source (same
# scripts/install-local-deps.sh + scripts/package-extension.sh path used for
# local dev and the standalone core-extension/vura-dataverse releases) —
# independent of whether those packages have a tagged release out.
#
# Build (from repo root): docker build -f docker/code-server/Dockerfile -t vura-code-server .
# Run:   docker run --rm -p 8080:8080 vura-code-server

FROM node:24-bookworm AS builder
WORKDIR /repo
COPY . .
RUN npm install --no-audit --no-fund \
    && node ./scripts/copy-duckdb-vendor.js \
    && npm run compile --workspace=packages/core-sdk \
    && npm run compile --workspace=packages/vura-io \
    && npm run compile --workspace=packages/vura-odata-sync-core \
    && npm run compile --workspace=packages/vura-runner \
    && ./scripts/install-local-deps.sh core-extension \
    && ./scripts/package-extension.sh core-extension --target linux-x64 -o dist/vura-core.vsix \
    && ./scripts/install-local-deps.sh vura-dataverse \
    && ./scripts/package-extension.sh vura-dataverse -o dist/vura-dataverse.vsix

FROM codercom/code-server:latest
# code-server's default image runs as the non-root "coder" user — COPY
# defaults to root ownership, which "coder" can't clean up after install.
COPY --from=builder --chown=coder:coder /repo/dist/vura-core.vsix /repo/dist/vura-dataverse.vsix /tmp/
RUN code-server --install-extension /tmp/vura-core.vsix \
    && code-server --install-extension /tmp/vura-dataverse.vsix \
    && rm -f /tmp/*.vsix

EXPOSE 8080
