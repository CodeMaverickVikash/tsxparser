/**
 * astParser.ts — Core AST Parser Engine for the TSX/WebStorm-parity VS Code extension.
 *
 * Features
 * ─────────
 *  • TypeScript Compiler API — full fidelity parse (no regex hacks)
 *  • Supports .ts / .tsx / .js / .jsx
 *  • Extracts: functions, classes (with methods + properties),
 *              variables, imports (default + named + namespace),
 *              exports (named, default, re-exports)
 *  • File-level cache keyed on (path, mtime, size) — zero re-parse on unchanged files
 *  • Optional VS Code TextDocument fast-path (no disk I/O during editing)
 *  • Graceful handling of syntax errors — partial results still returned
 *
 * Usage
 * ─────
 *  import { parseFile, parseDocument, invalidateCache } from './astParser';
 *
 *  const result = parseFile('/abs/path/to/Component.tsx');
 *  const result = parseDocument(vscodeTextDocument);   // editor fast-path
 */

import * as ts   from 'typescript';
import * as fs   from 'fs';
import * as path from 'path';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Location {
  /** 0-based line */
  line:      number;
  /** 0-based character */
  character: number;
  /** absolute character offset in source text */
  offset:    number;
}

export interface Span {
  start: Location;
  end:   Location;
}

export interface ParsedParam {
  name:         string;
  type?:        string;
  optional:     boolean;
  defaultValue?: string;
  rest:         boolean;
}

export interface ParsedFunction {
  name:        string;
  kind:        'function' | 'arrow' | 'expression' | 'method';
  /** True when declared inside a class or object */
  isMethod:    boolean;
  params:      ParsedParam[];
  returnType?: string;
  async:       boolean;
  generator:   boolean;
  exported:    boolean;
  span:        Span;
}

export interface ParsedProperty {
  name:      string;
  type?:     string;
  static:    boolean;
  readonly:  boolean;
  optional:  boolean;
  span:      Span;
}

export interface ParsedClass {
  name:        string;
  superClass?: string;
  implements:  string[];
  methods:     ParsedFunction[];
  properties:  ParsedProperty[];
  exported:    boolean;
  span:        Span;
}

export interface ParsedVariable {
  name:          string;
  kind:          'const' | 'let' | 'var';
  type?:         string;
  /** Arrow / function → treated as function, hook call, etc. */
  initKind?:     'arrow' | 'function' | 'hook' | 'call' | 'literal' | 'other';
  hookName?:     string;
  exported:      boolean;
  span:          Span;
}

export interface NamedImport {
  name:      string;   // original name in module
  alias?:    string;   // local alias after 'as'
}

export interface ParsedImport {
  module:          string;
  defaultImport?:  string;
  namespaceImport?: string;
  named:           NamedImport[];
  typeOnly:        boolean;
  span:            Span;
}

export interface ParsedExport {
  /** 'named' | 'default' | 're-export' */
  kind:        'named' | 'default' | 'reexport';
  name?:       string;
  alias?:      string;
  fromModule?: string;
  typeOnly:    boolean;
  span:        Span;
}

export interface ParsedFile {
  filePath:   string;
  /** ISO timestamp of when this parse result was created */
  parsedAt:   string;
  hasErrors:  boolean;
  functions:  ParsedFunction[];
  classes:    ParsedClass[];
  variables:  ParsedVariable[];
  imports:    ParsedImport[];
  exports:    ParsedExport[];
}

// ─── Internal cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  /** mtime in ms at parse time */
  mtime:  number;
  size:   number;
  result: ParsedFile;
}

const cache = new Map<string, CacheEntry>();

/** Drop a single file from cache (call after in-editor save, or file deletion). */
export function invalidateCache(filePath: string): void {
  cache.delete(path.resolve(filePath));
}

