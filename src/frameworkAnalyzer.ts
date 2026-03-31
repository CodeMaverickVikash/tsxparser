/**
 * frameworkAnalyzer.ts — Framework-Aware Usage Classification Engine
 *
 * Understands usage context within React, Angular, and Vue frameworks:
 *
 *  React:
 *   - JSX rendering (<Component />)
 *   - Hook call (useMyHook())
 *   - Prop passing (<Foo bar={MyComponent} />)
 *   - Context consumer (useContext(MyContext))
 *   - forwardRef / memo wrapping
 *   - Import-only (imported but not directly rendered)
 *
 *  Angular:
 *   - Decorator usage (@Injectable, @Component, etc.)
 *   - Constructor DI
 *   - Template binding
 *
 *  Generic:
 *   - Function call
 *   - Type annotation
 *   - Re-export
 *   - Assignment / variable init
 */

import * as ts   from 'typescript';
import * as fs   from 'fs';
import * as path from 'path';

// ─── Public types ─────────────────────────────────────────────────────────────

export type UsageKind =
  // React-specific
  | 'jsx-render'           // <MyComp /> or <MyComp>...</MyComp>
  | 'jsx-prop'             // <Foo bar={MyComp} />
  | 'hook-call'            // const x = useMyHook()
  | 'hook-dep'             // useEffect(() => {}, [myDep])
  | 'context-consumer'     // useContext(MyCtx)
  | 'context-provider'     // <MyCtx.Provider value={...}>
  | 'hoc-wrap'             // memo(MyComp), forwardRef(MyComp)
  | 'lazy-import'          // React.lazy(() => import('./MyComp'))
  // Angular-specific
  | 'di-injection'         // constructor(private svc: MyService)
  | 'decorator-ref'        // @Component({...}), providers: [MyService]
  | 'ng-template'          // used in template html string
  // General
  | 'function-call'        // myFn()
  | 'type-annotation'      // : MyType, as MyType
  | 're-export'            // export { MyComp } from './...'
  | 'import-only'          // imported but usage not in this file beyond import
  | 'assignment'           // const x = MyVal
  | 'class-extends'        // class Foo extends MyClass
  | 'interface-implements' // class Foo implements MyInterface
  | 'generic-usage';       // anything else

export interface FrameworkUsage {
  filePath:    string;
  line:        number;        // 0-based
  column:      number;        // 0-based
  offset:      number;
  kind:        UsageKind;
  /** Human-readable label for the kind */
  kindLabel:   string;
  /** Source line preview (trimmed) */
  lineText:    string;
  /** Extra context: parent component name, prop name, etc. */
  context?:    string;
  /** Detected framework for this file */
  framework:   'react' | 'angular' | 'vue' | 'generic';
}

export interface UsageSummary {
  symbolName:   string;
  totalCount:   number;
  byKind:       Map<UsageKind, FrameworkUsage[]>;
  byFile:       Map<string, FrameworkUsage[]>;
  framework:    'react' | 'angular' | 'vue' | 'generic' | 'mixed';
}

// ─── Kind labels ──────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<UsageKind, string> = {
  'jsx-render':            'JSX Render',
  'jsx-prop':              'JSX Prop',
  'hook-call':             'Hook Call',
  'hook-dep':              'Hook Dependency',
  'context-consumer':      'Context Consumer',
  'context-provider':      'Context Provider',
  'hoc-wrap':              'HOC Wrapper',
  'lazy-import':           'Lazy Import',
  'di-injection':          'DI Injection',
  'decorator-ref':         'Decorator Reference',
  'ng-template':           'Template Reference',
  'function-call':         'Function Call',
  'type-annotation':       'Type Annotation',
  're-export':             'Re-export',
  'import-only':           'Import Only',
  'assignment':            'Assignment',
  'class-extends':         'Class Extension',
  'interface-implements':  'Interface Implementation',
  'generic-usage':         'Usage',
};

