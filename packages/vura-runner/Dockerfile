# vura-runner — standalone CLI/engine for executing .flownb notebooks.
#
# Installs the real published npm package rather than building from repo
# source, so this image always matches exactly what `npm install -g
# @vura-data-os/vura-runner@<version>` gives a real user — build this AFTER
# that version is actually on the registry (see release-vura-runner.yml).
#
# Build: docker build --build-arg VURA_RUNNER_VERSION=1.2.3 -f packages/vura-runner/Dockerfile .
# Run:   docker run --rm -v "$PWD:/work" -w /work ghcr.io/nexionlabsdev/vura-runner:1.2.3 execute my_notebook.flownb

FROM node:24-slim

ARG VURA_RUNNER_VERSION

# python3/pip for `python` notebook cells (vura-runner shells out to
# python3/python/py on PATH — see src/utils/pythonVenv.ts); pandas/pyarrow/
# duckdb/vura-io pre-installed so a fresh container can run python cells
# without a first-run pip install over the network.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages pandas pyarrow duckdb vura-io

RUN npm install -g "@vura-data-os/vura-runner@${VURA_RUNNER_VERSION}"

WORKDIR /work
ENTRYPOINT ["vura-runner"]
CMD ["--help"]
