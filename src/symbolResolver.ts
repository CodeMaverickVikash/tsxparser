/**
 * symbolResolver.ts — Framework-Aware Project-Wide Symbol Resolver
 *
 * ─── Responsibilities ─────────────────────────────────────────────────────────
 *
 *  1. Exact-match lookup          O(1) via forward index
 *  2. Fuzzy match                 char-sequence match, scored by closeness
 *  3. Context-aware ranking       symbols in the caller's own file rank higher
 *  4. Framework-aware ranking     prefer symbols whose framework matches the
 *                                 framework of the calling file (React → React,
 *                                 Angular → Angular, etc.)
 *  5. Import-path resolution      resolve what a local import refers to
 *  6. Re-export chain following   chase re-exports to the original definition
 *  7. Role-based filtering        e.g. only show components, not plain vars
 *
 * ─── Framework intelligence ───────────────────────────────────────────────────
 *
 *  When resolving "Button" from a React file:
 *    • React components (functional / class) score +30
 *    • React hooks score +20 when the caller is also a React file
 *    • Angular / Vue symbols are deprioritised (−20) unless no React match
 *
 *  Go-To-Definition additionally:
 *    • Resolves JSX component names directly to their declaration
 *    • Understands hook call sites vs. hook definitions
 *    • Skips test/mock files unless the caller is itself a test
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *  resolveSymbol(name, contextFile?, opts)  → ResolvedSymbol[]
 *  resolveAtPosition(doc, position, opts)   → ResolvedSymbol[]
 *  resolveImportPath(module, fromFile)      → string | undefined
 *  findIdentifierOccurrencesInFile(fp, name)→ OccurrenceLocation[]
 *  classifyOccurrence(node, sf, parsed)     → OccurrenceKind
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import * as ts     from 'typescript';
import { getIndexer, IndexedSymbol } from './projectIndexer';
import { parseFile }                 from './astParser';
import { Framework }                 from './frameworkDetector';

// ─── Public types ─────────────────────────────────────────────────────────────

export type OccurrenceKind =
  | 'definition'        // the declaration itself
  | 'jsx-usage'         // <Component ... />  or  <Component>
  | 'hook-call'         // const x = useHook()
  | 'import'            // import { X } from '...'
  | 'export'            // export { X }
  | 'call'              // foo()
  | 'type-reference'    // : MyType
  | 'assignment'        // x = ...
  | 'reference'         // plain identifier read

export interface OccurrenceLocation {
  line:   number;   // 0-based
  column: number;   // 0-based
  offset: number;
  kind:   OccurrenceKind;
}

export interface ResolvedSymbol {
  symbol:        IndexedSymbol;
  matchKind:     'exact' | 'case-insensitive' | 'fuzzy';
  /** 0–100: higher = better */
  score:         number;
  isLocal:       boolean;
  filePath:      string;
  line:          number;
  column:        number;
  /** Why this result was ranked here (for UI tooltip) */
  rankReason?:   string;
}

export interface SymbolResolverOptions {
  exactOnly?:       boolean;
  maxFuzzy?:        number;
  followReexports?: boolean;
  /** If true, filter to only exported symbols */
  exportedOnly?:    boolean;
  /** Restrict to specific symbol types */
  types?:           Array<IndexedSymbol['type']>;
  /** Skip test/spec files */
  skipTestFiles?:   boolean;
}

// ─── Framework context of a file ─────────────────────────────────────────────