/** Drop all cached entries. */
export function clearCache(): void {
  cache.clear();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a file on disk.
 * Returns a cached result when the file has not changed since last parse.
 */
export function parseFile(filePath: string): ParsedFile {
  const abs = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return emptyResult(abs, true);
  }

  const mtime = stat.mtimeMs;
  const size  = stat.size;

  const cached = cache.get(abs);
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached.result;
  }

  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return emptyResult(abs, true);
  }

  const result = parseText(abs, text);
  cache.set(abs, { mtime, size, result });
  return result;
}

/**
 * Parse directly from a VS Code TextDocument (no disk I/O).
 * Uses a lightweight content-hash check to avoid re-parsing while the
 * user is merely moving the cursor.
 */
export function parseDocument(doc: {
  fileName:   string;
  getText():  string;
  version:    number;
}): ParsedFile {
  const abs    = path.resolve(doc.fileName);
  const cached = cache.get(abs);

  // VS Code increments doc.version on every edit — use it as the change key
  if (cached && (cached as any).docVersion === doc.version) {
    return cached.result;
  }

  const text   = doc.getText();
  const result = parseText(abs, text);

  // Store with a special docVersion tag so disk-based checks still work
  const entry: CacheEntry & { docVersion: number } = {
    mtime: 0, size: 0, result, docVersion: doc.version
  };
  cache.set(abs, entry);
  return result;
}

// ─── Core parser ─────────────────────────────────────────────────────────────

function parseText(filePath: string, text: string): ParsedFile {
  const ext  = path.extname(filePath).toLowerCase();
  const kind = scriptKind(ext);

  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind
  );

  const ctx: ParseContext = { sf, text };

  const result: ParsedFile = {
    filePath,
    parsedAt:  new Date().toISOString(),
    hasErrors: sf.parseDiagnostics?.length > 0,
    functions: [],
    classes:   [],
    variables: [],
    imports:   [],
    exports:   [],
  };

  // Walk top-level statements
  ts.forEachChild(sf, node => visitTopLevel(node, ctx, result));

  return result;
}

// ─── Top-level visitor ────────────────────────────────────────────────────────

interface ParseContext {
  sf:   ts.SourceFile;
  text: string;
}

function visitTopLevel(
  node:   ts.Node,
  ctx:    ParseContext,
  out:    ParsedFile
): void {

  // ── Import declarations ────────────────────────────────────────────────────
  if (ts.isImportDeclaration(node)) {
    const imp = extractImport(node, ctx);
    if (imp) out.imports.push(imp);
    return;
  }

  // ── Export declarations ────────────────────────────────────────────────────
  if (ts.isExportDeclaration(node)) {
    out.exports.push(...extractExportDeclaration(node, ctx));
    return;
  }
  if (ts.isExportAssignment(node)) {
    out.exports.push(extractExportAssignment(node, ctx));
    return;
  }

  // ── Function declaration ───────────────────────────────────────────────────
  if (ts.isFunctionDeclaration(node)) {
    const fn = extractFunctionDeclaration(node, ctx, isExported(node));
    if (fn) out.functions.push(fn);
    return;
  }

  // ── Class declaration ──────────────────────────────────────────────────────
  if (ts.isClassDeclaration(node)) {
    const cls = extractClass(node, ctx, isExported(node));
    if (cls) out.classes.push(cls);
    return;
  }

  // ── Variable statement  (const / let / var) ───────────────────────────────
  if (ts.isVariableStatement(node)) {
    const exported = isExported(node);
    const decls    = node.declarationList.declarations;
    const kind     = varKind(node.declarationList);

    for (const decl of decls) {
      const vars = extractVariableDeclaration(decl, kind, exported, ctx);
      for (const v of vars) {
        // If a variable is an arrow/function expression, also register it as a function
        if (v.initKind === 'arrow' || v.initKind === 'function') {
          const fn = extractFunctionFromVarDecl(decl, exported, ctx);
          if (fn) out.functions.push(fn);
        }
        out.variables.push(v);
      }
    }
    return;
  }

  // ── Interface / TypeAlias — treated as variables for symbol listing ─────────
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    const name = (node as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text;
    out.variables.push({
      name,
      kind:     'const',
      type:     ts.isInterfaceDeclaration(node) ? 'interface' : 'type',
      initKind: 'other',
      exported: isExported(node),
      span:     spanOf(node, ctx.sf),
    });
    return;
  }
}

