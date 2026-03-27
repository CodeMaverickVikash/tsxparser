/**
 * importGraph.ts — Project-Wide Import Dependency Graph
 *
 * ─── Data model ───────────────────────────────────────────────────────────────
 *
 *  Forward edges  (file → files it imports)      _deps : Map<abs, Set<abs>>
 *  Reverse edges  (file → files that import it)  _dependents : Map<abs, Set<abs>>
 *
 * ─── Features ────────────────────────────────────────────────────────────────
 *
 *  • buildGraph()              — scan every indexed file and wire edges
 *  • updateFile(filePath)      — incremental patch on save / change
 *  • removeFile(filePath)      — drop file + all its edges
 *  • getDependencies(file)     — direct imports of file
 *  • getDependents(file)       — files that import file
 *  • getTransitiveDeps(file)   — full transitive closure (DFS)
 *  • detectCircular()          — find ALL strongly-connected cycles (Tarjan SCC)
 *  • getCircularFor(file)      — cycles that involve a specific file
 *
 * ─── Navigation helpers ───────────────────────────────────────────────────────
 *
 *  • registerImportGraphCommands(context)
 *      frontendAI.showDependencies   — Quick Pick of direct deps, click to open
 *      frontendAI.showDependents     — Quick Pick of files that import current file
 *      frontendAI.showCircularDeps   — list all cycles in workspace
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { getIndexer }          from './projectIndexer';
import { resolveImportPath }   from './symbolResolver';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GraphNode {
  filePath:     string;
  /** Absolute paths of files this file imports */
  imports:      string[];
  /** Absolute paths of files that import this file */
  importedBy:   string[];
}

export interface CircularDependency {
  /** Ordered cycle: last element imports the first */
  cycle: string[];
}

export interface ImportGraphStats {
  fileCount:  number;
  edgeCount:  number;
  cycleCount: number;
  builtAt:    string;
}

// ─── ImportGraph ─────────────────────────────────────────────────────────────

export class ImportGraph implements vscode.Disposable {

  /** Forward edges: file → Set<dependency> */
  private readonly _deps       = new Map<string, Set<string>>();
  /** Reverse edges: file → Set<dependents> */
  private readonly _dependents = new Map<string, Set<string>>();

  /** Cached result of the last detectCircular() run; null = dirty (needs recompute). */
  private _cycleCache: CircularDependency[] | null = null;

  private _disposables: vscode.Disposable[] = [];

  // ── Build / update ─────────────────────────────────────────────────────────

  /** Full scan — wires all edges from the current project index. */
  buildGraph(): ImportGraphStats {
    this._deps.clear();
    this._dependents.clear();
    this._cycleCache = null;

    const indexer = getIndexer();
    for (const [absPath, parsed] of indexer.index.files) {
      this._wireFile(absPath, parsed.imports.map(i => i.module));
    }
    return this._makeStats();
  }

  /** Incremental patch — re-wire one file without a full rebuild. */
  updateFile(filePath: string): void {
    const abs     = path.resolve(filePath);
    const indexer = getIndexer();
    const parsed  = indexer.getFile(abs);

    // Remove old outgoing edges from abs
    this._unwireFile(abs);
    this._cycleCache = null;

    if (parsed) {
      this._wireFile(abs, parsed.imports.map(i => i.module));
    }
  }

  /** Remove a file and all its edges from the graph. */
  removeFile(filePath: string): void {
    const abs = path.resolve(filePath);
    this._unwireFile(abs);
    this._deps.delete(abs);
    this._cycleCache = null;

    // Also drop reverse edges pointing to abs
    for (const [, depSet] of this._dependents) {
      depSet.delete(abs);
    }
    this._dependents.delete(abs);
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /** Direct dependencies (files this file imports). */
  getDependencies(filePath: string): string[] {
    const abs = path.resolve(filePath);
    return Array.from(this._deps.get(abs) ?? []);
  }

  /** Direct dependents (files that import this file). */
  getDependents(filePath: string): string[] {
    const abs = path.resolve(filePath);
    return Array.from(this._dependents.get(abs) ?? []);
  }

  /** Full transitive closure of dependencies (DFS, returns sorted list). */
  getTransitiveDeps(filePath: string, visited = new Set<string>()): string[] {
    const abs = path.resolve(filePath);
    if (visited.has(abs)) return [];
    visited.add(abs);

    const direct = this._deps.get(abs) ?? new Set();
    for (const dep of direct) {
      this.getTransitiveDeps(dep, visited);
    }
    visited.delete(abs);   // don't include self
    return Array.from(visited).sort();
  }

  /** Detect ALL circular dependencies using Tarjan's SCC algorithm. Result is cached until the graph changes. */
  detectCircular(): CircularDependency[] {
    if (this._cycleCache !== null) return this._cycleCache;

    const nodes = Array.from(this._deps.keys());
    const index   = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack:  string[] = [];
    const sccs:   CircularDependency[] = [];
    let   counter = 0;

    const strongConnect = (v: string) => {
      index.set(v, counter);
      lowlink.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);

      for (const w of this._deps.get(v) ?? []) {
        if (!index.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
        }
      }

      if (lowlink.get(v) === index.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);

        if (scc.length > 1) {
          sccs.push({ cycle: scc.reverse() });
        }
      }
    };

