/**
 * autoImport.ts — WebStorm-parity Auto-Import Engine
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers a VS Code CodeActionProvider for TS/JS/TSX/JSX files.
 *  • Detects "undeclared identifier" diagnostics (TS2304, TS2552, TS2305, TS2339).
 *  • Searches the project symbol index for matching exports.
 *  • Generates the correct import statement:
 *      - Named export:    import { Symbol } from 'path'
 *      - Default export:  import Symbol from 'path'
 *      - Namespace:       import * as Symbol from 'path'
 *  • Produces relative paths when the target is in the same workspace tree.
 *  • Inserts the import at the top of the existing import block (not line 0).
 *  • Multiple candidates → each gets its own Quick Fix entry.
 *
 * ─── Trigger ──────────────────────────────────────────────────────────────────
 *
 *  Automatic: appears in the 💡 lightbulb / Quick Fix menu (Ctrl+.)
 *  Manual command: codePilot.addImport  (shows input box)
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerAutoImport(context) inside activate().
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { ParsedImport } from './astParser';
import { getIndexer, IndexedSymbol } from './projectIndexer';

// ─── Diagnostic codes that signal "symbol not found" ─────────────────────────

const UNRESOLVED_CODES = new Set([
  2304,   // Cannot find name 'X'
  2552,   // Cannot find name 'X'. Did you mean 'Y'?
  2305,   // Module '"…"' has no exported member 'X'
  2339,   // Property 'X' does not exist on type '…'
  2580,   // Cannot find name 'X'. Do you need to install type definitions?
]);

// ─── Public registration ──────────────────────────────────────────────────────

export function registerAutoImport(context: vscode.ExtensionContext): void {
  const SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript'      },
    { language: 'typescriptreact' },
    { language: 'javascript'      },
    { language: 'javascriptreact' },
  ];

  // CodeAction provider (lightbulb / Ctrl+.)
  const provider = vscode.languages.registerCodeActionsProvider(
    SELECTOR,
    new AutoImportProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  // Manual command: show input box
  const cmd = vscode.commands.registerCommand(
    'codePilot.addImport',
    addImportHandler
  );

  context.subscriptions.push(provider, cmd);
}

// ─── CodeActionProvider ───────────────────────────────────────────────────────

class AutoImportProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document:  vscode.TextDocument,
    _range:    vscode.Range,
    ctx:       vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diag of ctx.diagnostics) {
      if (typeof diag.code !== 'number' || !UNRESOLVED_CODES.has(diag.code)) continue;

      const symbolName = extractSymbolName(diag.message);
      if (!symbolName) continue;

      const candidates = findExportCandidates(symbolName, document.fileName);
      for (const c of candidates) {
        const stmt    = buildImportStatement(c, document.fileName);
        const action  = buildCodeAction(document, diag, c, stmt);
        actions.push(action);
      }
    }

    return actions;
  }
}

// ─── Manual command handler ───────────────────────────────────────────────────

async function addImportHandler(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const symbolName = await vscode.window.showInputBox({
    placeHolder: 'Symbol name to import (e.g. useState, Button, fetchUser)',
    prompt:      'Auto Import — enter symbol name',
  });
  if (!symbolName) return;

  const candidates = findExportCandidates(symbolName, editor.document.fileName);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(`No exported symbol "${symbolName}" found in project.`);
    return;
  }

  // Build Quick Pick items
  interface ImportItem extends vscode.QuickPickItem { candidate: ImportCandidate; stmt: string; }
  const items: ImportItem[] = candidates.map(c => {
    const stmt = buildImportStatement(c, editor.document.fileName);
    return {
      label:       `$(symbol-${c.symbol.type})  ${stmt}`,
      description: vscode.workspace.asRelativePath(c.symbol.filePath),
      candidate:   c,
      stmt,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title:       `Auto Import: ${symbolName}`,
    placeHolder: 'Select import to insert…',
  });
  if (!picked) return;

  await applyImportEdit(editor.document, picked.stmt);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export interface ImportCandidate {
  symbol:     IndexedSymbol;
  exportKind: 'named' | 'default' | 'namespace';
}

/**
 * Find all exported symbols matching `name` in the project index.
 * Excludes symbols from the file being edited.
 */
