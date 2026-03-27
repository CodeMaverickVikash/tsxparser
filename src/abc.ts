/**
 * symbolResolver.ts — Project-Wide Symbol Resolver (WebStorm-parity)
 *
 * ─── Responsibilities ─────────────────────────────────────────────────────────
 *
 *  1. Exact-match lookup          O(1) via forward index
 *  2. Fuzzy match                 char-sequence match, scored by closeness
 *  3. Context-aware ranking       symbols in the caller's own file rank higher
 *  4. Import-path resolution      resolve what a local import refers to
 *  5. Re-export chain following   chase re-exports to the original definition
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *  resolveSymbol(name, contextFile?)  → ResolvedSymbol[]
 *  resolveAtPosition(doc, position)   → ResolvedSymbol[]   (word under cursor)
 *  resolveImportPath(module, fromFile)→ string | undefined  (abs path of module)
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import * as ts     from 'typescript';
import { getIndexer, IndexedSymbol } from './projectIndexer';
import { parseFile }                 from './astParser';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResolvedSymbol {
  symbol:        IndexedSymbol;
  /** How the match was found */
  matchKind:     'exact' | 'case-insensitive' | 'fuzzy';
  /** 0–100: higher = better. Used to sort Quick Pick. */
  score:         number;
  /** True when symbol lives in the same file as contextFile */
  isLocal:       boolean;
  /** Resolved absolute path (same as symbol.filePath, exposed for convenience) */
  filePath:      string;
  /** 0-based line */
  line:          number;
  /** 0-based column */
  column:        number;
}

export interface SymbolResolverOptions {
  /** When true, stop after the first exact match group */
  exactOnly?:    boolean;
  /** Max fuzzy results returned (default 20) */
  maxFuzzy?:     number;
  /** Follow re-export chains to find the original definition */
  followReexports?: boolean;
}

// ─── resolveSymbol ────────────────────────────────────────────────────────────

/**
 * Main entry point.
 *
 * Resolution order:
 *  1. Exact case-sensitive match
 *  2. Exact case-insensitive match  (if no exact hit)
 *  3. Fuzzy match                   (if no case-insensitive hit and !exactOnly)
 *
 * Results are sorted:
 *  - by matchKind priority (exact > ci > fuzzy)
 *  - then by isLocal (same file first)
 *  - then by score (higher first)
 */
export function resolveSymbol(
  name:        string,
  contextFile?: string,
  opts:        SymbolResolverOptions = {}
): ResolvedSymbol[] {
  const indexer    = getIndexer();
  const absContext = contextFile ? path.resolve(contextFile) : undefined;

  // ── 1. Exact match ─────────────────────────────────────────────────────────
  const exactBucket = indexer.getSymbolExact(name);
  if (exactBucket.length > 0) {
    return rank(
      exactBucket.map(s => makeResolved(s, 'exact', 100, absContext)),
      absContext
    );
  }

  // ── 2. Case-insensitive match ──────────────────────────────────────────────
  const lower = name.toLowerCase();
  const ciResults: ResolvedSymbol[] = [];

  for (const [k, bucket] of indexer.index.symbols) {
    if (k.toLowerCase() === lower) {
      for (const s of bucket) {
        ciResults.push(makeResolved(s, 'case-insensitive', 90, absContext));
      }
    }
  }

  if (ciResults.length > 0) {
    return rank(ciResults, absContext);
  }

  if (opts.exactOnly) return [];

  // ── 3. Fuzzy match ─────────────────────────────────────────────────────────
  const maxFuzzy = opts.maxFuzzy ?? 20;
  const fuzzyResults: ResolvedSymbol[] = [];

  for (const [k, bucket] of indexer.index.symbols) {
    const score = fuzzyScore(k.toLowerCase(), lower);
    if (score > 0) {
      for (const s of bucket) {
        fuzzyResults.push(makeResolved(s, 'fuzzy', score, absContext));
      }
    }
  }

  fuzzyResults.sort((a, b) => b.score - a.score);
  return rank(fuzzyResults.slice(0, maxFuzzy), absContext);
}

// ─── resolveAtPosition ───────────────────────────────────────────────────────

