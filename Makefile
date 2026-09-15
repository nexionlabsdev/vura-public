.PHONY: build deps install install-all install-runner \
        build-mac build-linux build-windows clean \
        build-core-sdk build-vura-odata-sync-core build-vura-io \
        build-vura-dataverse-sync-core build-vura-runner \
        build-vura-dataverse build-vura-sharepoint build-core-extension \
        install-core-extension install-vura-dataverse install-vura-sharepoint

# Root workspace install + native vendor binary sync. Individual build-*
# targets below assume this has already been run at least once (same as
# running `npm install` yourself before touching a single package) — only
# the top-level `build`/`install*` targets run it for you.
deps:
	npm install
	node ./scripts/copy-duckdb-vendor.js

# --- Individual package builds, in dependency order ----------------------
# Each target compiles exactly one workspace package; prerequisites list
# its own @vura-data-os/* dependencies, so `make build-<pkg>` always builds
# a fresh copy of whatever <pkg> imports, and `make build` below never
# recompiles the same package twice in one run.
build-core-sdk:
	cd packages/core-sdk && npm run compile

build-vura-odata-sync-core: build-core-sdk
	cd packages/vura-odata-sync-core && npm run compile

build-vura-io: build-core-sdk
	cd packages/vura-io && npm run compile

build-vura-dataverse-sync-core: build-core-sdk build-vura-odata-sync-core
	cd packages/vura-dataverse-sync-core && npm run compile

build-vura-runner: build-core-sdk build-vura-io
	cd packages/vura-runner && npm run compile

# vura-dataverse and vura-sharepoint are Add-on extensions (see CLAUDE.md) —
# separate VS Code extensions that register with core-extension via
# api.registerProvider(...) on activation, but are also npm workspace
# members, so (unlike core-extension) no install-local-deps.sh tarball
# overlay is needed to build them.
build-vura-dataverse: build-core-sdk build-vura-odata-sync-core
	cd packages/vura-dataverse && npm run compile

build-vura-sharepoint: build-core-sdk build-vura-odata-sync-core
	cd packages/vura-sharepoint && npm run compile

# core-extension is deliberately NOT an npm workspace member (see root
# package.json) — its @vura-data-os/* deps resolve as normal npm packages,
# resolved from the registry once published. install-local-deps.sh
# overlays fresh local tarballs of the 5 packages it actually depends on
# instead, so this always reflects the current branch, not whatever's last
# published.
build-core-extension: build-core-sdk build-vura-odata-sync-core build-vura-io build-vura-dataverse-sync-core build-vura-runner
	bash ./scripts/install-local-deps.sh core-extension
	cd packages/core-extension && npm run compile

# Build every package in the repo (all 7 npm workspace libraries/Add-ons
# plus core-extension), in dependency order.
build: deps build-core-sdk build-vura-odata-sync-core build-vura-io build-vura-dataverse-sync-core build-vura-runner build-vura-dataverse build-vura-sharepoint build-core-extension

# --- Package a .vsix and install into local VS Code -----------------------
install-core-extension: build-core-extension
	bash ./scripts/package-extension.sh core-extension -o dist/vura-core.vsix
	code --install-extension dist/vura-core.vsix

install-vura-dataverse: build-vura-dataverse
	bash ./scripts/package-extension.sh vura-dataverse -o dist/vura-dataverse.vsix
	code --install-extension dist/vura-dataverse.vsix

install-vura-sharepoint: build-vura-sharepoint
	bash ./scripts/package-extension.sh vura-sharepoint -o dist/vura-sharepoint.vsix
	code --install-extension dist/vura-sharepoint.vsix

# Install core-extension. Kept as the default `install` target for
# backwards compatibility — use `install-all` to also install every
# Add-on extension (vura-dataverse, vura-sharepoint).
install: install-core-extension

# Install the vura-runner package into the global npm space, so that `vura-runner`
# is available on the command line. This is a prerequisite for running the
# CLI runner headlessly outside VS Code.
install-runner: build-vura-runner
	cd packages/vura-runner && npm link

install-all: install-core-extension install-vura-dataverse install-vura-sharepoint

# Platform-specific .vsix bundles. `vsce --target` labels the package for that
# platform, but the native `duckdb` binary that ends up inside it is whatever
# `npm install` resolved on the machine running this target — genuine
# cross-platform builds (e.g. producing a working linux-arm64 package from a
# Mac) require running the matching target on that platform's own CI runner,
# same as any other extension bundling native modules.
build-mac:
	bash ./scripts/install-local-deps.sh core-extension
	bash ./scripts/package-extension.sh core-extension --target darwin-x64 -o dist/vura-core-darwin-x64.vsix
	bash ./scripts/package-extension.sh core-extension --target darwin-arm64 -o dist/vura-core-darwin-arm64.vsix

build-linux:
	bash ./scripts/install-local-deps.sh core-extension
	bash ./scripts/package-extension.sh core-extension --target linux-x64 -o dist/vura-core-linux-x64.vsix
	bash ./scripts/package-extension.sh core-extension --target linux-arm64 -o dist/vura-core-linux-arm64.vsix

build-windows:
	bash ./scripts/install-local-deps.sh core-extension
	bash ./scripts/package-extension.sh core-extension --target win32-x64 -o dist/vura-core-win32-x64.vsix
	bash ./scripts/package-extension.sh core-extension --target win32-arm64 -o dist/vura-core-win32-arm64.vsix

clean:
	rm -rf dist
	rm -rf packages/*/out packages/*/dist packages/*/tsconfig.tsbuildinfo
	rm -rf packages/core-extension/node_modules
