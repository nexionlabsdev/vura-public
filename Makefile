.PHONY: build deps install install-all install-runner \
        build-mac build-linux build-windows clean \
        build-core-sdk build-vura-odata-sync-core build-vura-io \
        build-vura-dataverse-sync-core build-vura-runner \
        build-vura-dataverse build-vura-sharepoint build-core-extension \
        build-vura-onedrive build-vura-googledrive build-vura-s3 build-vura-local \
        install-core-extension install-vura-dataverse install-vura-sharepoint \
        install-vura-onedrive install-vura-googledrive install-vura-s3 install-vura-local

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
#
# Packages live under packages/core/ (the platform: core-sdk, core-extension,
# vura-runner, vura-io, vura-odata-sync-core) or packages/connectors/ (every
# IVuraProvider Add-on: vura-dataverse, vura-sharepoint, vura-onedrive,
# vura-googledrive, vura-s3, vura-local).
build-core-sdk:
	cd packages/core/core-sdk && npm run compile

build-vura-odata-sync-core: build-core-sdk
	cd packages/core/vura-odata-sync-core && npm run compile

build-vura-io: build-core-sdk
	cd packages/core/vura-io && npm run compile

build-vura-dataverse-sync-core: build-core-sdk build-vura-odata-sync-core
	cd packages/connectors/vura-dataverse-sync-core && npm run compile

build-vura-runner: build-core-sdk build-vura-io
	cd packages/core/vura-runner && npm run compile

# vura-dataverse and vura-sharepoint are Add-on extensions (see CLAUDE.md) —
# separate VS Code extensions that register with core-extension via
# api.registerProvider(...) on activation. They're also npm workspace
# members, which is fine for compiling alone (tsc resolves types by walking
# up to the hoisted root node_modules) but not for packaging into a .vsix:
# `vsce package` only looks inside the extension's own directory, and the
# installed extension is extracted standalone outside the monorepo, so
# anything only present in the hoisted root node_modules would be missing at
# runtime. install-local-deps.sh (same script core-extension uses) stages a
# real, self-contained node_modules under packages/<name> for these too.
build-vura-dataverse: build-core-sdk build-vura-odata-sync-core
	bash ./scripts/install-local-deps.sh connectors/vura-dataverse
	cd packages/connectors/vura-dataverse && npm run compile

build-vura-sharepoint: build-core-sdk build-vura-odata-sync-core
	bash ./scripts/install-local-deps.sh connectors/vura-sharepoint
	cd packages/connectors/vura-sharepoint && npm run compile

# OneDrive, Google Drive, S3, and the local-folder connector are Add-on
# extensions too, but only depend on core-sdk (no OData sync engine) — same
# staged-node_modules packaging story as vura-dataverse/vura-sharepoint above.
build-vura-onedrive: build-core-sdk
	bash ./scripts/install-local-deps.sh connectors/vura-onedrive
	cd packages/connectors/vura-onedrive && npm run compile

build-vura-googledrive: build-core-sdk
	bash ./scripts/install-local-deps.sh connectors/vura-googledrive
	cd packages/connectors/vura-googledrive && npm run compile

build-vura-s3: build-core-sdk
	bash ./scripts/install-local-deps.sh connectors/vura-s3
	cd packages/connectors/vura-s3 && npm run compile

build-vura-local: build-core-sdk
	bash ./scripts/install-local-deps.sh connectors/vura-local
	cd packages/connectors/vura-local && npm run compile

# core-extension is deliberately NOT an npm workspace member (see root
# package.json) — its @vura-data-os/* deps resolve as normal npm packages,
# resolved from the registry once published. install-local-deps.sh
# overlays fresh local tarballs of the 5 packages it actually depends on
# instead, so this always reflects the current branch, not whatever's last
# published.
build-core-extension: build-core-sdk build-vura-odata-sync-core build-vura-io build-vura-dataverse-sync-core build-vura-runner
	bash ./scripts/install-local-deps.sh core/core-extension
	cd packages/core/core-extension && npm run compile

