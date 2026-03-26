/**
 * astCache.ts — High-Performance AST Cache for 10 k+ File Projects
 *
 * ─── Problem ──────────────────────────────────────────────────────────────────
 *
 *  The default astParser cache is an unbounded Map that never evicts entries.
 *  In large mono-repos this causes:
 *    • Unbounded memory growth (stale ASTs kept forever)
 *    • Re-parses on every activation (mtime only, no content hash)
 *    • Sequential indexing blocked by slow files
 *
 * ─── Solutions implemented ────────────────────────────────────────────────────
 *
 *  1. LRU eviction        — bounded Map with configurable capacity (default 500)
 *  2. Content-hash check  — xxHash-style djb2 fingerprint; skips re-parse when
 *                           content hasn't changed even if mtime ticked
 *  3. Lazy loading        — files not yet accessed are never parsed
 *  4. Parallel parsing    — controlled concurrency pool (default 12 workers)
 *  5. Memory pressure     — responds to process.memoryUsage() to auto-trim cache
 *  6. Warm-up hints       — prioritise open editor files on first build
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *  getAstCache()                  → singleton AstCache instance
 *  AstCache.get(filePath)         → ParsedFile | undefined  (lazy, from cache)
 *  AstCache.parse(filePath)       → ParsedFile  (parse + cache)
 *  AstCache.parseMany(paths, cb)  → Promise<void>  (parallel with progress)
 *  AstCache.invalidate(filePath)  → void
 *  AstCache.trim(targetSize?)     → number  (entries evicted)
 *  AstCache.stats()               → CacheStats
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseFile, parseDocument, invalidateCache as parserInvalidate, ParsedFile } from './astParser';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CacheStats {
  size:         number;
  capacity:     number;
  hits:         number;
  misses:       number;
  evictions:    number;
  hitRate:      string;   // "87.3 %"
  memoryUsedMB: number;
}

export interface AstCacheOptions {
  /** Maximum number of parsed files to keep in memory. Default 500. */
  capacity?:        number;
  /** Parallel parse workers for bulk operations. Default 12. */
  concurrency?:     number;
  /** Trim to this fraction of capacity when memory pressure detected. Default 0.6. */
  trimFactor?:      number;
  /** MB threshold to trigger auto-trim. Default 400. */
  memPressureMB?:   number;
}

// ─── LRU node ─────────────────────────────────────────────────────────────────

interface LruEntry {
  result:  ParsedFile;
  hash:    number;    // djb2 content hash
  mtime:   number;    // mtime at parse time (ms)
  size:    number;    // file size at parse time (bytes)
  prev:    string | null;
  next:    string | null;
}

// ─── AstCache ────────────────────────────────────────────────────────────────

export class AstCache {

  private readonly _map      = new Map<string, LruEntry>();
  private _head: string | null = null;   // MRU end
  private _tail: string | null = null;   // LRU end

  private readonly _capacity:     number;
  private readonly _concurrency:  number;
  private readonly _trimFactor:   number;
  private readonly _memPressureMB: number;

  private _hits      = 0;
  private _misses    = 0;
  private _evictions = 0;

  constructor(opts: AstCacheOptions = {}) {
    this._capacity      = opts.capacity      ?? 500;
    this._concurrency   = opts.concurrency   ?? 12;
    this._trimFactor    = opts.trimFactor    ?? 0.6;
    this._memPressureMB = opts.memPressureMB ?? 400;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Return cached result for `filePath` without parsing.
   * Returns undefined if not cached or stale.
   */
  get(filePath: string): ParsedFile | undefined {
    const abs   = path.resolve(filePath);
    const entry = this._map.get(abs);
    if (!entry) return undefined;

    // Validate freshness
    try {
      const stat = fs.statSync(abs);
      if (stat.mtimeMs !== entry.mtime || stat.size !== entry.size) {
        this._evict(abs);
        return undefined;
      }
    } catch {
      this._evict(abs);
      return undefined;
    }

    this._promote(abs);
    this._hits++;
    return entry.result;
  }

  /**
   * Parse `filePath` and cache the result.
   * Uses content hash to skip re-parse when file hasn't actually changed.
   */
  parse(filePath: string): ParsedFile {
    const abs = path.resolve(filePath);

    // ── Read stat ─────────────────────────────────────────────────────────
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); }
    catch { return emptyParsed(abs); }

    // ── Check existing entry ──────────────────────────────────────────────
    const existing = this._map.get(abs);
    if (existing) {
      if (existing.mtime === stat.mtimeMs && existing.size === stat.size) {
        this._promote(abs);
        this._hits++;
        return existing.result;
      }
    }

    // ── Read file and hash ────────────────────────────────────────────────
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch { return emptyParsed(abs); }

    const hash = djb2(text);

    if (existing && existing.hash === hash) {
      // Content unchanged — update mtime/size, skip re-parse
      existing.mtime = stat.mtimeMs;
      existing.size  = stat.size;
      this._promote(abs);
      this._hits++;
      return existing.result;
    }

    // ── Full parse ────────────────────────────────────────────────────────
    this._misses++;
    parserInvalidate(abs);   // clear parser-internal cache
    const result = parseFile(abs);

    this._store(abs, result, hash, stat.mtimeMs, stat.size);
    this._checkMemPressure();

