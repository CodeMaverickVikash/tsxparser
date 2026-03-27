/**
 * extension.ts — Full activate() with all WebStorm-parity features wired.
 *
 *  ✅ AstTreeProvider            — JSX/TSX structure panel
 *  ✅ BreadcrumbProvider         — status-bar breadcrumb trail
 *  ✅ JsxDocumentSymbolProvider  — outline view (Ctrl+Shift+O)
 *  ✅ ProjectIndexer             — project-wide incremental symbol index
 *  ✅ GoToDefinition             — frontendAI.goToDefinition  (F12)
 *  ✅ FindUsages                 — frontendAI.findUsages      (Shift+F12)
 *  ✅ ImportGraph                — frontendAI.showDependencies / showDependents / showCircularDeps
 *  ✅ AutoImport                 — lightbulb quick-fix + frontendAI.addImport
 *  ✅ RenameRefactor             — frontendAI.renameSymbol    (F2)
 *  ✅ AstCache                   — LRU + hash cache, frontendAI.cacheStats
 */

import * as vscode from 'vscode';
import { AstTreeProvider }                from './astTreeProvider';
import { BreadcrumbProvider }             from './breadcrumbProvider';
import { JsxDocumentSymbolProvider }      from './documentSymbolProvider';
import { getIndexer, buildIndex, getSymbol } from './projectIndexer';
import { registerGoToDefinition }         from './goToDefinition';
import { registerFindUsages }             from './findUsages';
import { getImportGraph, registerImportGraphCommands } from './importGraph';
import { registerAutoImport }             from './autoImport';
import { registerRenameRefactor }         from './renameRefactor';
import { getAstCache, registerCacheDiagnosticsCommand } from './astCache';

const SUPPORTED = ['javascriptreact', 'typescriptreact', 'typescript', 'javascript'];
const SELECTOR: vscode.DocumentSelector = SUPPORTED.map(lang => ({ language: lang }));

function isSupported(doc: vscode.TextDocument): boolean {
  return SUPPORTED.includes(doc.languageId);
}

export function activate(context: vscode.ExtensionContext): void {

  // ── AST Cache (must be first — used by indexer internals) ─────────────────
  const astCache = getAstCache({ capacity: 500, concurrency: 12, memPressureMB: 400 });
  registerCacheDiagnosticsCommand(context);

  // ── Core providers ────────────────────────────────────────────────────────
  const treeProvider = new AstTreeProvider();
  const breadcrumb   = new BreadcrumbProvider();

  const symbolProvider = vscode.languages.registerDocumentSymbolProvider(
    SELECTOR,
    new JsxDocumentSymbolProvider()
  );

  const treeView = vscode.window.createTreeView('tsxAstTree', {
    treeDataProvider: treeProvider,
    showCollapseAll:  true,
  });

  const revealCmd = vscode.commands.registerCommand(
    'tsxAstTree.revealRange',
    (uri: vscode.Uri, range: vscode.Range) => {
      vscode.window.showTextDocument(uri).then(editor => {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      });
    }
  );

  // ── Project Indexer ───────────────────────────────────────────────────────
  const indexer = getIndexer({
    typingDebounceMs: 400,
    saveDebounceMs:   80,
    fsDebounceMs:     300,
  });

  // Background build
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'TSX: Indexing...', cancellable: false },
    async () => {
      const stats = await buildIndex();

      // Build import graph after index is ready
      const graph = getImportGraph();
      graph.buildGraph();
      const graphStats = graph.stats();

      const cycleWarning = graphStats.cycleCount > 0
        ? `  \u26a0 ${graphStats.cycleCount} circular dep${graphStats.cycleCount !== 1 ? 's' : ''}`
        : '';

      vscode.window.setStatusBarMessage(
        `$(database) TSX: ${stats.symbolCount} symbols \u00b7 ${stats.fileCount} files${cycleWarning}`,
        8_000
      );
    }
  );

  // Refresh tree + patch import graph on index changes
  const onChangeIndex = indexer.onDidChangeIndex(_stats => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSupported(editor.document)) {
      treeProvider.refresh(editor.document);
    }
  });

  const onUpdateFile = indexer.onDidUpdateFile(diff => {
    getImportGraph().updateFile(diff.filePath);
    astCache.invalidate(diff.filePath);
  });

  // ── WebStorm-parity features ──────────────────────────────────────────────

  registerGoToDefinition(context);      // F12 + frontendAI.goToDefinition
  registerFindUsages(context);          // Shift+F12 + frontendAI.findUsages
  registerImportGraphCommands(context); // showDependencies / showDependents / showCircularDeps
  registerAutoImport(context);          // Ctrl+. quick-fix + frontendAI.addImport
  registerRenameRefactor(context);      // F2 + frontendAI.renameSymbol

  // ── Existing symbol search command ────────────────────────────────────────
  const findSymbolCmd = vscode.commands.registerCommand(
    'tsxAstTree.findSymbol',
    async () => {
      const query = await vscode.window.showInputBox({
        placeHolder: 'Symbol name (e.g. useAuth, Button, fetchUser)',
        prompt:      'Project-wide symbol lookup',
      });
      if (!query) return;

      const symbols = getSymbol(query);
      if (!symbols.length) {
        vscode.window.showInformationMessage(`No symbol found: "${query}"`);
        return;
      }

      interface SymbolItem extends vscode.QuickPickItem {
        fsPath: string; line: number; column: number;
      }

      const items: SymbolItem[] = symbols.map(s => ({
        label:       `$(${symbolIcon(s.type)}) ${s.name}`,
        description: s.detail ?? '',
        detail:      `${vscode.workspace.asRelativePath(s.filePath)}:${s.location.line + 1}`,
        fsPath:      s.filePath,
        line:        s.location.line,
        column:      s.location.column,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title:         `Symbols matching "${query}"`,
        matchOnDetail: true,
      });
      if (!picked) return;

      const uri    = vscode.Uri.file(picked.fsPath);
      const pos    = new vscode.Position(picked.line, picked.column);
      const range  = new vscode.Range(pos, pos);
      const editor = await vscode.window.showTextDocument(uri);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    }
  );

  // ── Editor lifecycle ──────────────────────────────────────────────────────
  let debounceTimer: NodeJS.Timeout;

  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && isSupported(editor.document)) {
      treeProvider.refresh(editor.document);
      breadcrumb.update(editor);
    }
  }, null, context.subscriptions);

  vscode.window.onDidChangeTextEditorSelection(e => {
    if (isSupported(e.textEditor.document)) {
      breadcrumb.update(e.textEditor);
    }
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(e => {
    const editor = vscode.window.activeTextEditor;
    if (editor && e.document === editor.document && isSupported(e.document)) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => treeProvider.refresh(e.document), 300);
    }
  }, null, context.subscriptions);

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && isSupported(activeEditor.document)) {
    treeProvider.refresh(activeEditor.document);
    breadcrumb.update(activeEditor);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    treeView,
    revealCmd,
    symbolProvider,
    breadcrumb,
    findSymbolCmd,
    indexer,
    onChangeIndex,
    onUpdateFile,
    { dispose: () => getImportGraph().dispose() },
  );
}

export function deactivate(): void {}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function symbolIcon(type: string): string {
  switch (type) {
    case 'function':  return 'symbol-function';
    case 'class':     return 'symbol-class';
    case 'method':    return 'symbol-method';
    case 'property':  return 'symbol-property';
    default:          return 'symbol-variable';
  }
}
