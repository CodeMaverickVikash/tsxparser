import * as vscode from 'vscode';
import * as ts from 'typescript';

export class BreadcrumbProvider {
  private statusBar: vscode.StatusBarItem;

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 100
    );
    this.statusBar.show();
  }

  update(editor: vscode.TextEditor) {
    const doc    = editor.document;
    const offset = doc.offsetAt(editor.selection.active);

    const sf = ts.createSourceFile(
      doc.fileName,
      doc.getText(),
      ts.ScriptTarget.Latest,
      true,
      this.scriptKind(doc.languageId)
    );

    const crumbs = this.buildPath(sf, offset);
    this.statusBar.text = crumbs.length
      ? `$(symbol-misc)  ${crumbs.join('  ›  ')}`
      : '';
  }

  // ── Walk AST top-down, collect labels for ancestors of offset ──
  private buildPath(root: ts.SourceFile, offset: number): string[] {
    const path: string[] = [];

    const walk = (node: ts.Node): boolean => {
      // Prune: cursor not inside this node at all
      if (offset < node.getStart() || offset > node.getEnd()) return false;

      const label = this.labelFor(node);
      if (label) path.push(label);

      ts.forEachChild(node, walk);
      return true;
    };

    walk(root);
    return path;
  }

  // ── Same classification logic as DocumentSymbolProvider ────────
  private labelFor(node: ts.Node): string | null {

    // Function declaration
    if (ts.isFunctionDeclaration(node)) {
      return node.name?.text ?? 'fn';
    }

    // Arrow / function expression — grab variable name
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      return ts.isArrowFunction(node) ? '() =>' : 'fn';
    }

    // Class
    if (ts.isClassDeclaration(node)) return node.name?.text ?? 'class';

    // Method
    if (ts.isMethodDeclaration(node)) return node.name.getText();

    // JSX elements — tag.className or tag#id
    if (ts.isJsxElement(node)) {
      return this.jsxLabel(
        node.openingElement.tagName,
        node.openingElement.attributes
      );
    }
    if (ts.isJsxSelfClosingElement(node)) {
      return this.jsxLabel(node.tagName, node.attributes);
    }
    if (ts.isJsxFragment(node)) return '<>';

    return null;
  }

  // ── <div className="foo bar"> → div.foo ───────────────────────
  private jsxLabel(
    tagName: ts.JsxTagNameExpression,
    attributes: ts.JsxAttributes
  ): string {
    const tag = tagName.getText();
    let qualifier = '';

    for (const attr of attributes.properties) {
      if (!ts.isJsxAttribute(attr)) continue;
      const name = attr.name.getText();

      if (name === 'className' && attr.initializer) {
        const val = this.attrString(attr.initializer);
        if (val) { qualifier = `.${val.trim().split(/\s+/)[0]}`; break; }
      }
      if (name === 'id' && attr.initializer) {
        const val = this.attrString(attr.initializer);
        if (val) { qualifier = `#${val.trim()}`; break; }
      }
    }

    return `${tag}${qualifier}`;
  }

  private attrString(init: ts.StringLiteral | ts.JsxExpression): string | null {
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      if (ts.isStringLiteral(init.expression)) return init.expression.text;
    }
    return null;
  }

  private scriptKind(languageId: string): ts.ScriptKind {
    switch (languageId) {
      case 'typescriptreact': return ts.ScriptKind.TSX;
      case 'javascriptreact': return ts.ScriptKind.JSX;
      case 'typescript':      return ts.ScriptKind.TS;
      default:                return ts.ScriptKind.JS;
    }
  }

  dispose() { this.statusBar.dispose(); }
}