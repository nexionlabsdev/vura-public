# Feasibility Evaluation: Sidecar Resource Constraints (RAM, Disk & CPU Throttling)

## 1. Executive Summary

In VURA's micro-kernel architecture, `.flownb` notebooks execute code across multiple runtime engines:
- **Core Orchestrator**: Node.js CLI / VS Code Extension
- **Analytical Data Layer**: Embedded in-process DuckDB engine with Parquet zero-copy data bridge
- **Python Sidecar**: Long-running warm Python worker processes executing pandas/pyarrow logic
- **Node/JavaScript Sidecar**: Long-running warm Node.js worker processes executing TypeScript/JavaScript transformations via `@vura-data-os/vura-io`

As concurrent workflows scale under load (e.g. 10–100 simultaneous users in `vura serve` or batch pipelines), uncontrolled sidecar resource consumption poses risks of Out-Of-Memory (OOM) kernel kills, CPU starvation of the main server process, and uncontrolled disk consumption from temporary Parquet artifacts.

This document evaluates the technical feasibility, implementation strategies, and trade-offs of applying machine-level resource constraints (RAM, Disk, and CPU throttling) across all VURA runtime components on **macOS**, **Linux**, and **Windows**.

---

## 2. Current Process & Isolation Architecture

```
                                  ┌────────────────────────┐
                                  │   vura serve / execute  │
                                  │   (Main Node.js Host)  │
                                  └───────────┬────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
                    ▼                         ▼                         ▼
         ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
         │  DuckDB (In-Process)│   │   Python Sidecar    │   │  Node.js Sidecar    │
         │  - Schema isolation │   │  - JSON-stdio IPC   │   │  - JSON-stdio IPC   │
         │  - Parquet bridge   │   │  - Isolated globals │   │  - vm.Script ctx    │
         └─────────────────────┘   └─────────────────────┘   └─────────────────────┘
```

1. **Sidecar Process Model**: Workers are spawned as long-running child processes managed by `sidecarPool.ts`. Communication occurs over `stdin`/`stdout` JSON lines.
2. **Context Isolation**:
   - Python: Each cell runs in a freshly initialized globals dictionary (`exec(code, exec_globals)`).
   - Node.js: Each cell runs in a fresh V8 context (`vm.createContext(...)`).
   - DuckDB: Each HTTP request receives a dedicated ephemeral schema (`session_<runId>`) dropped upon completion.

---

## 3. RAM / Memory Limits Feasibility

### 3.1 Node.js Sidecar Memory Constraints
| Aspect | Details |
|---|---|
| **Mechanism** | `--max-old-space-size=<MB>` V8 command-line argument. |
| **Feasibility** | **100% Feasible & Immediate (Cross-Platform).** |
| **Behavior on Exceed** | V8 triggers garbage collection. If heap remains over the limit, process throws an unhandled `JavaScript heap out of memory` error and exits cleanly. |
| **VURA Pool Recovery** | `sidecarPool.ts` handles `proc.on('exit')`, detects abnormal termination, rejects the current pending request gracefully, and spawns a fresh worker on the next execution. |
| **Implementation** | Added via `vura.node.maxOldSpaceSizeMb` config key (defaults to 512 MB). |

### 3.2 Python Sidecar Memory Constraints
| OS / Platform | Mechanism | Feasibility | Trade-offs / Notes |
|---|---|---|---|
| **Linux (POSIX)** | `resource.setrlimit(resource.RLIMIT_AS, (soft, hard))` | **High** | Limits total virtual address space. When exceeded, `malloc` returns NULL and Python raises `MemoryError`. |
| **macOS (Darwin)** | `resource.setrlimit(resource.RLIMIT_DATA, ...)` or `RLIMIT_RSS` | **Medium** | macOS kernel ignores `RLIMIT_AS` in modern versions; `RLIMIT_DATA` or polling with `tracemalloc` is recommended. |
| **Windows** | Windows Job Objects (`SetInformationJobObject` with `ProcessMemoryLimit`) | **High** | Hard OS-level ceiling. Kernel refuses memory allocations beyond threshold. |
| **Python Tracing Hook** | `tracemalloc` or custom allocator / `sys.settrace` check | **High (Universal)** | Soft threshold check inside `vura.io.put` / `vura.io.data` before large DataFrame transformations. |