export const KIND_ICONS: Record<UsageKind, string> = {
  'jsx-render':            '⚛',
  'jsx-prop':              '🔧',
  'hook-call':             '🪝',
  'hook-dep':              '🔗',
  'context-consumer':      '📡',
  'context-provider':      '📢',
  'hoc-wrap':              '🎁',
  'lazy-import':           '⏳',
  'di-injection':          '💉',
  'decorator-ref':         '🎯',
  'ng-template':           '📋',
  'function-call':         '📞',
  'type-annotation':       '🏷',
  're-export':             '📤',
  'import-only':           '📥',
  'assignment':            '📌',
  'class-extends':         '🧬',
  'interface-implements':  '📐',
  'generic-usage':         '●',
};

// ─── Framework detector ───────────────────────────────────────────────────────

export function detectFramework(
  filePath: string,
  text: string
): 'react' | 'angular' | 'vue' | 'generic' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vue') return 'vue';
  if (text.includes('@angular/core') || text.includes('@Component') || text.includes('@Injectable')) {
    return 'angular';
  }
  if (
    text.includes('from \'react\'') ||
    text.includes('from "react"') ||
    text.includes('React.') ||
    /\.tsx?$/.test(filePath) && (text.includes('JSX') || text.includes('jsx') || /<[A-Z]/.test(text))
  ) {
    return 'react';
  }
  return 'generic';
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export function classifyUsagesInFile(
  filePath: string,
  symbolName: string
): FrameworkUsage[] {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }

  const ext = path.extname(filePath).toLowerCase();
  const scriptKind = getScriptKind(ext);
  const framework = detectFramework(filePath, text);

  const sf = ts.createSourceFile(
    filePath, text,
    ts.ScriptTarget.Latest, true, scriptKind
  );

  const lines = text.split('\n');
  const results: FrameworkUsage[] = [];

  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === symbolName) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const usage = classifyNode(node, sf, framework, symbolName, lines, pos, filePath);
      if (usage) results.push(usage);
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return results;
}

// ─── Node classifier ─────────────────────────────────────────────────────────

