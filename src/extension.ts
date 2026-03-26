import * as vscode from "vscode";
import { getJsxBreadcrumbs } from "./jsxParser";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const updateBreadcrumbs = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;

    if (!doc.fileName.endsWith(".tsx") && !doc.fileName.endsWith(".jsx")) {
      return;
    }

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

    panel.webview.html = getHtml(crumbs);
  };

  vscode.window.onDidChangeTextEditorSelection(updateBreadcrumbs);
  vscode.workspace.onDidChangeTextDocument(updateBreadcrumbs);

  context.subscriptions.push({
    dispose: () => panel?.dispose(),
  });
}

function getHtml(crumbs: string[]): string {
  return `
    <html>
    <body style="font-family:sans-serif;padding:10px;background:#1e1e1e;color:white">
      <div style="font-size:14px;">
        ${crumbs
          .map(
            (c, i) =>
              `<span style="color:#4FC3F7">${c}</span>${
                i < crumbs.length - 1 ? " > " : ""
              }`
          )
          .join("")}
      </div>
    </body>
    </html>
  `;
}

export function deactivate() {}