export function findExportCandidates(
  symbolName: string,
  fromFile:   string
): ImportCandidate[] {
  const absFrom  = path.resolve(fromFile);
  const indexer  = getIndexer();
  const results: ImportCandidate[] = [];

  // Exact match first, then case-insensitive
  const bucket =
    indexer.getSymbolExact(symbolName).filter(s => s.exported && s.filePath !== absFrom);

  if (bucket.length === 0) {
    const lower = symbolName.toLowerCase();
    for (const [k, syms] of indexer.index.symbols) {
      if (k.toLowerCase() === lower) {
        bucket.push(...syms.filter(s => s.exported && s.filePath !== absFrom));
      }
    }
  }

  for (const sym of bucket) {
    // Determine export kind from the ParsedFile's exports list
    const parsed    = indexer.getFile(sym.filePath);
    const exportKind = parsed
      ? classifyExportKind(sym.name, parsed.exports)
      : 'named';

    results.push({ symbol: sym, exportKind });
  }

  return results;
}

/**
 * Build the import statement string.
 *
 * Named:     import { Button } from './components/Button'
 * Default:   import Button from './components/Button'
 * Namespace: import * as utils from './utils'
 */
export function buildImportStatement(
  candidate: ImportCandidate,
  fromFile:  string
): string {
  const importPath = resolveImportAlias(candidate.symbol.filePath, fromFile);

  switch (candidate.exportKind) {
    case 'default':
      return `import ${candidate.symbol.name} from '${importPath}';`;
    case 'namespace':
      return `import * as ${candidate.symbol.name} from '${importPath}';`;
    default:
      return `import { ${candidate.symbol.name} } from '${importPath}';`;
  }
}

// ─── WorkspaceEdit application ────────────────────────────────────────────────

async function applyImportEdit(
  document: vscode.TextDocument,
  stmt:     string
): Promise<void> {
  const edit       = new vscode.WorkspaceEdit();
  const plan       = planImportEdit(document, stmt);

  if (plan.type === 'noop') {
    vscode.window.showInformationMessage('Import already exists.');
    return;
  }

  if (plan.type === 'replace') {
    edit.replace(document.uri, plan.range, plan.text);
  } else {
    edit.insert(document.uri, plan.position, plan.text);
  }

  await vscode.workspace.applyEdit(edit);
}

// ─── CodeAction builder ───────────────────────────────────────────────────────

function buildCodeAction(
  document:    vscode.TextDocument,
  diagnostic:  vscode.Diagnostic,
  candidate:   ImportCandidate,
  stmt:        string
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    `Add import: ${stmt}`,
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics   = [diagnostic];
  action.isPreferred   = true;

  const plan = planImportEdit(document, stmt);
  if (plan.type !== 'noop') {
    const edit = new vscode.WorkspaceEdit();
    if (plan.type === 'replace') {
      edit.replace(document.uri, plan.range, plan.text);
    } else {
      edit.insert(document.uri, plan.position, plan.text);
    }
    action.edit = edit;
  }

  return action;
}

type ImportEditPlan =
  | { type: 'noop' }
  | { type: 'insert'; position: vscode.Position; text: string }
  | { type: 'replace'; range: vscode.Range; text: string };

function planImportEdit(document: vscode.TextDocument, stmt: string): ImportEditPlan {
  const parsed = getIndexer().getFile(document.fileName);
  const incoming = parseImportStatement(stmt);
  if (!parsed || !incoming) {
    return {
      type: 'insert',
      position: new vscode.Position(findImportInsertLine(document), 0),
      text: stmt + '\n',
    };
  }

  const existing = parsed.imports.find(imp => imp.module === incoming.module);
  if (!existing) {
    return {
      type: 'insert',
      position: new vscode.Position(findImportInsertLine(document), 0),
      text: stmt + '\n',
    };
  }

  if (hasImportConflict(existing, incoming)) {
    return { type: 'noop' };
  }

  if (incoming.named.length > 0 && !existing.typeOnly) {
    const merged = mergeNamedImportStatement(existing, incoming.named[0].name);
    if (merged) {
      return {
        type: 'replace',
        range: toRange(document, existing.span),
        text: merged,
      };
    }
  }

  return {
    type: 'insert',
    position: new vscode.Position(findImportInsertLine(document), 0),
    text: stmt + '\n',
  };
}

// ─── Import insertion heuristic ───────────────────────────────────────────────