// ─── Import extractor ─────────────────────────────────────────────────────────

function extractImport(
  node: ts.ImportDeclaration,
  ctx:  ParseContext
): ParsedImport | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null;

  const mod: string = node.moduleSpecifier.text;
  const clause      = node.importClause;
  const typeOnly    = node.importClause?.isTypeOnly ?? false;

  const result: ParsedImport = {
    module: mod,
    named:  [],
    typeOnly,
    span:   spanOf(node, ctx.sf),
  };

  if (!clause) return result;                        // import 'side-effect';

  if (clause.name) {
    result.defaultImport = clause.name.text;         // import Foo from '...'
  }

  if (clause.namedBindings) {
    const nb = clause.namedBindings;

    if (ts.isNamespaceImport(nb)) {
      result.namespaceImport = nb.name.text;         // import * as Foo from '...'
    } else if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {               // import { A, B as C } from '...'
        result.named.push({
          name:  el.propertyName?.text ?? el.name.text,
          alias: el.propertyName ? el.name.text : undefined,
        });
      }
    }
  }

  return result;
}

// ─── Export extractors ────────────────────────────────────────────────────────

function extractExportDeclaration(
  node: ts.ExportDeclaration,
  ctx:  ParseContext
): ParsedExport[] {
  const fromModule = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
  const typeOnly = node.isTypeOnly;

  // export * from '...'   or  export * as ns from '...'
  if (!node.exportClause) {
    return [{
      kind:       'reexport',
      fromModule,
      typeOnly,
      span:       spanOf(node, ctx.sf),
    }];
  }

  // export { A, B as C }  or  export { A, B as C } from '...'
  if (ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.map(el => ({
      kind:       fromModule ? 'reexport' : 'named',
      name:       el.propertyName?.text ?? el.name.text,
      alias:      el.propertyName ? el.name.text : undefined,
      fromModule,
      typeOnly,
      span:       spanOf(el, ctx.sf),
    } as ParsedExport));
  }

  // export * as ns from '...'
  if (ts.isNamespaceExport(node.exportClause)) {
    return [{
      kind:       'reexport',
      alias:      node.exportClause.name.text,
      fromModule,
      typeOnly,
      span:       spanOf(node, ctx.sf),
    }];
  }

  return [];
}

function extractExportAssignment(
  node: ts.ExportAssignment,
  ctx:  ParseContext
): ParsedExport {
  // export default Foo  |  module.exports = Foo
  const isEqualSyntax = node.isExportEquals;
  let name: string | undefined;

  if (ts.isIdentifier(node.expression)) {
    name = node.expression.text;
  }

  return {
    kind:     isEqualSyntax ? 'named' : 'default',
    name,
    typeOnly: false,
    span:     spanOf(node, ctx.sf),
  };
}

// ─── Function extractors ──────────────────────────────────────────────────────

function extractFunctionDeclaration(
  node:     ts.FunctionDeclaration,
  ctx:      ParseContext,
  exported: boolean
): ParsedFunction | null {
  return {
    name:       node.name?.text ?? '(anonymous)',
    kind:       'function',
    isMethod:   false,
    params:     extractParams(node.parameters, ctx),
    returnType: node.type ? node.type.getText(ctx.sf) : undefined,
    async:      hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator:  !!node.asteriskToken,
    exported,
    span:       spanOf(node, ctx.sf),
  };
}