    return result;
  }

  /**
   * Parse a VS Code TextDocument (no disk I/O, uses doc.version).
   */
  parseDoc(doc: { fileName: string; getText(): string; version: number }): ParsedFile {
    const abs   = path.resolve(doc.fileName);
    const entry = this._map.get(abs);

    if (entry && (entry as any).docVersion === doc.version) {
      this._promote(abs);
      this._hits++;
      return entry.result;
    }

    this._misses++;
    const result = parseDocument(doc);
    const e = this._store(abs, result, 0, 0, 0);
    (e as any).docVersion = doc.version;
    return result;
  }

  /**
   * Parse an array of file paths with bounded concurrency.
   * Calls `onProgress(done, total)` after each file.
   */
  async parseMany(
    filePaths:  string[],
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    // Prioritise currently-open editors
    const openFiles = new Set(
      vscode.workspace.textDocuments.map(d => path.resolve(d.fileName))
    );
    const sorted = [...filePaths].sort((a, b) => {
      const aOpen = openFiles.has(a) ? 0 : 1;
      const bOpen = openFiles.has(b) ? 0 : 1;
      return aOpen - bOpen;
    });

    const total = sorted.length;
    let   done  = 0;
    let   i     = 0;

    const worker = async () => {
      while (i < sorted.length) {
        const fp = sorted[i++];
        try { this.parse(fp); }
        catch { /* skip unreadable */ }
        done++;
        onProgress?.(done, total);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this._concurrency, sorted.length) }, worker)
    );
  }

  /** Drop a single entry and clear the parser cache for it. */
  invalidate(filePath: string): void {
    const abs = path.resolve(filePath);
    this._evict(abs);
    parserInvalidate(abs);
  }

  /** Trim cache to `targetSize` entries (default: capacity * trimFactor). */
  trim(targetSize?: number): number {
    const target  = targetSize ?? Math.floor(this._capacity * this._trimFactor);
    let   evicted = 0;
    while (this._map.size > target && this._tail) {
      this._evict(this._tail);
      evicted++;
    }
    return evicted;
  }

  /** Clear everything. */
  clear(): void {
    this._map.clear();
    this._head = this._tail = null;
  }

  stats(): CacheStats {
    const total  = this._hits + this._misses;
    const memMB  = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    return {
      size:         this._map.size,
      capacity:     this._capacity,
      hits:         this._hits,
      misses:       this._misses,
      evictions:    this._evictions,
      hitRate:      total ? `${((this._hits / total) * 100).toFixed(1)} %` : 'N/A',
      memoryUsedMB: memMB,
    };
  }

  // ── LRU internals ──────────────────────────────────────────────────────────

  private _store(
    abs:    string,
    result: ParsedFile,
    hash:   number,
    mtime:  number,
    size:   number
  ): LruEntry {
    const entry: LruEntry = { result, hash, mtime, size, prev: null, next: this._head };

    // Evict LRU if over capacity
    if (this._map.size >= this._capacity) {
      if (this._tail) this._evict(this._tail);
    }

    if (this._head) this._map.get(this._head)!.prev = abs;
    this._head = abs;
    if (!this._tail) this._tail = abs;

    this._map.set(abs, entry);
    return entry;
  }

  private _promote(abs: string): void {
    if (this._head === abs) return;
    const entry = this._map.get(abs);
    if (!entry) return;

    // Unlink
    if (entry.prev) this._map.get(entry.prev)!.next = entry.next;
    if (entry.next) this._map.get(entry.next)!.prev = entry.prev;
    if (this._tail === abs) this._tail = entry.prev;

    // Prepend
    entry.prev = null;
    entry.next = this._head;
    if (this._head) this._map.get(this._head)!.prev = abs;
    this._head = abs;
  }

  private _evict(abs: string): void {
    const entry = this._map.get(abs);
    if (!entry) return;

    if (entry.prev) this._map.get(entry.prev)!.next = entry.next;
    if (entry.next) this._map.get(entry.next)!.prev = entry.prev;
    if (this._head === abs) this._head = entry.next;
    if (this._tail === abs) this._tail = entry.prev;

    this._map.delete(abs);
    this._evictions++;
  }

  private _checkMemPressure(): void {
    const usedMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (usedMB > this._memPressureMB) {
      this.trim();
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _cache: AstCache | null = null;

export function getAstCache(opts?: AstCacheOptions): AstCache {
  if (!_cache) _cache = new AstCache(opts);
  return _cache;
}

// ─── Performance diagnostics command ─────────────────────────────────────────

export function registerCacheDiagnosticsCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('frontendAI.cacheStats', () => {
      const s = getAstCache().stats();
      vscode.window.showInformationMessage(
        `AST Cache — ${s.size}/${s.capacity} entries | ` +
        `hit rate ${s.hitRate} | ${s.hits} hits / ${s.misses} misses | ` +
        `${s.evictions} evictions | heap ${s.memoryUsedMB} MB`
      );
    })
  );
}

// ─── Optimised batch indexer helper ──────────────────────────────────────────

/**
 * Drop-in replacement for the plain runBatched loop inside ProjectIndexer.
 * Uses AstCache.parseMany for proper LRU + hash-skip behaviour.
 */
export async function batchParseWithCache(
  filePaths: string[],
  onEach:    (parsed: ParsedFile) => void,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const cache = getAstCache();

  await cache.parseMany(filePaths, onProgress);

  for (const fp of filePaths) {
    const result = cache.get(fp);
    if (result) onEach(result);
  }
}

// ─── Pure utilities ───────────────────────────────────────────────────────────

/** djb2 hash — fast, good distribution, zero dependencies. */
function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // Clamp to 32-bit integer to avoid float precision issues
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;   // unsigned
}

function emptyParsed(filePath: string): ParsedFile {
  return {
    filePath,
    parsedAt:  new Date().toISOString(),
    hasErrors: true,
    functions: [],
    classes:   [],
    variables: [],
    imports:   [],
    exports:   [],
  };
}
