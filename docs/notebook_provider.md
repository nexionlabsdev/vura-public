# Notebook Provider & Cell Execution

This document explains the mechanics of the custom VS Code Notebook provided by this extension. It covers how notebook files (`.flownb` / `.sqlnb`) are stored, how the Extension Host renders them, and how individual cells are executed.

---

## 1. Feature Overview

### What it does
The extension registers a custom notebook type (`vura-notebook`) with VS Code. It provides its own serializer to read/write the notebook files and its own controller to manage execution for four distinct language types: `sql`, `python`, `javascript` (Node.js), and `vura-terminal`.

### User Impact
Users interact with a native VS Code notebook interface. They can switch languages per cell, view native outputs (like data grids or JSON), and utilize cell-specific metadata (like assigning a specific variable name to the output of a SQL cell).

---

## 2. Deep Dive: The Code

### The Notebook Serializer (`notebookSerializer.ts`)

**Entry Point:** `src/notebookSerializer.ts`

VS Code requires a `NotebookSerializer` to convert raw byte data from disk into `vscode.NotebookData` (and vice-versa).

#### Logic Flow:
1. **Deserialization:** When a `.flownb` file is opened, VS Code reads the file bytes and passes them to `deserializeNotebook`, which uses `vura-runner`'s shared `parseFlownbDocument` to decode the YAML — the same parser the CLI uses, so both hosts agree on the format (including the legacy bare-array form and the versioned `{ version, cells, requiredPlugins }` form).
2. **Serialization:** When the user saves, `serializeNotebook` converts the in-memory cell data (Language, Kind, Value, Metadata) into `FlownbCell[]` and passes it to the same `serializeFlownbDocument`. A notebook's `requiredPlugins` (declared Add-on plugins for the CLI) round-trips via `NotebookData.metadata`.

> **Pro-Tip:** Notebook cell *outputs* (the actual data results) are intentionally excluded from serialization. This keeps the notebook files lightweight and suitable for source control.

#### Code Snippet: Serializing Cells
```typescript
const cells: FlownbCell[] = data.cells.map(cell => ({
    kind: cell.kind === vscode.NotebookCellKind.Code ? 2 : 1,
    language: cell.languageId,
    value: cell.value,
    metadata: cell.metadata
}));

const requiredPlugins = data.metadata?.requiredPlugins as string[] | undefined;
return new TextEncoder().encode(serializeFlownbDocument(cells, requiredPlugins));
```

---

### The Notebook Controller (`notebookController.ts`)

**Entry Point:** `src/notebookController.ts`

The Controller is responsible for actually running the code within the cells.

#### Logic Flow:
1. **Trigger:** The user clicks "Run Cell" or "Run All".
2. **Execution Task:** VS Code creates a `NotebookCellExecution` task for each executed cell.
3. **Routing & Execution:**
   - **Terminal Commands (`vura-terminal` / `shellscript`)**: Handled via `_executeTerminal()`. For each `!` line, checks `!clean_session`/`!ingest-file` built-ins or the shared `ProviderRegistry` (from `core-sdk`) for a registered Add-on handling that command (e.g., `!dataverse.sync`) and dispatches to its `handleCommand()`; anything unrecognized falls back to a raw shell command.
   - **Code Cells (`sql`, `python`, `javascript`, `html`, etc.)**: Delegated to `VuraRunner.executeCell()` / `runner.executeNotebook()` from `@vura-data-os/vura-runner`.
4. **Environment & Logging:** The controller wraps VS Code APIs using `VsCodeEnvironment` and `VsCodeCellLogger`. `VuraRunner` executes cell logic via shared language handlers and writes logs/outputs back to VS Code's execution task through `VsCodeCellLogger`.

#### Technical Breakdown:

| Class / Method | Parameters | Return Type | Purpose |
|----------------|------------|-------------|---------|
| `_execute` | `cells: vscode.NotebookCell[]`, `_notebook`, `_controller` | `Promise<void>` | Entry point for notebook execution; initializes `VsCodeEnvironment`, proxy loggers, and runs notebook via `VuraRunner.executeNotebook()`. |
| `_doExecution` | `cell: vscode.NotebookCell` | `Promise<void>` | Single cell execution dispatcher; routes terminal cells to `_executeTerminal()` and code cells to `VuraRunner.executeCell()`. |
| `_executeTerminal` | `cell: vscode.NotebookCell`, `execution: vscode.NotebookCellExecution` | `Promise<void>` | Parses and executes `!` terminal commands, dispatching to `ProviderRegistry` add-ons, file ingestion handlers, or shell fallback. |

---

## 3. Visual Context

### Cell Execution Lifecycle

This diagram illustrates the lifecycle of a single cell execution, highlighting the routing based on language type.

```mermaid
stateDiagram-v2
    [*] --> CellRunClicked

    CellRunClicked --> NotebookController

    state NotebookController {
        [*] --> CheckLanguage

        CheckLanguage --> VuraRunner : Code Cells ('sql', 'python', 'javascript', 'html', etc.)
        CheckLanguage --> Terminal : Terminal ('vura-terminal', 'shellscript')

        state VuraRunner {
            [*] --> InitVsCodeEnv
            InitVsCodeEnv --> ExecuteCell
            ExecuteCell --> LanguageHandlers
            LanguageHandlers --> DuckDbOrSidecar
        }

        Terminal --> ParseTerminalCommands
        ParseTerminalCommands --> CheckProviderRegistry
        CheckProviderRegistry --> DispatchToAddOn : command registered
        CheckProviderRegistry --> ShellFallback : not registered
    }

    NotebookController --> VsCodeCellLogger
    VsCodeCellLogger --> RenderOutput
    RenderOutput --> VSCodeUI
    VSCodeUI --> [*]
```