/**
 * Find the best line to insert a new import.
 * Strategy: after the last existing import declaration.
 * Falls back to line 0 if none exist.
 */
function findImportInsertLine(document: vscode.TextDocument): number {
  let lastImportLine = -1;

  for (let i = 0; i < Math.min(document.lineCount, 200); i++) {
    const text = document.lineAt(i).text.trimStart();
    if (text.startsWith('import ') || text.startsWith('// @ts') || text.startsWith('/// <')) {
      lastImportLine = i;
    } else if (lastImportLine >= 0 && text !== '' && !text.startsWith('//')) {
      break;
    }
  }

  return lastImportLine + 1;
}

// ─── Export kind classification ───────────────────────────────────────────────

function classifyExportKind(
  symbolName: string,
  exports:    Array<{ kind: string; name?: string; alias?: string }>
): 'named' | 'default' | 'namespace' {
  for (const ex of exports) {
    if (ex.kind === 'default' && (!ex.name || ex.name === symbolName)) return 'default';
    if (ex.alias === symbolName) return 'named';
  }
  return 'named';
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Returns the shortest relative (or workspace-relative) import path.
 * Strips known extensions since bundlers resolve them automatically.
 */
function resolveImportAlias(targetAbs: string, fromFile: string): string {
  const fromDir = path.dirname(path.resolve(fromFile));
  let   rel     = path.relative(fromDir, targetAbs).replace(/\\/g, '/');

  if (!rel.startsWith('.')) rel = './' + rel;

  // Strip index.{ts,tsx,js,jsx} → directory import
  rel = rel.replace(/\/index\.(ts|tsx|js|jsx)$/, '');
  // Strip extension for clean imports
  rel = rel.replace(/\.(ts|tsx|js|jsx)$/, '');

  return rel;
}

// ─── Diagnostic message parser ────────────────────────────────────────────────

/** Extract the symbol name from a TypeScript diagnostic message. */
function extractSymbolName(message: string): string | null {
  // "Cannot find name 'Foo'."
  // "Module '"./x"' has no exported member 'Foo'."
  const m = message.match(/'([A-Za-z_$][A-Za-z0-9_$]*)'/);
  return m ? m[1] : null;
}

function parseImportStatement(stmt: string): ParsedImport | null {
  const defaultMatch = stmt.match(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?$/);
  if (defaultMatch) {
    return {
      module: defaultMatch[2],
      defaultImport: defaultMatch[1],
      named: [],
      typeOnly: false,
      span: emptySpan(),
    };
  }

  const namedMatch = stmt.match(/^import\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s+from\s+['"]([^'"]+)['"];?$/);
  if (namedMatch) {
    return {
      module: namedMatch[2],
      named: [{ name: namedMatch[1] }],
      typeOnly: false,
      span: emptySpan(),
    };
  }

  const namespaceMatch = stmt.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?$/);
  if (namespaceMatch) {
    return {
      module: namespaceMatch[2],
      namespaceImport: namespaceMatch[1],
      named: [],
      typeOnly: false,
      span: emptySpan(),
    };
  }

  return null;
}

function hasImportConflict(existing: ParsedImport, incoming: ParsedImport): boolean {
  if (incoming.defaultImport) {
    return existing.defaultImport === incoming.defaultImport;
  }

  if (incoming.namespaceImport) {
    return existing.namespaceImport === incoming.namespaceImport;
  }

  return incoming.named.some(
    item => existing.named.some(existingItem => (existingItem.alias ?? existingItem.name) === item.name)
  );
}

function mergeNamedImportStatement(existing: ParsedImport, symbolName: string): string | null {
  if (existing.defaultImport || existing.namespaceImport) {
    return null;
  }

  const names = new Set(existing.named.map(item => item.alias ?? item.name));
  names.add(symbolName);

  return `import { ${Array.from(names).sort((a, b) => a.localeCompare(b)).join(', ')} } from '${existing.module}';`;
}

function toRange(_document: vscode.TextDocument, span: ParsedImport['span']): vscode.Range {
  return new vscode.Range(
    new vscode.Position(span.start.line, span.start.character),
    new vscode.Position(span.end.line, span.end.character)
  );
}

function emptySpan(): ParsedImport['span'] {
  return {
    start: { line: 0, character: 0, offset: 0 },
    end: { line: 0, character: 0, offset: 0 },
  };
}
