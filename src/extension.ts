import * as vscode from "vscode";
import { getJsxBreadcrumbs } from "./jsxParser";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const update = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    if (!doc.fileName.endsWith(".tsx") && !doc.fileName.endsWith(".jsx")) return;

    const code = doc.getText();
    const offset = doc.offsetAt(editor.selection.active);

    const crumbs = getJsxBreadcrumbs(code, offset);

    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "jsxBreadcrumb",
        "JSX Breadcrumb",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
    }

    panel.webview.html = `
      <html>
      <body style="background:#1e1e1e;color:white;font-family:sans-serif;padding:8px">
        ${crumbs.map((c, i) =>
          `<span style="color:#4FC3F7">${c}</span>${i < crumbs.length - 1 ? " > " : ""}`
        ).join("")}
      </body>
      </html>
    `;
  };

  vscode.window.onDidChangeTextEditorSelection(update);
  vscode.workspace.onDidChangeTextDocument(update);
  vscode.window.onDidChangeActiveTextEditor(update);

  context.subscriptions.push({ dispose: () => panel?.dispose() });
}

export function deactivate() {}