function classifyNode(
  node:       ts.Identifier,
  sf:         ts.SourceFile,
  framework:  'react' | 'angular' | 'vue' | 'generic',
  symbolName: string,
  lines:      string[],
  pos:        { line: number; character: number },
  filePath:   string
): FrameworkUsage | null {
  const parent  = node.parent;
  const gp      = parent?.parent;
  const lineText = (lines[pos.line] ?? '').trim();
  const offset   = node.getStart(sf);

  const base = {
    filePath,
    line:     pos.line,
    column:   pos.character,
    offset,
    lineText,
    framework,
  };

  // Skip import declarations — we handle those separately
  if (ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      (ts.isImportDeclaration(parent))) {
    return null; // handled at import-collection phase
  }

  // ── Re-export ──────────────────────────────────────────────────────────────
  if (ts.isExportSpecifier(parent)) {
    return { ...base, kind: 're-export', kindLabel: KIND_LABELS['re-export'], context: 're-export' };
  }

  // ── Type annotation: `: MyType` or `as MyType` ────────────────────────────
  if (
    ts.isTypeReferenceNode(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isHeritageClause(gp ?? parent)
  ) {
    // Class extends / implements
    if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(gp)) {
      const hc = gp as ts.HeritageClause;
      if (hc.token === ts.SyntaxKind.ExtendsKeyword) {
        return { ...base, kind: 'class-extends', kindLabel: KIND_LABELS['class-extends'] };
      }
      if (hc.token === ts.SyntaxKind.ImplementsKeyword) {
        return { ...base, kind: 'interface-implements', kindLabel: KIND_LABELS['interface-implements'] };
      }
    }
    return { ...base, kind: 'type-annotation', kindLabel: KIND_LABELS['type-annotation'] };
  }

  // ── REACT-specific ─────────────────────────────────────────────────────────
  if (framework === 'react') {

    // JSX tag name: <MyComp /> or <MyComp>
    if (
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)
    ) {
      const tagNode = parent as ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement;
      if ((tagNode as any).tagName === node) {
        // Check if it's a Context.Provider
        if (symbolName.includes('Provider') || lineText.includes('.Provider')) {
          return { ...base, kind: 'context-provider', kindLabel: KIND_LABELS['context-provider'] };
        }
        const parentComp = findEnclosingComponentName(node, sf);
        return {
          ...base,
          kind:      'jsx-render',
          kindLabel: KIND_LABELS['jsx-render'],
          context:   parentComp ? `inside <${parentComp}>` : undefined,
        };
      }
    }

    // JSX attribute value: <Foo bar={MyComp} />
    if (
      ts.isJsxExpression(parent) &&
      ts.isJsxAttribute(gp ?? parent)
    ) {
      const attrName = (gp as ts.JsxAttribute)?.name?.getText(sf);
      return {
        ...base,
        kind:      'jsx-prop',
        kindLabel: KIND_LABELS['jsx-prop'],
        context:   attrName ? `prop "${attrName}"` : undefined,
      };
    }

    // Hook call: const x = useMyHook()
    if (symbolName.startsWith('use') && ts.isCallExpression(parent) && (parent as ts.CallExpression).expression === node) {
      // Check if it's a hook dep array
      const callParent = parent.parent;
      if (ts.isArrayLiteralExpression(callParent)) {
        return { ...base, kind: 'hook-dep', kindLabel: KIND_LABELS['hook-dep'] };
      }
      // useContext special case
      if (symbolName === 'useContext') {
        return { ...base, kind: 'context-consumer', kindLabel: KIND_LABELS['context-consumer'] };
      }
      return { ...base, kind: 'hook-call', kindLabel: KIND_LABELS['hook-call'] };
    }

    // Context consumer: useContext(MyCtx)
    if (ts.isCallExpression(parent) && !ts.isCallExpression(parent.parent ?? parent)) {
      const callExpr = parent as ts.CallExpression;
      const callee = callExpr.expression.getText(sf);
      if (callee === 'useContext') {
        return { ...base, kind: 'context-consumer', kindLabel: KIND_LABELS['context-consumer'] };
      }
      // HOC wrapping: memo(MyComp), forwardRef(MyComp), lazy(...)
      if (['memo', 'forwardRef', 'React.memo', 'React.forwardRef'].includes(callee)) {
        return { ...base, kind: 'hoc-wrap', kindLabel: KIND_LABELS['hoc-wrap'], context: callee };
      }
      // React.lazy
      if (callee === 'lazy' || callee === 'React.lazy') {
        return { ...base, kind: 'lazy-import', kindLabel: KIND_LABELS['lazy-import'] };
      }
    }

    // Dependency array item: useEffect(() => {}, [myDep])
    if (ts.isArrayLiteralExpression(parent)) {
      const arrParent = parent.parent;
      if (ts.isCallExpression(arrParent)) {
        const callee = (arrParent as ts.CallExpression).expression.getText(sf);
        if (/^(use|React\.use)/.test(callee)) {
          return { ...base, kind: 'hook-dep', kindLabel: KIND_LABELS['hook-dep'], context: callee };
        }
      }
    }
  }

  // ── ANGULAR-specific ───────────────────────────────────────────────────────
  if (framework === 'angular') {
    // Constructor parameter injection
    if (ts.isParameter(parent) && ts.isConstructorDeclaration(parent.parent)) {
      return {
        ...base,
        kind:      'di-injection',
        kindLabel: KIND_LABELS['di-injection'],
        context:   'constructor DI',
      };
    }
    // providers: [MyService] array
    if (ts.isArrayLiteralExpression(parent)) {
      if (lineText.includes('providers') || lineText.includes('declarations') || lineText.includes('imports')) {
        return { ...base, kind: 'decorator-ref', kindLabel: KIND_LABELS['decorator-ref'] };
      }
    }
  }

  // ── General call expression ────────────────────────────────────────────────
  if (ts.isCallExpression(parent) && (parent as ts.CallExpression).expression === node) {
    const parentComp = findEnclosingComponentName(node, sf);
    return {
      ...base,
      kind:      'function-call',
      kindLabel: KIND_LABELS['function-call'],
      context:   parentComp ? `in ${parentComp}` : undefined,
    };
  }

  // ── Assignment / variable init ─────────────────────────────────────────────
  if (ts.isVariableDeclaration(parent) && (parent as ts.VariableDeclaration).initializer === node) {
    return { ...base, kind: 'assignment', kindLabel: KIND_LABELS['assignment'] };
  }

  return { ...base, kind: 'generic-usage', kindLabel: KIND_LABELS['generic-usage'] };
}