# Build every package in the repo (all npm workspace libraries/Add-ons
# plus core-extension), in dependency order.
build: deps build-core-sdk build-vura-odata-sync-core build-vura-io build-vura-dataverse-sync-core build-vura-runner build-vura-dataverse build-vura-sharepoint build-vura-onedrive build-vura-googledrive build-vura-s3 build-vura-local build-core-extension

# --- Package a .vsix and install into local VS Code -----------------------
install-core-extension: build-core-extension
	bash ./scripts/package-extension.sh core/core-extension -o dist/vura-core.vsix
	code --install-extension dist/vura-core.vsix

install-vura-dataverse: build-vura-dataverse
	bash ./scripts/package-extension.sh connectors/vura-dataverse -o dist/vura-dataverse.vsix
	code --install-extension dist/vura-dataverse.vsix

install-vura-sharepoint: build-vura-sharepoint
	bash ./scripts/package-extension.sh connectors/vura-sharepoint -o dist/vura-sharepoint.vsix
	code --install-extension dist/vura-sharepoint.vsix

install-vura-onedrive: build-vura-onedrive
	bash ./scripts/package-extension.sh connectors/vura-onedrive -o dist/vura-onedrive.vsix
	code --install-extension dist/vura-onedrive.vsix

install-vura-googledrive: build-vura-googledrive
	bash ./scripts/package-extension.sh connectors/vura-googledrive -o dist/vura-googledrive.vsix
	code --install-extension dist/vura-googledrive.vsix

install-vura-s3: build-vura-s3
	bash ./scripts/package-extension.sh connectors/vura-s3 -o dist/vura-s3.vsix
	code --install-extension dist/vura-s3.vsix

install-vura-local: build-vura-local
	bash ./scripts/package-extension.sh connectors/vura-local -o dist/vura-local.vsix
	code --install-extension dist/vura-local.vsix

# Install core-extension. Kept as the default `install` target for
# backwards compatibility — use `install-all` to also install every
# Add-on extension.
install: install-core-extension

# Install the vura-runner package into the global npm space, so that `vura-runner`
# is available on the command line. This is a prerequisite for running the
# CLI runner headlessly outside VS Code.
install-runner: build-vura-runner
	cd packages/core/vura-runner && npm link

install-all: install-core-extension install-vura-dataverse install-vura-sharepoint install-vura-onedrive install-vura-googledrive install-vura-s3 install-vura-local

# Platform-specific .vsix bundles. `vsce --target` labels the package for that
# platform, but the native `duckdb` binary that ends up inside it is whatever
# `npm install` resolved on the machine running this target — genuine
# cross-platform builds (e.g. producing a working linux-arm64 package from a
# Mac) require running the matching target on that platform's own CI runner,
# same as any other extension bundling native modules.
build-mac:
	bash ./scripts/install-local-deps.sh core/core-extension
	bash ./scripts/package-extension.sh core/core-extension --target darwin-x64 -o dist/vura-core-darwin-x64.vsix
	bash ./scripts/package-extension.sh core/core-extension --target darwin-arm64 -o dist/vura-core-darwin-arm64.vsix

build-linux:
	bash ./scripts/install-local-deps.sh core/core-extension
	bash ./scripts/package-extension.sh core/core-extension --target linux-x64 -o dist/vura-core-linux-x64.vsix
	bash ./scripts/package-extension.sh core/core-extension --target linux-arm64 -o dist/vura-core-linux-arm64.vsix

build-windows:
	bash ./scripts/install-local-deps.sh core/core-extension
	bash ./scripts/package-extension.sh core/core-extension --target win32-x64 -o dist/vura-core-win32-x64.vsix
	bash ./scripts/package-extension.sh core/core-extension --target win32-arm64 -o dist/vura-core-win32-arm64.vsix

clean:
	rm -rf dist
	rm -rf packages/*/*/out packages/*/*/dist packages/*/*/tsconfig.tsbuildinfo
	rm -rf packages/core/core-extension/node_modules
