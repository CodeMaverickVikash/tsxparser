/**
 * projectIndexer.ts — Project-Wide Symbol Indexer (Incremental Edition)
 *
 * ─── Data-structure design ───────────────────────────────────────────────────
 *
 *  Forward index  (lookup by name — O(1))
 *    symbols: Map<name, IndexedSymbol[]>
 *
 *  Reverse index  (lookup by file — O(unique names in file), not O(all symbols))
 *    _fileToNames: Map<absPath, Set<name>>
 *
 *  File store     (raw parse results)
 *    files: Map<absPath, ParsedFile>
 *
 * ─── Incremental update pipeline ────────────────────────────────────────────
 *
 *  Event source             Debounce            Action
 *  ──────────────────────── ─────────────────── ─────────────────────────────
 *  onDidChangeTextDocument  TYPING_DEBOUNCE     updateFile (in-memory doc)
 *  onDidSaveTextDocument    SAVE_DEBOUNCE        updateFile (disk, supersedes typing)
 *  FileSystemWatcher change FS_DEBOUNCE          updateFile (disk, skipped if open)
 *  FileSystemWatcher create FS_DEBOUNCE          updateFile (disk)
 *  FileSystemWatcher delete immediate            removeFile
 *
 *  Per-file mutex prevents concurrent parses of the same path.
 *  A pending-update slot per file coalesces rapid multi-source bursts
 *  into at most one queued update — newer overwrites older.
 *
 * ─── Diff events ─────────────────────────────────────────────────────────────
 *
 *  onDidChangeIndex  fires with full IndexStats after every mutation
 *  onDidUpdateFile   fires with a FileDiff (added / removed / changed symbols)
 *                    so consumers (tree views, diagnostics) do surgical updates
 *
 * ─── Public API ──────────────────────────────────────────────────────────────
 *
 *  buildIndex()                    full workspace scan
 *  updateFile(filePath)            re-index one file from disk
 *  removeFile(filePath)            drop a file from the index
 *  getSymbol(name)                 case-insensitive lookup
 *  getSymbolExact(name)            O(1) exact lookup
 *  searchByPrefix(prefix)          autocomplete
 *  searchSymbols(query)            fuzzy substring
 *  getSymbolsInFile(filePath)      outline view
 *  findImporters(symbolName)       find usages
 *  getFile(filePath)               raw ParsedFile
 *  stats / index                   current stats + read-only index snapshot
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { parseFile, parseDocument, invalidateCache, ParsedFile } from './astParser';

// ─── Public types ─────────────────────────────────────────────────────────────

export type SymbolType = 'function' | 'class' | 'variable' | 'method' | 'property';

export interface SymbolLocation {
  line:   number;   // 0-based
  column: number;   // 0-based
  offset: number;   // absolute character offset
}

export interface IndexedSymbol {
  name:      string;
  type:      SymbolType;
  filePath:  string;
  location:  SymbolLocation;
  exported:  boolean;
  detail?:   string;   // signature, type annotation, hook name …
  parent?:   string;   // owning class/component (methods & properties)
}

export interface ProjectIndex {
  symbols: Map<string, IndexedSymbol[]>; // name  → symbols
  files:   Map<string, ParsedFile>;       // path  → parse result
}

export interface IndexStats {
  fileCount:   number;
  symbolCount: number;
  buildTimeMs: number;   // ms for last full build; 0 for patches
  builtAt:     string;   // ISO timestamp
  patchCount:  number;   // incremental updates since last full build
}

export type UpdateReason =
  | 'typing'     // onDidChangeTextDocument
  | 'save'       // onDidSaveTextDocument
  | 'fs-change'  // FileSystemWatcher change (file not open in editor)
  | 'fs-create'  // FileSystemWatcher create
  | 'fs-delete'  // FileSystemWatcher delete
  | 'manual';    // explicit updateFile() / removeFile()

/** Granular per-file diff — emitted by onDidUpdateFile */
export interface FileDiff {
  filePath: string;
  reason:   UpdateReason;
  added:    IndexedSymbol[];
  removed:  IndexedSymbol[];
  /** Symbols whose location or detail changed (identity: type+name+parent) */
  changed:  Array<{ before: IndexedSymbol; after: IndexedSymbol }>;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface IndexerConfig {
  additionalExcludes?: string[];
  /** Debounce for keystrokes. Default 500 ms. */
  typingDebounceMs?:  number;
  /** Debounce after save (disk-flush wait). Default 80 ms. */
  saveDebounceMs?:    number;
  /** Debounce for raw FS events (formatters, git). Default 300 ms. */
  fsDebounceMs?:      number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/out/**', '**/.cache/**', '**/.git/**',
  '**/__snapshots__/**', '**/*.d.ts', '**/*.min.js',
];

const SUPPORTED_EXTS    = ['.ts', '.tsx', '.js', '.jsx'];
const GLOB_PATTERN      = '**/*.{ts,tsx,js,jsx}';
const PARSE_CONCURRENCY = 12;

// ═════════════════════════════════════════════════════════════════════════════
// ProjectIndexer
// ═════════════════════════════════════════════════════════════════════════════

export class ProjectIndexer implements vscode.Disposable {

  // ── Index storage ──────────────────────────────────────────────────────────

  private readonly _index: ProjectIndex = {
    symbols: new Map(),
    files:   new Map(),
  };

  /**
   * Reverse index: absPath → Set<symbolName>
   *
   * Converts _eraseFile() from O(totalSymbols) → O(uniqueNamesInFile).
   * Example: 10 000 symbols project, file with 25 symbols → ~400× fewer ops.
   */
  private readonly _fileToNames = new Map<string, Set<string>>();

  // ── State ──────────────────────────────────────────────────────────────────

  private _stats: IndexStats = {
    fileCount: 0, symbolCount: 0, buildTimeMs: 0, builtAt: '', patchCount: 0,
  };
  private _isBuilding = false;
  private _patchCount = 0;
  private _disposables: vscode.Disposable[] = [];

  // ── Separate debounce timers per source ────────────────────────────────────
  // Keeping them separate lets a save cancel the typing timer without
  // affecting the FS timer (and vice versa).

  private readonly _typingTimers = new Map<string, NodeJS.Timeout>();
  private readonly _saveTimers   = new Map<string, NodeJS.Timeout>();
  private readonly _fsTimers     = new Map<string, NodeJS.Timeout>();

  // ── Per-file update lock (serialises concurrent parses for the same file) ──

  private readonly _updateLocks    = new Map<string, Promise<void>>();
  /**
   * Pending-update slot: one pending update per file maximum.
   * Newer request overwrites the older pending one.
   */
  private readonly _pendingUpdates = new Map<string, () => Promise<void>>();

  // ── Events ─────────────────────────────────────────────────────────────────

  private readonly _onDidChangeIndex = new vscode.EventEmitter<IndexStats>();
  private readonly _onDidUpdateFile  = new vscode.EventEmitter<FileDiff>();

  readonly onDidChangeIndex = this._onDidChangeIndex.event;
  readonly onDidUpdateFile  = this._onDidUpdateFile.event;

  // ── Constructor ────────────────────────────────────────────────────────────

  constructor(private readonly config: IndexerConfig = {}) {
    this._startWatchers();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Full workspace scan with progress indicator. */
  async buildIndex(): Promise<IndexStats> {
    if (this._isBuilding) {
      return new Promise(resolve => {
        const sub = this._onDidChangeIndex.event(s => { sub.dispose(); resolve(s); });
      });
    }

    this._isBuilding = true;
    this._patchCount = 0;
    const t0 = Date.now();

    const stats = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'TSX: Indexing…', cancellable: false },
      async (progress) => {
        progress.report({ message: 'Scanning files…' });

        const uris  = await vscode.workspace.findFiles(GLOB_PATTERN, this._buildExcludeGlob());
        const paths = uris.map(u => u.fsPath)
          .filter(p => SUPPORTED_EXTS.includes(path.extname(p).toLowerCase()));

        this._index.symbols.clear();
        this._index.files.clear();
        this._fileToNames.clear();

        const total = paths.length;
        let done = 0;

        await runBatched(paths, PARSE_CONCURRENCY, async fp => {
          try { this._indexFile(parseFile(fp)); } catch { /* skip */ }
          done++;
          if (done % 20 === 0 || done === total) {
            progress.report({ message: `${done}/${total} files` });
          }
        });

        const s = this._makeStats(Date.now() - t0);
        this._isBuilding = false;
        this._onDidChangeIndex.fire(s);
        return s;
      }
    );

    return stats;
  }

  // ── Incremental mutations ──────────────────────────────────────────────────

  /**
   * Re-index a single file from disk.
   * Invalidates the parser cache, diffs old vs new symbols, fires events.
   * Concurrent calls for the same file are serialised automatically.
   */
  async updateFile(filePath: string): Promise<void> {
    const abs = path.resolve(filePath);
    return this._enqueueUpdate(abs, 'manual', async () => {
      invalidateCache(abs);
      try {
        await this._applyFilePatch(abs, parseFile(abs), 'manual');
      } catch {
        await this._applyRemove(abs, 'manual');
      }
    });
  }

  /**
   * Remove a file from the index entirely.
   * Idempotent — safe to call for files not yet indexed.
   */
  async removeFile(filePath: string): Promise<void> {
    const abs = path.resolve(filePath);
    return this._enqueueUpdate(abs, 'manual', async () => {
      invalidateCache(abs);
      await this._applyRemove(abs, 'manual');
    });
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /** Case-insensitive lookup; falls back to exact then case-insensitive scan. */
  getSymbol(name: string): IndexedSymbol[] {
    const exact = this._index.symbols.get(name);
    if (exact?.length) return exact;
    const lower = name.toLowerCase();
    for (const [k, v] of this._index.symbols) {
      if (k.toLowerCase() === lower) return v;
    }
    return [];
  }

  /** O(1) exact case-sensitive lookup. */
  getSymbolExact(name: string): IndexedSymbol[] {
    return this._index.symbols.get(name) ?? [];
  }

  /** Autocomplete: all symbols whose name starts with `prefix`. */
  searchByPrefix(prefix: string): IndexedSymbol[] {
    const lower = prefix.toLowerCase();
    const out: IndexedSymbol[] = [];
    for (const [k, v] of this._index.symbols) {
      if (k.toLowerCase().startsWith(lower)) out.push(...v);
    }
    return out;
  }

  /** Fuzzy substring: chars of `query` appear in order in the symbol name. */
  searchSymbols(query: string): IndexedSymbol[] {
    if (!query) return [];
    const lower = query.toLowerCase();
    const out: IndexedSymbol[] = [];
    for (const [k, v] of this._index.symbols) {
      if (fuzzyMatch(k.toLowerCase(), lower)) out.push(...v);
    }
    return out.sort((a, b) => a.name.length - b.name.length);
  }

  /** All symbols defined in a specific file, sorted by line. */
  getSymbolsInFile(filePath: string): IndexedSymbol[] {
    const abs   = path.resolve(filePath);
    const names = this._fileToNames.get(abs);
    if (!names?.size) return [];
    const out: IndexedSymbol[] = [];
    for (const name of names) {
      const bucket = this._index.symbols.get(name);
      if (bucket) out.push(...bucket.filter(s => s.filePath === abs));
    }
    return out.sort((a, b) => a.location.line - b.location.line);
  }

  /** Find every file that imports `symbolName`. */
  findImporters(symbolName: string): Array<{ filePath: string; importedAs: string }> {
    const out: Array<{ filePath: string; importedAs: string }> = [];
    for (const [fp, parsed] of this._index.files) {
      for (const imp of parsed.imports) {
        if (imp.defaultImport === symbolName || imp.namespaceImport === symbolName) {
          out.push({ filePath: fp, importedAs: symbolName }); break;
        }
        const n = imp.named.find(x => x.name === symbolName || x.alias === symbolName);
        if (n) { out.push({ filePath: fp, importedAs: n.alias ?? n.name }); break; }
      }
    }
    return out;
  }

  getFile(filePath: string): ParsedFile | undefined {
    return this._index.files.get(path.resolve(filePath));
  }

  get index(): Readonly<ProjectIndex> { return this._index; }
  get stats(): Readonly<IndexStats>   { return this._stats; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    this._onDidChangeIndex.dispose();
    this._onDidUpdateFile.dispose();
    for (const d of this._disposables)          d.dispose();
    for (const t of this._typingTimers.values()) clearTimeout(t);
    for (const t of this._saveTimers.values())   clearTimeout(t);
    for (const t of this._fsTimers.values())     clearTimeout(t);
    this._disposables = [];
    this._typingTimers.clear();
    this._saveTimers.clear();
    this._fsTimers.clear();
    this._index.symbols.clear();
    this._index.files.clear();
    this._fileToNames.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: WATCHERS
  // ═══════════════════════════════════════════════════════════════════════════

  private _startWatchers(): void {
    const typingMs = this.config.typingDebounceMs ?? 500;
    const saveMs   = this.config.saveDebounceMs   ?? 80;
    const fsMs     = this.config.fsDebounceMs     ?? 300;

    // ── onDidChangeTextDocument ─── keystrokes / in-memory ────────────────
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!isSupportedLang(e.document.languageId)) return;
      const abs = path.resolve(e.document.fileName);
      if (this._isExcluded(abs)) return;

      debounceOn(this._typingTimers, abs, typingMs, () => {
        // Capture document reference at schedule time to avoid stale closure
        const doc = e.document;
        this._enqueueUpdate(abs, 'typing', async () => {
          try {
            const parsed = parseDocument(doc);
            await this._applyFilePatch(abs, parsed, 'typing');
          } catch { /* document closed */ }
        });
      });
    }, null, this._disposables);

    // ── onDidSaveTextDocument ─────────────────────────────────────────────
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!isSupportedLang(doc.languageId)) return;
      const abs = path.resolve(doc.fileName);
      if (this._isExcluded(abs)) return;