function extractFunctionFromVarDecl(
  decl:     ts.VariableDeclaration,
  exported: boolean,
  ctx:      ParseContext
): ParsedFunction | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  const init = decl.initializer;
  if (!init) return null;

  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return {
      name,
      kind:       ts.isArrowFunction(init) ? 'arrow' : 'expression',
      isMethod:   false,
      params:     extractParams(init.parameters, ctx),
      returnType: init.type ? init.type.getText(ctx.sf) : undefined,
      async:      hasModifier(init, ts.SyntaxKind.AsyncKeyword),
      generator:  ts.isFunctionExpression(init) ? !!init.asteriskToken : false,
      exported,
      span:       spanOf(decl, ctx.sf),
    };
  }

  return null;
}

function extractMethodDeclaration(
  node: ts.MethodDeclaration,
  ctx:  ParseContext
): ParsedFunction {
  return {
    name:       node.name.getText(ctx.sf),
    kind:       'method',
    isMethod:   true,
    params:     extractParams(node.parameters, ctx),
    returnType: node.type ? node.type.getText(ctx.sf) : undefined,
    async:      hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator:  !!node.asteriskToken,
    exported:   false,
    span:       spanOf(node, ctx.sf),
  };
}

// ─── Class extractor ──────────────────────────────────────────────────────────

function extractClass(
  node:     ts.ClassDeclaration,
  ctx:      ParseContext,
  exported: boolean
): ParsedClass | null {
  const methods:     ParsedFunction[] = [];
  const properties:  ParsedProperty[] = [];

  for (const member of node.members) {

    if (ts.isMethodDeclaration(member)) {
      methods.push(extractMethodDeclaration(member, ctx));
      continue;
    }

    if (ts.isConstructorDeclaration(member)) {
      methods.push({
        name:     'constructor',
        kind:     'method',
        isMethod: true,
        params:   extractParams(member.parameters, ctx),
        async:    false,
        generator:false,
        exported: false,
        span:     spanOf(member, ctx.sf),
      });
      continue;
    }

    if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
      const prefix = ts.isGetAccessor(member) ? 'get ' : 'set ';
      methods.push({
        name:       prefix + member.name.getText(ctx.sf),
        kind:       'method',
        isMethod:   true,
        params:     extractParams(member.parameters, ctx),
        returnType: ts.isGetAccessor(member) && member.type
          ? member.type.getText(ctx.sf)
          : undefined,
        async:    false,
        generator:false,
        exported: false,
        span:     spanOf(member, ctx.sf),
      });
      continue;
    }

    if (ts.isPropertyDeclaration(member)) {
      const propName = member.name.getText(ctx.sf);
      properties.push({
        name:     propName,
        type:     member.type ? member.type.getText(ctx.sf) : undefined,
        static:   hasModifier(member, ts.SyntaxKind.StaticKeyword),
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        optional: !!member.questionToken,
        span:     spanOf(member, ctx.sf),
      });
      continue;
    }
  }

  // Heritage: extends / implements
  let superClass: string | undefined;
  const implementsNames: string[] = [];

  if (node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        superClass = clause.types[0]?.expression.getText(ctx.sf);
      }
      if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
        for (const t of clause.types) {
          implementsNames.push(t.expression.getText(ctx.sf));
        }
      }
    }
  }

  return {
    name:       node.name?.text ?? '(class)',
    superClass,
    implements: implementsNames,
    methods,
    properties,
    exported,
    span:       spanOf(node, ctx.sf),
  };
}

// ─── Variable extractor ───────────────────────────────────────────────────────

