# VURA

VURA replaces a fragmented stack of integration middleware, reporting tools, and compliance software with a single engineer-native platform. Ingest from any source, transform with code, and deliver to files, databases, APIs, or stakeholder reports — all from one notebook.

This repository is the open-source core. Each package below has its own README with install/usage details:

- **[`packages/core-extension`](packages/core-extension/README.md)** — the VS Code extension that renders `.flownb` notebooks with SQL, Python, JavaScript, and HTML cells, backed by an embedded DuckDB engine.
- **[`packages/core-sdk`](packages/core-sdk/README.md)** — the shared TypeScript SDK (`IVuraProvider`, `ProviderRegistry`, `IConnectionAdapter`, `FlownbCell`/`ICellLogger`/`IVuraEnvironment`, the Auto-Schema Flattener) used to build add-ons that run in either the VS Code extension or the CLI.
- **[`packages/vura-dataverse-sync-core`](packages/vura-dataverse-sync-core/README.md)** — the host-agnostic Dynamics 365 / OData `$batch` sync engine, shared by the two Add-ons below.
- **[`packages/vura-dataverse-adapter`](packages/vura-dataverse-adapter/README.md)** — a VS Code Add-on wrapping `vura-dataverse-sync-core`, showing how a real connector plugs into the extension.
- **[`packages/vura-dataverse-runner-plugin`](packages/vura-dataverse-runner-plugin/README.md)** — a `vura-runner` CLI plugin wrapping the same `vura-dataverse-sync-core`, showing how a connector plugs into the CLI instead.
- **[`packages/vura-runner`](packages/vura-runner/README.md)** — a standalone CLI/engine that executes `.flownb` notebooks outside of VS Code.
- **`samples/`** — example `.flownb` notebooks.

The system is built around a **micro-kernel + plugin model**: `core-extension` (VS Code) and `vura-runner` (CLI) are both kernels sharing one Add-on contract, defined in `core-sdk`. Add-ons like `vura-dataverse-adapter`/`vura-dataverse-runner-plugin` register with whichever kernel loads them via the shared `ProviderRegistry` — in VS Code, on extension activation; in the CLI, via a notebook's `requiredPlugins` field or `vura-runner config set vura.plugins`.

## Getting started

```bash
npm install          # install workspace dependencies
make build            # compile the VS Code extension
make install           # package a .vsix and install it into local VS Code
```

Platform-specific packages:

```bash
make build-mac       # darwin-x64 and darwin-arm64
make build-linux     # linux-x64 and linux-arm64
make build-windows   # win32-x64 and win32-arm64
```

See [`docs/`](docs/README.md) for architecture, the SDK guide, and the notebook format spec.

## VURA Enterprise

The remote execution stack — a control plane UI, a Kafka/gRPC orchestrator, and managed enterprise connectors — is a separate commercial product, **VURA Enterprise**. It is not part of this repository. See [`ROADMAP.md`](ROADMAP.md) for what that covers.

## License

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0) — see `LICENSE`. If you want to build a commercial or proprietary product on top of this code without AGPL's obligations, contact us at [info@nexionlabs.dev](mailto:info@nexionlabs.dev) to discuss a separate commercial license.
