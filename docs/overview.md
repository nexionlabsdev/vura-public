# Master Hub & Architecture Overview

Welcome to the Vura Data OS! Think of this as your **Data Operating System**. The architecture is based on a **Micro-Kernel** design, decoupling the core logic from specialized Add-ons. This approach allows external extensions to interact directly with the core engine and add custom functionalities cleanly.

## The Big Picture: A Data Operating System

The Vura Data OS is an orchestrator that enables a zero-copy shared memory layer across multiple languages. By relying on DuckDB and Parquet files, it transforms VS Code into a local, unified runtime for SQL, Python, and Node.js. Developers don't need to spin up separate infrastructures to pull CRM data, perform pandas data science, and push it back—it happens right here in the notebook.

## Guided Journey

Here's your map to exploring and building on the Vura Data OS. Each pillar below represents a core domain of the platform:

1. **[Architecture & IPC](architecture.md)**
   Understand the mechanics of our "Bridge". Learn how the embedded DuckDB instance and Parquet file format create a high-speed, zero-serialization Inter-Process Communication (IPC) layer between different notebook cells.

2. **[Data Management & Auto-Flattener](data_management.md)**
   Dive deep into the `vura_bridge` (Vura-Bridge) library. Discover how our recursive Auto-Schema Flattener shreds complex nested JSON into relational sub-tables linked by `Vura_Parent_ID`, making it immediately ready for SQL or Pandas manipulation.

3. **[SDK Guide (@vura-data-os/core-sdk)](sdk_guide.md)**
   Ready to extend the platform? Start here to understand the interfaces (`IVuraProvider`, `IConnectionAdapter`) that allow external Add-ons (like custom database connectors) to plug into either the VS Code extension or the CLI.

4. **[Dataverse Integration](dataverse_integration.md)**
   Explore our flagship Add-on. See how we've mapped SQL magic commands to native Dynamics 365 OData `$batch` requests — and how the same sync engine runs from both VS Code and the standalone CLI.

5. **[Notebook Provider & Execution](notebook_provider.md)**
   The mechanics of our custom `.flownb` and `.sqlnb` files. Discover how the controller routes executions to Node.js or Python sidecars while keeping the saved notebook files lightweight (no saved outputs).

---

## The Kernel vs The Add-ons

**Two Kernels, One Contract**
There are two kernels — the VS Code `core-extension` and the standalone `vura-runner` CLI — and they share one Add-on contract, defined entirely in `@vura-data-os/core-sdk`: `IVuraProvider`, `ProviderRegistry`, and the host-agnostic `FlownbCell`/`ICellLogger`/`IVuraEnvironment` types. Neither kernel owns the registry; both depend on `core-sdk` for it.

**External Add-ons (The Micro-Kernel Model)**
Specialized functionalities (such as syncing with Dataverse) are packaged as Add-ons depending only on `@vura-data-os/core-sdk` — never the full weight of either kernel. The same class implementing `IVuraProvider` can register with either host:
- In VS Code, an Add-on is a separate extension (e.g. `vura-dataverse-adapter`) that fetches the core extension's exports on activation and calls `registerProvider`.
- In the CLI, an Add-on is an npm plugin package (e.g. `vura-dataverse-runner-plugin`) that `vura-runner` loads by name — declared by the notebook itself (`requiredPlugins`) or globally (`vura.plugins` config) — and registers the same way.

Either kernel then dispatches a recognized magic command straight to the registered Add-on's `handleCommand()`; anything unrecognized falls back to a raw shell command.

---

## Beyond Local: VURA Enterprise

Everything above runs entirely on your machine. For teams that need to run notebooks as scheduled, production infrastructure — a control plane UI, a distributed Kafka/gRPC orchestrator, managed connectors, and compliance features — see [`ROADMAP.md`](../ROADMAP.md) for what VURA Enterprise (a separate commercial product) covers.

## See Also

- [Documentation Hub (README)](README.md) — full navigation map
- [SDK Guide](sdk_guide.md) — how to build an Add-on