### 3.3 Embedded DuckDB Memory Limits
| Aspect | Details |
|---|---|
| **Mechanism** | `PRAGMA memory_limit='<size>'` (e.g. `'1GB'`). |
| **Feasibility** | **100% Feasible & Built-in.** |
| **Behavior on Exceed** | DuckDB automatically spills temporary query state to disk buffer partitions instead of crashing the host process. |
| **Implementation** | Configured dynamically via `vura.duckdb.maxMemory` (default `1GB`). |

---

## 4. CPU Throttling & Core Allocation Feasibility

### 4.1 Process Niceness / Priority (Universal Baseline)
- **Node.js**: `os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW)` immediately after `spawn`.
- **POSIX (`nice`)**: Child processes run with reduced scheduler priority (`nice -n 10`), guaranteeing that the HTTP server host never starves during compute-heavy Pandas or Arrow transformations.
- **Feasibility**: **100% Feasible, zero-dependency, works on macOS, Linux, and Windows.**

### 4.2 Linux cgroups v2 (Hard CPU Throttling)
- **Mechanism**: Place spawned sidecars in a cgroup slice with `cpu.max="50000 100000"` (enforces a hard 50% CPU core quota) and `cpu.weight=100`.
- **Feasibility**: **High on Linux server deployments / Docker containers.**
- **Use Case**: Multi-tenant server environments where one user flow must not consume 100% of multi-core CPU capacity.

### 4.3 macOS QoS / Dispatch Throttling
- **Mechanism**: Spawning with `POSIX_SPAWN_SETEXEC` and `QOS_CLASS_UTILITY` or using `cpulimit -p <pid> -l <pct>`.
- **Feasibility**: **Medium** (requires native binding or utility wrapper).

---

## 5. Storage & Disk Quotas Feasibility

### 5.1 DuckDB Temp Spilling Limits
- **Mechanism**: `PRAGMA max_temp_directory_size='<size>'` (e.g. `'2GB'`).
- **Feasibility**: **100% Feasible.** Prevents massive queries from exhausting server disk space.

### 5.2 Storage Workspace Quotas in `vura.io`
- **Mechanism**: Inside `DataManager.writeTableData` and `DataManager.put`, check directory size against `vura.storage.quotaMb`. If exceeded, reject operation with `QuotaExceededError` before allocating new Parquet files.
- **Feasibility**: **100% Feasible in user space.**

### 5.3 OS-Level Filesystem Quotas
- Linux: `xfs_quota` / `ext4` project quotas per notebook directory.
- `tmpfs`: Mounting `.vura/storage/runs/` on an in-memory `tmpfs` capped at 512MB for lightning-fast zero-disk execution with hardware-enforced limits.

---

## 6. Comparison Matrix

| Resource Dimension | Mechanism | OS Support | Overhead | Feasibility | Recommended Action |
|---|---|---|---|---|---|
| **Node.js RAM** | `--max-old-space-size` | All (macOS, Linux, Win) | 0% | **Immediate** | **Adopted as default in vura-runner** |
| **Python RAM** | `setrlimit` + `tracemalloc` | POSIX / All | < 1% | **High** | **Adopt in sidecar.py startup** |
| **DuckDB RAM** | `PRAGMA memory_limit` | All | 0% | **Immediate** | **Adopted as default in DuckDbManager** |
| **DuckDB Temp Disk** | `PRAGMA max_temp_directory_size` | All | 0% | **Immediate** | **Adopted as default in DuckDbManager** |
| **CPU Nice Priority** | `os.setPriority()` | All | 0% | **High** | **Set sidecar pool workers to LOW priority** |
| **CPU Core Cap** | Linux cgroups v2 (`cpu.max`) | Linux | < 0.5% | **High (Server)** | **Provide systemd/cgroup launcher on Linux** |
| **Disk Quotas** | Pre-write checks in `vura.io` | All | < 1% | **High** | **Add storagePath size check hook** |

---

## 7. Concrete Next Steps

1. **Host-level Defaults**: Keep Node.js `--max-old-space-size=512` and DuckDB `PRAGMA memory_limit='1GB'` as baseline protections against memory exhaustion.
2. **Crash Auto-Recovery**: Ensure `sidecarPool.ts` handles OOM process exits by transparently spawning fresh workers without hanging the parent server.
3. **Telemetry Integration**: Utilize the `TelemetryMonitor` suite in CI/CD to alert if baseline memory consumption creeps across releases.
