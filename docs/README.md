# VURA — Documentation Hub

> An engineer-native notebook platform uniting SQL, Python, and Node.js inside VS Code.

## Navigation Map

| Document | What it covers |
|---|---|
| [Overview](overview.md) | Micro-Kernel model, guided journey, The Kernel vs Add-ons |
| [Architecture & IPC](architecture.md) | The DuckDB/Parquet Bridge, zero-copy IPC between cells |
| [Development Playbook](DEVELOPMENT_PLAYBOOK.md) | Local bootstrap, the golden-path test notebook |
| [Notebook Provider](notebook_provider.md) | Serializer, controller, cell routing, output rendering |
| [Data Management](data_management.md) | `vura_bridge`, the Auto-Schema Flattener, reconstruction |
| [SDK Guide](sdk_guide.md) | `IVuraProvider`, `IConnectionAdapter`, `BaseAdapter`, Add-on registration for both VS Code and the CLI |
| [Dataverse Integration](dataverse_integration.md) | `$batch` sync engine, shared between the VS Code Add-on and the CLI plugin |
| [Troubleshooting Guide](troubleshooting.md) | Decision trees and common failures for the local extension |

## Quick Start Paths

### "I want to run a notebook locally"
1. Read [Development Playbook](DEVELOPMENT_PLAYBOOK.md) to build and install the extension
2. Open VS Code, create a `.flownb` file
3. Consult [Notebook Provider](notebook_provider.md) for cell syntax

### "I want to build a custom data connector"
1. Read [SDK Guide](sdk_guide.md) for the `IVuraProvider` interface
2. Check [Dataverse Integration](dataverse_integration.md) as a reference implementation

### "Something is broken"
1. Jump directly to [Troubleshooting Guide](troubleshooting.md)

---

Looking for the Control Plane, distributed Orchestrator, or managed connectors? Those are part of **VURA Enterprise**, documented separately — see [`../ROADMAP.md`](../ROADMAP.md).