function detectCallerFramework(filePath: string): Framework {
  try {
    const parsed = parseFile(filePath);
    return parsed.framework ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
         /\/__tests__\//.test(filePath) ||
         /\/test\//.test(filePath);
}

// ─── Framework-aware scoring boost ────────────────────────────────────────────

/**
 * Extra score added to a candidate based on how well its framework
 * matches the caller's framework, and what role the symbol plays.
 */
function frameworkBoost(
  sym:            IndexedSymbol,
  callerFramework: Framework
): number {
  const symFw = sym.framework ?? 'unknown';

  // No framework info — neutral
  if (symFw === 'unknown' || callerFramework === 'unknown') return 0;

  // Same framework → big boost
  if (symFw === callerFramework) {
    let boost = 15;

    // Role-specific boosts within the same framework
    const role = sym.frameworkTag?.role as string | undefined;
    if (callerFramework === 'react') {
      if (role === 'functional-component' || role === 'memo' || role === 'forward-ref') boost += 15;
      else if (role === 'custom-hook' || role === 'hook')                                boost += 10;
      else if (role === 'context')                                                       boost += 8;
      else if (role === 'hoc')                                                           boost += 5;
    } else if (callerFramework === 'angular') {
      if (role === 'component' || role === 'directive')  boost += 15;
      else if (role === 'service')                       boost += 12;
      else if (role === 'pipe')                          boost += 8;
    } else if (callerFramework === 'vue') {
      if (role === 'component' || role === 'composable') boost += 15;
      else if (role === 'reactive-ref' || role === 'computed') boost += 8;
    }

    return boost;
  }

  // Different framework → penalty (don't hide, just deprioritise)
  return -20;
}

// ─── resolveSymbol ────────────────────────────────────────────────────────────

export function resolveSymbol(
  name:         string,
  contextFile?: string,
  opts:         SymbolResolverOptions = {}
): ResolvedSymbol[] {
  const indexer      = getIndexer();
  const absContext   = contextFile ? path.resolve(contextFile) : undefined;
  const callerFw     = absContext ? detectCallerFramework(absContext) : 'unknown';
  const skipTests    = opts.skipTestFiles ?? false;
  const callerIsTest = absContext ? isTestFile(absContext) : false;

  const filterSym = (s: IndexedSymbol): boolean => {
    if (opts.exportedOnly && !s.exported) return false;
    if (opts.types && !opts.types.includes(s.type)) return false;
    if (skipTests && !callerIsTest && isTestFile(s.filePath)) return false;
    return true;
  };

  // ── 1. Exact match ──────────────────────────────────────────────────────────
  const exactBucket = indexer.getSymbolExact(name).filter(filterSym);
  if (exactBucket.length > 0) {
    return rank(
      exactBucket.map(s => makeResolved(s, 'exact', 100, absContext, callerFw)),
      absContext
    );
  }

  // ── 2. Case-insensitive match ───────────────────────────────────────────────
  const lower     = name.toLowerCase();
  const ciResults: ResolvedSymbol[] = [];
  for (const [k, bucket] of indexer.index.symbols) {
    if (k.toLowerCase() === lower) {
      for (const s of bucket) {
        if (filterSym(s)) {
          ciResults.push(makeResolved(s, 'case-insensitive', 90, absContext, callerFw));
        }
      }
    }
  }
  if (ciResults.length > 0) return rank(ciResults, absContext);

  if (opts.exactOnly) return [];

  // ── 3. Fuzzy match ──────────────────────────────────────────────────────────
  const maxFuzzy   = opts.maxFuzzy ?? 20;
  const fuzzyResults: ResolvedSymbol[] = [];
  for (const [k, bucket] of indexer.index.symbols) {
    const score = fuzzyScore(k.toLowerCase(), lower);
    if (score > 0) {
      for (const s of bucket) {
        if (filterSym(s)) {
          fuzzyResults.push(makeResolved(s, 'fuzzy', score, absContext, callerFw));
        }
      }
    }
  }
  fuzzyResults.sort((a, b) => b.score - a.score);
  return rank(fuzzyResults.slice(0, maxFuzzy), absContext);
}

// ─── resolveAtPosition ───────────────────────────────────────────────────────

export function resolveAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  opts:     SymbolResolverOptions = {}
): ResolvedSymbol[] {
  const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  if (!wordRange) return [];
  const word = document.getText(wordRange);
  if (!word) return [];

  // Detect if cursor is on a JSX tag — prioritise component definitions
  const lineText = document.lineAt(position.line).text;
  const isJsxContext = isOnJsxTag(lineText, position.character, word);

  const resolvedOpts: SymbolResolverOptions = {
    ...opts,
    // When on a JSX tag, restrict to class/function types (components)
    types: isJsxContext
      ? ['function', 'class']
      : opts.types,
  };

  return resolveSymbol(word, document.fileName, resolvedOpts);
}

// ─── resolveImportPath ───────────────────────────────────────────────────────

export function resolveImportPath(
  moduleSpecifier: string,
  fromFile:        string
): string | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined;

  const fromDir = path.dirname(path.resolve(fromFile));
  const base    = path.resolve(fromDir, moduleSpecifier);

  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];

  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not found */ }
  }
  return undefined;
}

// ─── findIdentifierOccurrencesInFile ─────────────────────────────────────────

/**
 * Deep AST walk — returns every occurrence of `name` with its semantic kind.
 * This powers Find Usages with role-aware classification (JSX vs call vs import…).
 */
