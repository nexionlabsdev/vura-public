# Roadmap

This is a living document. Dates aren't promises — it's a statement of direction.

## Shipped

- `.flownb` notebooks with SQL, Python, JavaScript, and HTML cells in VS Code
- Embedded DuckDB engine with zero-copy Parquet IPC between cells (the "polyglot bridge")
- Auto-Schema Flattener — recursive JSON → relational Parquet shredding
- `core-sdk` add-on contract (`IVuraProvider`, `IConnectionAdapter`, `ProviderRegistry`) shared by both kernels, and a reference Dataverse/OData integration (`vura-dataverse-sync-core` + `vura-dataverse-adapter` + `vura-dataverse-runner-plugin`) showing the same Add-on running in either one
- `vura-runner` — headless CLI execution of `.flownb` notebooks outside VS Code, with an HTTP trigger API and its own Add-on plugin loading (declared per-notebook via `requiredPlugins`, or globally via `vura.plugins`)

## Near-term (open source)

- Additional language sidecars beyond Python/Node
- Broader connector coverage in `core-sdk` (more `IConnectionAdapter` reference implementations)
- Notebook format improvements: richer cell metadata, conditional/branching cells, checkpoint/rollback primitives in `vura-runner`
- Expanded `.flownb` output rendering (HTML/Vega-Lite cell polish, PDF export)
- Hardening the CLI's HTTP trigger server for unattended/CI use

## VURA Enterprise (commercial)

Everything above runs entirely on your machine — no server, no account, no lock-in. VURA Enterprise is for teams that need to run notebooks as production infrastructure, not just author them locally:

- **Control Plane** — a management UI for registering notebooks, scheduling and triggering remote runs, and watching execution status and history across a team, backed by Postgres.
- **Distributed Orchestrator** — a Kafka + gRPC execution backbone that runs notebooks on Kubernetes, with mTLS-secured sidecars, job checkpoint/restore, and horizontal scaling under load — instead of a single local process.
- **Enterprise secrets & compliance** — HashiCorp Vault-backed secret management, OpenLineage lineage emission for audit and compliance reporting, and multi-tenant isolation.
- **Managed connectors** — production-hardened, supported connectors (starting with Dynamics 365) with SLAs, versioned upgrades, and vendor support instead of community best-effort.
- **Auth & governance** — team accounts, RBAC, and SSO for controlling who can run and schedule what, across environments.

VURA Enterprise is a separate, paid product built on top of this open-source core. Contact us at [info@nexionlabs.dev](mailto:info@nexionlabs.dev) if you're interested in a commercial license or want to talk about VURA Enterprise.
