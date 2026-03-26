import * as vscode from 'vscode';
import { AstTreeProvider } from './astTreeProvider';
import { BreadcrumbProvider } from './breadcrumbProvider';
import { JsxDocumentSymbolProvider } from './documentSymbolProvider';

const SUPPORTED = ['javascriptreact', 'typescriptreact', 'typescript', 'javascript'];
const SELECTOR: vscode.DocumentSelector = SUPPORTED.map(lang => ({ language: lang }));

function isSupported(doc: vscode.TextDocument) {
  return SUPPORTED.includes(doc.languageId);
}

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new AstTreeProvider();
  const breadcrumb = new BreadcrumbProvider();

  // ✅ KEY: registers with VS Code's native top breadcrumb bar
  const symbolProvider = vscode.languages.registerDocumentSymbolProvider(
    SELECTOR,
    new JsxDocumentSymbolProvider()
  );

  const treeView = vscode.window.createTreeView('tsxAstTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // ✅ FIXED: revealRange command was missing
  const revealCmd = vscode.commands.registerCommand(
    'tsxAstTree.revealRange',
    (uri: vscode.Uri, range: vscode.Range) => {
      vscode.window.showTextDocument(uri).then(editor => {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      });
    }
  );

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

  // ✅ FIXED: all disposables properly registered
  context.subscriptions.push(treeView, revealCmd, symbolProvider, breadcrumb);
}

export function deactivate() {}