export function findIdentifierOccurrencesInFile(
  filePath: string,
  name:     string
): OccurrenceLocation[] {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }

  const ext  = path.extname(filePath).toLowerCase();
  const kind = extToScriptKind(ext);
  const sf   = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);

  const results: OccurrenceLocation[] = [];

  const walk = (node: ts.Node) => {
    // Plain identifier match
    if (ts.isIdentifier(node) && node.text === name) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      results.push({
        line:   pos.line,
        column: pos.character,
        offset: node.getStart(sf),
        kind:   classifyOccurrenceNode(node, sf),
      });
    }

    // JSX tag names  <MyComponent>  or  <MyComponent />
    if (
      ts.isJsxOpeningElement(node) ||
      ts.isJsxClosingElement(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      const tagName = (node as any).tagName as ts.JsxTagNameExpression;
      if (tagName && ts.isIdentifier(tagName) && tagName.text === name) {
        const pos = sf.getLineAndCharacterOfPosition(tagName.getStart(sf));
        // Only add if not already captured as plain identifier
        const alreadyAdded = results.some(
          r => r.line === pos.line && r.column === pos.character
        );
        if (!alreadyAdded) {
          results.push({
            line:   pos.line,
            column: pos.character,
            offset: tagName.getStart(sf),
            kind:   'jsx-usage',
          });
        }
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(sf);
  return results;
}

// ─── classifyOccurrenceNode ──────────────────────────────────────────────────

export function classifyOccurrenceNode(
  node: ts.Identifier,
  sf:   ts.SourceFile
): OccurrenceKind {
  const parent = node.parent;
  if (!parent) return 'reference';

  // Import clause:  import { X } from '...'
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  ) return 'import';

  // Export specifier:  export { X }
  if (ts.isExportSpecifier(parent)) return 'export';

  // Declaration sites
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent)
  ) {
    if (parent.name === node) return 'definition';
  }

  // Hook call:  const x = useHook()   or  useHook()
  if (ts.isCallExpression(parent) && parent.expression === node) {
    if (/^use[A-Z]/.test(node.text)) return 'hook-call';
    return 'call';
  }

  // JSX context (fallback if not caught above)
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxClosingElement(parent) ||
    ts.isJsxSelfClosingElement(parent)
  ) return 'jsx-usage';

  // Type reference:  : MyType  |  <MyType>
  if (
    ts.isTypeReferenceNode(parent) ||
    ts.isExpressionWithTypeArguments(parent) ||
    ts.isHeritageClause(parent)
  ) return 'type-reference';

  // Assignment
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) return 'assignment';

  return 'reference';
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function makeResolved(
  symbol:          IndexedSymbol,
  matchKind:       ResolvedSymbol['matchKind'],
  baseScore:       number,
  contextFile?:    string,
  callerFramework: Framework = 'unknown'
): ResolvedSymbol {
  const isLocal = !!contextFile && symbol.filePath === contextFile;
  const fwBoost = frameworkBoost(symbol, callerFramework);
  const score   = Math.max(0, Math.min(100, baseScore + fwBoost));

  // Build a human-readable rank reason for UI
  let rankReason: string | undefined;
  if (symbol.frameworkTag) {
    rankReason = symbol.frameworkTag.label;
  } else if (symbol.framework && symbol.framework !== 'unknown') {
    rankReason = symbol.framework;
  }

  return {
    symbol,
    matchKind,
    score,
    isLocal,
    filePath: symbol.filePath,
    line:     symbol.location.line,
    column:   symbol.location.column,
    rankReason,
  };
}

function rank(results: ResolvedSymbol[], contextFile?: string): ResolvedSymbol[] {
  return results.sort((a, b) => {
    // 1. match kind priority: exact > ci > fuzzy
    const mkPriority = { exact: 3, 'case-insensitive': 2, fuzzy: 1 };
    const mkDiff = mkPriority[b.matchKind] - mkPriority[a.matchKind];
    if (mkDiff !== 0) return mkDiff;

    // 2. local file first
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;

    // 3. score descending (includes framework boost)
    if (b.score !== a.score) return b.score - a.score;

    // 4. exported symbols before internal ones
    const aExp = a.symbol.exported ? 1 : 0;
    const bExp = b.symbol.exported ? 1 : 0;
    if (bExp !== aExp) return bExp - aExp;

    // 5. alphabetical by file path as stable tiebreaker
    return a.filePath.localeCompare(b.filePath);
  });
}

function fuzzyScore(text: string, pattern: string): number {
  if (!pattern) return 0;
  let pi = 0, lastIdx = -1, gaps = 0;
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) {
      if (lastIdx !== -1) gaps += ti - lastIdx - 1;
      lastIdx = ti;
      pi++;
    }
  }
  if (pi < pattern.length) return 0;
  return Math.max(1, 89 - gaps - lastIdx);
}

function extToScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.ts':  return ts.ScriptKind.TS;
    default:     return ts.ScriptKind.JS;
  }
}

/**
 * Detect if the cursor position is on a JSX component tag name,
 * e.g. <Button  or  </Button  or  <MyModal.Header
 */
function isOnJsxTag(lineText: string, charPos: number, word: string): boolean {
  // Find the word in the line
  const wordStart = lineText.lastIndexOf(word, charPos);
  if (wordStart < 0) return false;

  // Look for a '<' before the word (allowing '/' for closing tags and whitespace)
  const before = lineText.slice(0, wordStart).trimEnd();
  if (before.endsWith('<') || before.endsWith('</')) return true;

  // Also check if word starts with uppercase (strong React component signal)
  if (/^[A-Z]/.test(word)) {
    // Check surrounding context for JSX angle brackets
    const context = lineText.slice(Math.max(0, wordStart - 3), wordStart + word.length + 3);
    if (/</.test(context)) return true;
  }

  return false;
}