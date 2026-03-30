# CodePilotStorm

**CodePilotStorm** is a powerful VS Code extension that brings full-featured JSX/TSX and TypeScript intelligence directly into your editor — covering everything from navigation and refactoring to import management and AST exploration.

---

## Features

### 🔍 Go To Definition
Jump instantly to the definition of any symbol — components, functions, variables, types — across your entire project. Bound to `F12`.

### 📌 Find All Usages
Locate every reference to a symbol project-wide with a single keystroke (`Shift+F12`). Results are displayed in VS Code's References panel.

### 🗂️ Import Graph
Visualise your project's dependency graph. Use **Show Dependencies** to see what a file imports, and **Show Dependents** to see what imports it. Circular dependency detection is also built in.

### ⚡ Auto Import
Automatically resolve and insert missing import statements for components, hooks, utilities, and types — keeping your files clean without manual effort.

### ✏️ Rename Refactor
Safely rename any symbol across the entire codebase in one step (`F2`). All references are updated atomically.

### 📖 Hover Documentation
Hover over any symbol to see its inferred type, JSDoc comment, and source location — without leaving the editor.

### 🧭 Breadcrumbs & Document Symbols
Navigate your file structure via breadcrumbs and the Outline panel, powered by a full symbol provider for JS/TS/JSX/TSX files.

### 🌳 AST Explorer (JSX/TSX Structure View)
A dedicated **JSX/TSX Structure** tree view in the Explorer sidebar renders the live Abstract Syntax Tree of the active file. Click any node to jump straight to its source range.

### 🔭 Inline Usages Lens
CodeLens annotations appear above every symbol, showing its usage count inline. Click to expand all references without running a separate search.

### 📦 Project Indexer
On activation, CodePilotStorm indexes the entire workspace so that all features work instantly — even on cold start — with incremental updates as files change.

---

## Requirements

- **VS Code** `^1.110.0`
- Works with **JavaScript**, **TypeScript**, **JSX** (`.jsx`), and **TSX** (`.tsx`) files — no additional configuration required.

---

## Extension Settings

CodePilotStorm activates automatically for the following language IDs:

| Language ID | File Types |
|---|---|
| `javascript` | `.js` |
| `javascriptreact` | `.jsx` |
| `typescript` | `.ts` |
| `typescriptreact` | `.tsx` |

No additional settings are required to get started.

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Go To Definition | `F12` |
| Find All Usages | `Shift+F12` |
| Rename Symbol | `F2` |

All shortcuts are active when the editor is focused on a supported file type.

---

## Known Issues

- Very large monorepos (10 000+ files) may experience a short delay during the initial workspace index build.
- Dynamically computed import paths (e.g. template-literal imports) are not yet resolved in the Import Graph.

---

## Release Notes

### 0.2.0
- Added Inline Usages CodeLens, Breadcrumb Provider, and Document Symbol Provider.
- Improved AST cache performance and incremental re-indexing on file save.
- Circular dependency detection added to the Import Graph.

### 0.1.0
- Initial release: Go To Definition, Find Usages, Import Graph, Auto Import, Rename Refactor, Hover Provider, AST Tree View, and Project Indexer.

---

**Enjoy CodePilotStorm!**