// ─── Import-only usages (gather all imports of the symbol) ───────────────────

export function collectImportUsages(
  filePath: string,
  symbolName: string
): FrameworkUsage[] {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }

  const ext = path.extname(filePath).toLowerCase();
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, getScriptKind(ext));
  const lines = text.split('\n');
  const framework = detectFramework(filePath, text);
  const results: FrameworkUsage[] = [];

  ts.forEachChild(sf, node => {
    if (!ts.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (!clause) return;

    const check = (id: ts.Identifier) => {
      if (id.text !== symbolName) return;
      const pos = sf.getLineAndCharacterOfPosition(id.getStart(sf));
      results.push({
        filePath,
        line:      pos.line,
        column:    pos.character,
        offset:    id.getStart(sf),
        kind:      'import-only',
        kindLabel: KIND_LABELS['import-only'],
        lineText:  (lines[pos.line] ?? '').trim(),
        framework,
      });
    };

    if (clause.name) check(clause.name);
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      nb.elements.forEach(el => check(el.name));
    }
  });

  return results;
}

// ─── Full analysis entry point ────────────────────────────────────────────────

export async function analyzeUsages(
  symbolName: string,
  filePaths: string[],
  concurrency = 8
): Promise<UsageSummary> {
  const allUsages: FrameworkUsage[] = [];
  const importFiles = new Set<string>();

  let i = 0;
  const worker = async () => {
    while (i < filePaths.length) {
      const fp = filePaths[i++];
      try {
        const usages = classifyUsagesInFile(fp, symbolName);
        const imports = collectImportUsages(fp, symbolName);

        // If file only has imports (no other usages), mark as import-only
        const nonImportUsages = usages.filter(u => u.kind !== 'import-only');
        if (imports.length > 0 && nonImportUsages.length === 0) {
          importFiles.add(fp);
          allUsages.push(...imports);
        } else {
          allUsages.push(...usages);
        }
      } catch { /* skip unreadable */ }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filePaths.length) }, worker)
  );

  // Build summary maps
  const byKind = new Map<UsageKind, FrameworkUsage[]>();
  const byFile = new Map<string, FrameworkUsage[]>();
  const frameworks = new Set<string>();

  for (const u of allUsages) {
    frameworks.add(u.framework);
    const k = byKind.get(u.kind) ?? [];
    k.push(u);
    byKind.set(u.kind, k);
    const f = byFile.get(u.filePath) ?? [];
    f.push(u);
    byFile.set(u.filePath, f);
  }

  const fwArray = Array.from(frameworks).filter(f => f !== 'generic');
  const framework = fwArray.length > 1
    ? 'mixed'
    : fwArray.length === 1
      ? fwArray[0] as any
      : 'generic';

  return { symbolName, totalCount: allUsages.length, byKind, byFile, framework };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findEnclosingComponentName(node: ts.Node, sf: ts.SourceFile): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isMethodDeclaration(cur)) return cur.name.getText(sf);
    if (ts.isClassDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function getScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.ts':  return ts.ScriptKind.TS;
    default:     return ts.ScriptKind.JS;
  }
}