      // Save supersedes any pending typing update for this file
      cancelTimer(this._typingTimers, abs);

      debounceOn(this._saveTimers, abs, saveMs, () => {
        this._enqueueUpdate(abs, 'save', async () => {
          invalidateCache(abs);
          try {
            const parsed = parseFile(abs);
            await this._applyFilePatch(abs, parsed, 'save');
          } catch {
            await this._applyRemove(abs, 'save');
          }
        });
      });
    }, null, this._disposables);

    // ── FileSystemWatcher ─── external tools, git, formatters ─────────────
    const watcher = vscode.workspace.createFileSystemWatcher(
      GLOB_PATTERN, false, false, false
    );

    watcher.onDidCreate(uri => {
      const abs = path.resolve(uri.fsPath);
      if (this._isExcluded(abs)) return;
      debounceOn(this._fsTimers, abs, fsMs, () => {
        this._enqueueUpdate(abs, 'fs-create', async () => {
          invalidateCache(abs);
          try { await this._applyFilePatch(abs, parseFile(abs), 'fs-create'); }
          catch { /* ignore unreadable new file */ }
        });
      });
    }, null, this._disposables);

    watcher.onDidChange(uri => {
      const abs = path.resolve(uri.fsPath);
      if (this._isExcluded(abs)) return;
      // Skip: if the file is open in an editor the save path already handles it
      if (this._isOpenInEditor(abs)) return;

      debounceOn(this._fsTimers, abs, fsMs, () => {
        this._enqueueUpdate(abs, 'fs-change', async () => {
          invalidateCache(abs);
          try { await this._applyFilePatch(abs, parseFile(abs), 'fs-change'); }
          catch { await this._applyRemove(abs, 'fs-change'); }
        });
      });
    }, null, this._disposables);

    watcher.onDidDelete(uri => {
      const abs = path.resolve(uri.fsPath);
      // Immediate — cancel all pending timers for this file
      cancelTimer(this._typingTimers, abs);
      cancelTimer(this._saveTimers,   abs);
      cancelTimer(this._fsTimers,     abs);

      this._enqueueUpdate(abs, 'fs-delete', async () => {
        invalidateCache(abs);
        await this._applyRemove(abs, 'fs-delete');
      });
    }, null, this._disposables);

    this._disposables.push(watcher);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: PER-FILE UPDATE LOCK
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Serialise updates for a single file.
   *
   * • No existing lock  → run immediately, set lock promise.
   * • Lock exists       → store thunk as "pending" (overwrites previous pending).
   *
   * After the running promise settles, it checks for a pending thunk and
   * chains it.  Result: at most 1 running + 1 queued per file, regardless
   * of how many watcher events fire in rapid succession.
   */
  private _enqueueUpdate(
    abs:  string,
    _reason: UpdateReason,
    work: () => Promise<void>
  ): Promise<void> {
    const existing = this._updateLocks.get(abs);

    if (!existing) {
      const p = work().finally(() => {
        this._updateLocks.delete(abs);
        const next = this._pendingUpdates.get(abs);
        if (next) { this._pendingUpdates.delete(abs); next(); }
      });
      this._updateLocks.set(abs, p);
      return p;
    }

    // Queue: newer overwrites older pending
    return new Promise<void>(resolve => {
      this._pendingUpdates.set(abs, async () => { await work(); resolve(); });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: INDEX MUTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Atomic incremental patch for one file:
   *  1. Snapshot old symbols (O(names in file) via reverse index).
   *  2. Erase old entries from forward + reverse index.
   *  3. Re-index the new ParsedFile.
   *  4. Snapshot new symbols.
   *  5. Compute and emit diff.
   */
  private async _applyFilePatch(
    abs:    string,
    parsed: ParsedFile,
    reason: UpdateReason
  ): Promise<void> {
    const oldSymbols = this._snapshotFile(abs);

    this._eraseFile(abs);
    this._indexFile(parsed);

    const newSymbols = this._snapshotFile(abs);
    const diff       = computeDiff(abs, reason, oldSymbols, newSymbols);

    this._patchCount++;
    this._onDidUpdateFile.fire(diff);
    this._onDidChangeIndex.fire(this._makeStats(0));
  }

  private async _applyRemove(abs: string, reason: UpdateReason): Promise<void> {
    const oldSymbols = this._snapshotFile(abs);
    this._eraseFile(abs);

    if (oldSymbols.length > 0) {
      this._patchCount++;
      this._onDidUpdateFile.fire({ filePath: abs, reason, added: [], removed: oldSymbols, changed: [] });
      this._onDidChangeIndex.fire(this._makeStats(0));
    }
  }

  // ── Forward index writer ───────────────────────────────────────────────────

  private _indexFile(parsed: ParsedFile): void {
    const abs   = path.resolve(parsed.filePath);
    this._index.files.set(abs, parsed);
    const names = getOrCreate(this._fileToNames, abs, () => new Set<string>());

    const add = (sym: IndexedSymbol) => {
      names.add(sym.name);
      const bucket = this._index.symbols.get(sym.name);
      if (bucket) bucket.push(sym);
      else this._index.symbols.set(sym.name, [sym]);
    };

    for (const fn of parsed.functions) {
      add({ name: fn.name, type: 'function', filePath: abs,
            location: locOf(fn.span), exported: fn.exported,
            detail: buildFunctionDetail(fn) });
    }

    for (const cls of parsed.classes) {
      add({ name: cls.name, type: 'class', filePath: abs,
            location: locOf(cls.span), exported: cls.exported,
            detail: cls.superClass ? `extends ${cls.superClass}` : undefined });

      for (const m of cls.methods) {
        add({ name: m.name, type: 'method', filePath: abs,
              location: locOf(m.span), exported: false,
              detail: buildFunctionDetail(m), parent: cls.name });
      }
      for (const p of cls.properties) {
        add({ name: p.name, type: 'property', filePath: abs,
              location: locOf(p.span), exported: false,
              detail: p.type, parent: cls.name });
      }
    }

    for (const v of parsed.variables) {
      if (v.initKind === 'arrow' || v.initKind === 'function') continue;
      add({ name: v.name, type: 'variable', filePath: abs,
            location: locOf(v.span), exported: v.exported,
            detail: v.hookName ? `hook: ${v.hookName}` : (v.type ?? v.kind) });
    }
  }

  /**
   * Remove all forward-index entries for `abs`.
   * O(unique symbol names in file) — not O(total symbols in project).
   */
  private _eraseFile(abs: string): void {
    this._index.files.delete(abs);
    const names = this._fileToNames.get(abs);
    if (!names) return;

    for (const name of names) {
      const bucket = this._index.symbols.get(name);
      if (!bucket) continue;
      const filtered = bucket.filter(s => s.filePath !== abs);
      if (filtered.length === 0) this._index.symbols.delete(name);
      else                       this._index.symbols.set(name, filtered);
    }
    this._fileToNames.delete(abs);
  }

  // ── Reverse-index snapshot (used for diff computation) ─────────────────────

  private _snapshotFile(abs: string): IndexedSymbol[] {
    const names = this._fileToNames.get(abs);
    if (!names?.size) return [];
    const out: IndexedSymbol[] = [];
    for (const name of names) {
      const bucket = this._index.symbols.get(name);
      if (bucket) out.push(...bucket.filter(s => s.filePath === abs));
    }
    return out;
  }

  // ── Misc helpers ───────────────────────────────────────────────────────────

  private _makeStats(buildTimeMs: number): IndexStats {
    const s: IndexStats = {
      fileCount:   this._index.files.size,
      symbolCount: countAll(this._index.symbols),
      buildTimeMs,
      builtAt:     new Date().toISOString(),
      patchCount:  this._patchCount,
    };
    this._stats = s;
    return s;
  }

  private _buildExcludeGlob(): string {
    const fe = vscode.workspace.getConfiguration('files')
      .get<Record<string, boolean>>('exclude') ?? {};
    const se = vscode.workspace.getConfiguration('search')
      .get<Record<string, boolean>>('exclude') ?? {};
    const all = [
      ...DEFAULT_EXCLUDES,
      ...(this.config.additionalExcludes ?? []),
      ...Object.entries(fe).filter(([, v]) => v).map(([k]) => k),
      ...Object.entries(se).filter(([, v]) => v).map(([k]) => k),
    ];
    return `{${all.join(',')}}`;
  }

  private _isExcluded(abs: string): boolean {
    const s = abs.replace(/\\/g, '/');
    return (
      s.includes('/node_modules/') || s.includes('/dist/') ||
      s.includes('/build/')        || s.includes('/.git/') ||
      s.endsWith('.d.ts')          || s.endsWith('.min.js')
    );
  }

  private _isOpenInEditor(abs: string): boolean {
    return vscode.workspace.textDocuments
      .some(d => path.resolve(d.fileName) === abs);
  }
}

// ─── Singleton convenience wrappers ──────────────────────────────────────────

let _globalIndexer: ProjectIndexer | null = null;

export function getIndexer(config?: IndexerConfig): ProjectIndexer {
  if (!_globalIndexer) _globalIndexer = new ProjectIndexer(config);
  return _globalIndexer;
}

export async function buildIndex(config?: IndexerConfig): Promise<IndexStats> {
  return getIndexer(config).buildIndex();
}

export function getSymbol(name: string): IndexedSymbol[] {
  return getIndexer().getSymbol(name);
}

// ─── Pure utility functions ───────────────────────────────────────────────────

/**
 * Compute a symbol-level diff between two snapshots of the same file.
 *
 * Identity key: "type::name::parent?" — two symbols with the same key
 * in before+after are "changed" (location or detail updated), not add+remove.
 */
function computeDiff(
  filePath: string,
  reason:   UpdateReason,
  before:   IndexedSymbol[],
  after:    IndexedSymbol[]
): FileDiff {
  const key = (s: IndexedSymbol) => `${s.type}::${s.name}::${s.parent ?? ''}`;

  const bMap = new Map(before.map(s => [key(s), s]));
  const aMap = new Map(after.map( s => [key(s), s]));

  const added:   IndexedSymbol[]         = [];
  const removed: IndexedSymbol[]         = [];
  const changed: FileDiff['changed']     = [];

  for (const [k, bSym] of bMap) {
    const aSym = aMap.get(k);
    if (!aSym)                    removed.push(bSym);
    else if (symChanged(bSym, aSym)) changed.push({ before: bSym, after: aSym });
  }
  for (const [k, aSym] of aMap) {
    if (!bMap.has(k)) added.push(aSym);
  }

  return { filePath, reason, added, removed, changed };
}

function symChanged(a: IndexedSymbol, b: IndexedSymbol): boolean {
  return (
    a.location.line   !== b.location.line   ||
    a.location.column !== b.location.column ||
    a.exported        !== b.exported        ||
    a.detail          !== b.detail
  );
}

function debounceOn(
  map: Map<string, NodeJS.Timeout>,
  key: string, ms: number, fn: () => void
): void {
  const t = map.get(key);
  if (t) clearTimeout(t);
  map.set(key, setTimeout(() => { map.delete(key); fn(); }, ms));
}

function cancelTimer(map: Map<string, NodeJS.Timeout>, key: string): void {
  const t = map.get(key);
  if (t) { clearTimeout(t); map.delete(key); }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, mk: () => V): V {
  let v = map.get(key); if (!v) { v = mk(); map.set(key, v); } return v;
}

function countAll(map: Map<string, IndexedSymbol[]>): number {
  let n = 0; for (const v of map.values()) n += v.length; return n;
}

function locOf(span: { start: { line: number; character: number; offset: number } }): SymbolLocation {
  return { line: span.start.line, column: span.start.character, offset: span.start.offset };
}

function fuzzyMatch(text: string, pat: string): boolean {
  let pi = 0;
  for (let ti = 0; ti < text.length && pi < pat.length; ti++) {
    if (text[ti] === pat[pi]) pi++;
  }
  return pi === pat.length;
}

function buildFunctionDetail(fn: {
  params:      Array<{ name: string; type?: string; rest: boolean; optional: boolean }>;
  returnType?: string;
  async:       boolean;
}): string {
  const ps = fn.params
    .map(p => `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}`)
    .join(', ');
  return `${fn.async ? 'async ' : ''}(${ps})${fn.returnType ? ` → ${fn.returnType}` : ''}`;
}

async function runBatched<T>(
  items: T[], concurrency: number, task: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  const w = async () => { while (i < items.length) await task(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, w));
}

function isSupportedLang(lang: string): boolean {
  return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(lang);
}