# Architecture & IPC

Welcome to the deep dive on the Vura Data OS Architecture. This document explores the mechanics of our "Bridge" – the DuckDB and Parquet shared-state engine that enables true polyglot execution within VS Code.

## The Polyglot Data-Bridge

The true power of the Vura Data OS is its Inter-Process Communication (IPC) layer. Instead of serializing data as JSON strings and piping it between processes (which is slow and memory-intensive for large datasets), we use a high-performance binary bridge based on **DuckDB** and **Parquet files**.

The core extension acts as the orchestrator. When a notebook cell runs, it spawns an isolated sidecar process (Python or Node.js). This sidecar uses our `vura_bridge` (Vura-Bridge) library to save outputs natively as Parquet files into the workspace storage. When the next cell runs—even in a different language—it queries that same Parquet file using DuckDB.

### The Polyglot Bridge Sequence

This sequence diagram illustrates a common scenario: a SQL cell pulls data and writes it to Parquet, followed immediately by a Python cell reading that same data for analysis.

```mermaid
sequenceDiagram
    participant SQLCell as Notebook (SQL Cell)
    participant CoreExt as Core Extension (DuckDB)
    participant Storage as File System (Parquet)
    participant PythonCell as Notebook (Python Cell)
    participant PythonSidecar as Python Sidecar (vura_bridge)

    %% SQL Cell Execution
    SQLCell->>CoreExt: Execute query against Database
    CoreExt->>CoreExt: Process Result Set
    CoreExt->>Storage: Serialize & Write data to `my_data.parquet`
    CoreExt-->>SQLCell: Render Output Preview

    %% Python Cell Execution
    PythonCell->>CoreExt: Execute Python script
    CoreExt->>PythonSidecar: Spawn child_process & Pass script
    PythonSidecar->>PythonSidecar: Execute `vura_bridge.load_table('my_data')`
    PythonSidecar->>Storage: Read `my_data.parquet`
    Storage-->>PythonSidecar: Binary DataFrame
    PythonSidecar->>PythonSidecar: Perform Pandas Analysis
    PythonSidecar-->>CoreExt: Return Results / Stdout
    CoreExt-->>PythonCell: Render Analysis Output
```

## Why this architecture?
1. **Zero-Serialization Overhead:** Parquet is a columnar binary format. Reading and writing is exponentially faster than JSON serialization.
2. **True Polyglot State:** Because Parquet is a universal standard, Python (Pandas/Arrow), Node.js (Arrow), and DuckDB can all read the exact same file on disk natively.
3. **Decoupled Execution:** Sidecars run isolated. If a Python script crashes, the Core Extension (and VS Code) remains stable.

## Micro-Kernel Overview

Both kernels — the VS Code Core Extension and the `vura-runner` CLI — are decoupled from external integrations via a Micro-Kernel design, sharing one `ProviderRegistry` (from `core-sdk`) rather than each owning their own.

```mermaid
graph TD
    R[ProviderRegistry\nin core-sdk] --> A[Core Extension Kernel]
    R --> A2[vura-runner Kernel]

    A -->|Manages| C[DuckDB]
    A -->|Orchestrates| D[Polyglot Notebook]

    E[Dataverse Adapter Add-on] --->|Registers|R
    F[vura-dataverse-runner-plugin Add-on] --->|Registers|R

    E -->|Uses|G[core-sdk]
    F -->|Uses| G

    D -->|Executes Sidecar| H[Python/JS Sidecar]
    H -->|Saves Parquet| I[Storage]
    C -->|Reads Parquet| I
```