    for (const n of nodes) {
      if (!index.has(n)) strongConnect(n);
    }

    this._cycleCache = sccs;
    return sccs;
  }

  /** Cycles that involve a specific file. */
  getCircularFor(filePath: string): CircularDependency[] {
    const abs = path.resolve(filePath);
    return this.detectCircular().filter(c => c.cycle.includes(abs));
  }

  /** Full graph node for a file. */
  getNode(filePath: string): GraphNode {
    const abs = path.resolve(filePath);
    return {
      filePath: abs,
      imports:  this.getDependencies(abs),
      importedBy: this.getDependents(abs),
    };
  }

  stats(): ImportGraphStats { return this._makeStats(); }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
    this._deps.clear();
    this._dependents.clear();
    this._cycleCache = null;
  }

  // ── Private wiring ─────────────────────────────────────────────────────────

  private _wireFile(absSource: string, moduleSpecifiers: string[]): void {
    if (!this._deps.has(absSource)) this._deps.set(absSource, new Set());
    const depSet = this._deps.get(absSource)!;

    for (const spec of moduleSpecifiers) {
      const resolved = resolveImportPath(spec, absSource);
      if (!resolved) continue;   // node_modules — skip

      depSet.add(resolved);

      // Reverse edge
      if (!this._dependents.has(resolved)) this._dependents.set(resolved, new Set());
      this._dependents.get(resolved)!.add(absSource);
    }
  }

  private _unwireFile(absSource: string): void {
    const oldDeps = this._deps.get(absSource);
    if (!oldDeps) return;

    // Remove reverse edges
    for (const dep of oldDeps) {
      this._dependents.get(dep)?.delete(absSource);
    }
    oldDeps.clear();
  }

  private _makeStats(): ImportGraphStats {
    let edges = 0;
    for (const s of this._deps.values()) edges += s.size;
    return {
      fileCount:  this._deps.size,
      edgeCount:  edges,
      cycleCount: this.detectCircular().length,
      builtAt:    new Date().toISOString(),
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _graph: ImportGraph | null = null;

export function getImportGraph(): ImportGraph {
  if (!_graph) _graph = new ImportGraph();
  return _graph;
}

// ─── VS Code commands ─────────────────────────────────────────────────────────

export function registerImportGraphCommands(context: vscode.ExtensionContext): void {

  context.subscriptions.push(

    // ── Show direct dependencies ──────────────────────────────────────────
    vscode.commands.registerCommand('frontendAI.showDependencies', async () => {
      const fp = activeFilePath(); if (!fp) return;
      const graph = getImportGraph();
      const deps  = graph.getDependencies(fp);

      if (deps.length === 0) {
        vscode.window.showInformationMessage('This file has no local dependencies.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        deps.map(d => ({
          label:   `$(file-code)  ${vscode.workspace.asRelativePath(d)}`,
          fsPath:  d,
        })),
        { title: `Dependencies of ${path.basename(fp)}`, placeHolder: 'Select to open…' }
      );
      if (picked) openFile((picked as any).fsPath);
    }),

    // ── Show dependents ───────────────────────────────────────────────────
    vscode.commands.registerCommand('frontendAI.showDependents', async () => {
      const fp  = activeFilePath(); if (!fp) return;
      const graph = getImportGraph();
      const deps  = graph.getDependents(fp);

      if (deps.length === 0) {
        vscode.window.showInformationMessage('No files import this file.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        deps.map(d => ({
          label:  `$(file-code)  ${vscode.workspace.asRelativePath(d)}`,
          fsPath: d,
        })),
        { title: `Files that import ${path.basename(fp)}`, placeHolder: 'Select to open…' }
      );
      if (picked) openFile((picked as any).fsPath);
    }),

    // ── Show circular dependencies ────────────────────────────────────────
    vscode.commands.registerCommand('frontendAI.showCircularDeps', async () => {
      const cycles = getImportGraph().detectCircular();

      if (cycles.length === 0) {
        vscode.window.showInformationMessage('✅ No circular dependencies found.');
        return;
      }

      const items = cycles.flatMap((c, i) => [
        {
          label:   `$(warning) Cycle ${i + 1}  (${c.cycle.length} files)`,
          kind:    vscode.QuickPickItemKind.Separator,
          cycle:   null as null,
          fsPath:  null as null,
        },
        ...c.cycle.map(f => ({
          label:  `  $(arrow-right)  ${vscode.workspace.asRelativePath(f)}`,
          kind:   vscode.QuickPickItemKind.Default,
          cycle:  c,
          fsPath: f,
        })),
      ]);

      const picked = await vscode.window.showQuickPick(items as any[], {
        title:       `${cycles.length} circular dependenc${cycles.length !== 1 ? 'ies' : 'y'} found`,
        placeHolder: 'Select a file to open…',
      });
      if (picked?.fsPath) openFile(picked.fsPath);
    }),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function activeFilePath(): string | undefined {
  const fp = vscode.window.activeTextEditor?.document.fileName;
  if (!fp) { vscode.window.showWarningMessage('frontendAI: No active editor.'); return undefined; }
  return path.resolve(fp);
}

async function openFile(filePath: string): Promise<void> {
  const uri    = vscode.Uri.file(filePath);
  const editor = await vscode.window.showTextDocument(uri, { preview: false });
  editor.revealRange(new vscode.Range(0, 0, 0, 0));
}
