# Development Playbook

This is the local bootstrap guide for the VURA open-source core: the VS Code extension, `core-sdk`, `vura-dataverse-adapter`, and `vura-runner`. It only covers running notebooks locally — no Kubernetes, Kafka, or remote infrastructure required.

## Prerequisites

- Node.js 18+
- Python 3.10+ (for Python cells)
- VS Code 1.80+

## 1. Install and build

```bash
npm install
make build
make install    # packages a .vsix and installs it into your local VS Code
```

## 2. The Golden Path Test

Open VS Code, create a new `example.flownb` file, and add three cells to exercise the polyglot bridge end-to-end:

**Cell 1 (SQL)** — extracts data into the local DuckDB/Parquet bridge:
```sql
CREATE TABLE users AS SELECT * FROM read_csv_auto('sample_users.csv');
```

**Cell 2 (Python)** — reads that table, transforms it, and saves it back:
```python
from vura_bridge import vura_bridge

df = vura_bridge.get_table("users")
df['is_active'] = True
vura_bridge.save_table(df, "processed_users")
```

**Cell 3 (JavaScript)** — reads the Python cell's output to verify the cross-language bridge:
```javascript
const vura_bridge = require("vura_bridge");

async function run() {
    const data = await vura_bridge.loadReconstructed("processed_users");
    console.log(`Successfully verified ${data.length} active users across the IPC boundary.`);
}
run();
```

Run all three cells. If the third cell logs a row count, the DuckDB/Parquet IPC bridge is working end-to-end. See [`architecture.md`](architecture.md) for how this works under the hood.

## 3. Running notebooks headlessly

Use `packages/vura-runner` to execute a `.flownb` file outside VS Code, e.g. from a CI job or a script:

```bash
cd packages/vura-runner
npm run compile
node out/cli.js run ../../example.flownb
```

## 4. Building a custom Add-on

See [`sdk_guide.md`](sdk_guide.md) for the `IVuraProvider` / `IConnectionAdapter` contracts, and [`dataverse_integration.md`](dataverse_integration.md) as a worked example of the same Add-on logic running in both the VS Code extension and `vura-runner` (via `vura-dataverse-sync-core` + `vura-dataverse-adapter` + `vura-dataverse-runner-plugin`).

---

Need the full distributed stack (Control Plane, Orchestrator, managed D365 mock server)? That's [VURA Enterprise](../ROADMAP.md) — a separate product with its own bootstrap guide.