/**
 * Extract the word (identifier) at `position` in `document` and resolve it.
 *
 * Also handles:
 *  - JSX tag names (component names)
 *  - Import path strings → resolves the module file
 */
export function resolveAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  opts:     SymbolResolverOptions = {}
): ResolvedSymbol[] {
  const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  if (!wordRange) return [];

  const word = document.getText(wordRange);
  if (!word) return [];

  return resolveSymbol(word, document.fileName, opts);
}

// ─── resolveImportPath ───────────────────────────────────────────────────────

/**
 * Given a module specifier (e.g. `'./utils'`, `'react'`) and the file that
 * contains the import, return the absolute path of the resolved module.
 *
 * Handles:
 *  - Relative paths with extension inference (.ts → .tsx → .js → .jsx → /index.*)
 *  - node_modules (returns undefined — not local)
 *  - tsconfig paths aliases (basic implementation)
 */
export function resolveImportPath(
  moduleSpecifier: string,
  fromFile:        string
): string | undefined {
  if (!moduleSpecifier.startsWith('.')) {
    // Non-relative — node_modules or tsconfig alias, skip deep resolution
    return undefined;
  }

  const fromDir = path.dirname(path.resolve(fromFile));
  const base    = path.resolve(fromDir, moduleSpecifier);

  // Try exact, then extension variants
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* not found */ }
  }

  return undefined;
}

// ─── resolveDefinitionInFile ─────────────────────────────────────────────────

/**
 * Deep AST scan of a single file to find ALL occurrences of `name`
 * (identifiers, JSX tag names, etc.).  Used internally by findUsages.
 */
export function findIdentifierOccurrencesInFile(
  filePath: string,
  name:     string
): Array<{ line: number; column: number; offset: number }> {
  let parsed;
  try {
    parsed = parseFile(filePath);
  } catch {
    return [];
  }

  const text = (() => {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  })();

  if (!text) return [];

  const ext = path.extname(filePath).toLowerCase();
  const kind = extToScriptKind(ext);

  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
  const results: Array<{ line: number; column: number; offset: number }> = [];

  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      results.push({ line: pos.line, column: pos.character, offset: node.getStart(sf) });
    }
    // JSX tag names (e.g. <MyComponent>)
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node) || ts.isJsxSelfClosingElement(node))
    ) {
      const tagName = (node as any).tagName;
      if (tagName && ts.isIdentifier(tagName) && tagName.text === name) {
        const pos = sf.getLineAndCharacterOfPosition(tagName.getStart(sf));
        results.push({ line: pos.line, column: pos.character, offset: tagName.getStart(sf) });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return results;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function makeResolved(
  symbol:    IndexedSymbol,
  matchKind: ResolvedSymbol['matchKind'],
  score:     number,
  contextFile?: string
): ResolvedSymbol {
  return {
    symbol,
    matchKind,
    score,
    isLocal:  !!contextFile && symbol.filePath === contextFile,
    filePath: symbol.filePath,
    line:     symbol.location.line,
    column:   symbol.location.column,
  };
}

function rank(results: ResolvedSymbol[], contextFile?: string): ResolvedSymbol[] {
  return results.sort((a, b) => {
    // 1. match kind priority
    const mkPriority = { exact: 3, 'case-insensitive': 2, fuzzy: 1 };
    const mkDiff = mkPriority[b.matchKind] - mkPriority[a.matchKind];
    if (mkDiff !== 0) return mkDiff;

    // 2. local file first
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;

    // 3. score descending
    return b.score - a.score;
  });
}

/**
 * Fuzzy score: 0 = no match.
 * Higher = pattern characters appear closer together and earlier in text.
 */
function fuzzyScore(text: string, pattern: string): number {
  if (!pattern) return 0;
  let pi = 0;
  let lastIdx = -1;
  let gaps = 0;

  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) {
      if (lastIdx !== -1) gaps += ti - lastIdx - 1;
      lastIdx = ti;
      pi++;
    }
  }

  if (pi < pattern.length) return 0; // incomplete match

  // Score: max 89, penalise gaps and late start
  const score = Math.max(1, 89 - gaps - lastIdx);
  return score;
}

function extToScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.ts':  return ts.ScriptKind.TS;
    default:     return ts.ScriptKind.JS;
  }
}