function extractVariableDeclaration(
  decl:     ts.VariableDeclaration,
  kind:     'const' | 'let' | 'var',
  exported: boolean,
  ctx:      ParseContext
): ParsedVariable[] {

  // Destructured: const { a, b } = ...  or  const [a, b] = ...
  if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    return extractBindingPattern(decl, kind, exported, ctx);
  }

  if (!ts.isIdentifier(decl.name)) return [];

  const name     = decl.name.text;
  const init     = decl.initializer;
  const typText  = decl.type ? decl.type.getText(ctx.sf) : undefined;

  let initKind: ParsedVariable['initKind'] = 'other';
  let hookName: string | undefined;

  if (init) {
    if      (ts.isArrowFunction(init))      initKind = 'arrow';
    else if (ts.isFunctionExpression(init)) initKind = 'function';
    else if (ts.isCallExpression(init)) {
      const callee = init.expression.getText(ctx.sf);
      if (/^use[A-Z]/.test(callee) || callee === 'React.useState') {
        initKind = 'hook';
        hookName = callee;
      } else {
        initKind = 'call';
      }
    }
    else if (
      ts.isStringLiteral(init)  ||
      ts.isNumericLiteral(init) ||
      ts.isBooleanLiteral(init)
    ) {
      initKind = 'literal';
    }
  }

  return [{
    name,
    kind,
    type:     typText,
    initKind,
    hookName,
    exported,
    span:     spanOf(decl, ctx.sf),
  }];
}

function extractBindingPattern(
  decl:     ts.VariableDeclaration,
  kind:     'const' | 'let' | 'var',
  exported: boolean,
  ctx:      ParseContext
): ParsedVariable[] {

  const results: ParsedVariable[] = [];

  const collect = (bp: ts.BindingPattern) => {
    for (const el of bp.elements) {
      if (ts.isOmittedExpression(el)) continue;

      const name = ts.isBindingElement(el)
        ? (ts.isIdentifier(el.name) ? el.name.text : null)
        : null;

      if (!name) {
        // Nested pattern — recurse
        if (ts.isBindingElement(el) && ts.isBindingPattern(el.name)) {
          collect(el.name);
        }
        continue;
      }

      results.push({
        name,
        kind,
        initKind: 'other',
        exported,
        span:     spanOf(el, ctx.sf),
      });
    }
  };

  if (ts.isBindingPattern(decl.name)) collect(decl.name);
  return results;
}

// ─── Param extractor ─────────────────────────────────────────────────────────

function extractParams(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  ctx:    ParseContext
): ParsedParam[] {
  return params.map(p => {
    let name = '?';
    if (ts.isIdentifier(p.name))            name = p.name.text;
    else if (ts.isObjectBindingPattern(p.name)) name = '{…}';
    else if (ts.isArrayBindingPattern(p.name))  name = '[…]';

    return {
      name,
      type:         p.type ? p.type.getText(ctx.sf) : undefined,
      optional:     !!p.questionToken || !!p.initializer,
      defaultValue: p.initializer ? p.initializer.getText(ctx.sf) : undefined,
      rest:         !!p.dotDotDotToken,
    };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function spanOf(node: ts.Node, sf: ts.SourceFile): Span {
  const startOffset = node.getStart(sf);
  const endOffset   = node.getEnd();
  const startPos    = sf.getLineAndCharacterOfPosition(startOffset);
  const endPos      = sf.getLineAndCharacterOfPosition(endOffset);
  return {
    start: { line: startPos.line, character: startPos.character, offset: startOffset },
    end:   { line: endPos.line,   character: endPos.character,   offset: endOffset   },
  };
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some(m => m.kind === kind)
    : false;
}

function varKind(list: ts.VariableDeclarationList): 'const' | 'let' | 'var' {
  if (list.flags & ts.NodeFlags.Const)  return 'const';
  if (list.flags & ts.NodeFlags.Let)    return 'let';
  return 'var';
}

function scriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.ts':  return ts.ScriptKind.TS;
    default:     return ts.ScriptKind.JS;
  }
}

function emptyResult(filePath: string, hasErrors: boolean): ParsedFile {
  return {
    filePath,
    parsedAt:  new Date().toISOString(),
    hasErrors,
    functions: [],
    classes:   [],
    variables: [],
    imports:   [],
    exports:   [],
  };
}