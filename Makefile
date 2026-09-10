.PHONY: build install install-runner build-mac build-linux build-windows build-vura-dataverse clean

# TypeScript compile: npm install (workspace: the library packages) + each
# package's own `compile` script, in dependency order. core-extension is not
# a workspace member (see root package.json) — its @vura-data-os/* deps
# aren't published yet, so install-local-deps.sh overlays fresh local
# tarballs instead of hitting the registry.
build:
	npm install
	node ./scripts/copy-duckdb-vendor.js
	cd packages/core-sdk && npm run compile
	cd packages/vura-io && npm run compile
	cd packages/vura-runner && npm run compile
	bash ./scripts/install-local-deps.sh core-extension
	cd packages/core-extension && npm run compile

# Package a .vsix for the current platform and install it into local VS Code.
install:
	bash ./scripts/install-local-deps.sh core-extension
	bash ./scripts/package-extension.sh core-extension -o dist/vura-core.vsix
	code --install-extension dist/vura-core.vsix

# Install the vura-runner package into the global npm space, so that `vura-runner`
# is available on the command line. This is a prerequisite for running the
install-runner:
	cd packages/vura-runner && npm run compile
	cd packages/vura-runner && npm link

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

# vura-dataverse (the unified Dataverse connector, published to both npm and
# the VS Code Marketplace from the same package) has no native dependencies
# (pure JS: core-sdk, vura-odata-sync-core, @azure/msal-node), so it doesn't
# need per-platform builds.
build-vura-dataverse:
	bash ./scripts/install-local-deps.sh vura-dataverse
	bash ./scripts/package-extension.sh vura-dataverse -o dist/vura-dataverse.vsix

clean:
	rm -rf dist
	rm -rf packages/*/out packages/*/tsconfig.tsbuildinfo
	rm -rf packages/core-extension/node_modules packages/vura-dataverse/node_modules
