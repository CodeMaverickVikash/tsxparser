import * as vscode from 'vscode';
import * as ts from 'typescript';

export class JsxDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const sf = ts.createSourceFile(
      document.fileName,
      document.getText(),
      ts.ScriptTarget.Latest,
      true,
      this.scriptKind(document.languageId)
    );
    return this.visitNode(sf, document);
  }

  // ── Core recursive visitor ────────────────────────────────────
  private visitNode(node: ts.Node, doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const results: vscode.DocumentSymbol[] = [];

    ts.forEachChild(node, child => {
      const sym = this.toSymbol(child, doc);
      if (sym) {
        sym.children = this.visitNode(child, doc);
        results.push(sym);
      } else {
        // Not a named symbol — recurse to find nested ones
        results.push(...this.visitNode(child, doc));
      }
    });

    return results;
  }

  // ── Symbol factory ────────────────────────────────────────────
  private toSymbol(node: ts.Node, doc: vscode.TextDocument): vscode.DocumentSymbol | null {
    const entry = this.classify(node, doc);
    if (!entry) return null;

    const { name, kind, detail } = entry;
    const start = doc.positionAt(node.getStart());
    const end   = doc.positionAt(node.getEnd());
    const range = new vscode.Range(start, end);

    return new vscode.DocumentSymbol(name, detail ?? '', kind, range, range);
  }

  // ── Classification — what WebStorm actually shows ─────────────
  private classify(
    node: ts.Node,
    doc: vscode.TextDocument
  ): { name: string; kind: vscode.SymbolKind; detail?: string } | null {

    // ── Imports ────────────────────────────────────────────────
    if (ts.isImportDeclaration(node)) {
      const mod = (node.moduleSpecifier as ts.StringLiteral).text;
      return { name: `'${mod}'`, kind: vscode.SymbolKind.Module, detail: 'import' };
    }

    // ── Class component ────────────────────────────────────────
    if (ts.isClassDeclaration(node)) {
      return { name: node.name?.text ?? '(class)', kind: vscode.SymbolKind.Class };
    }

    // ── Method inside class ────────────────────────────────────
    if (ts.isMethodDeclaration(node)) {
      return { name: node.name.getText(), kind: vscode.SymbolKind.Method };
    }

    // ── Function declaration  (function App() {}) ─────────────
    if (ts.isFunctionDeclaration(node)) {
      return {
        name: node.name?.text ?? '(anonymous)',
        kind: vscode.SymbolKind.Function
      };
    }

    // ── Variable statement  (const App = ...) ─────────────────
    // Unwrap VariableStatement → VariableDeclarationList → VariableDeclaration
    if (ts.isVariableStatement(node)) {
      const decls = node.declarationList.declarations;
      if (decls.length === 1) {
        return this.classifyVarDecl(decls[0], doc);
      }
      return null;
    }

    // ── Single variable declaration ────────────────────────────
    if (ts.isVariableDeclaration(node)) {
      return this.classifyVarDecl(node, doc);
    }

    // ── Interface / Type ───────────────────────────────────────
    if (ts.isInterfaceDeclaration(node)) {
      return { name: node.name.text, kind: vscode.SymbolKind.Interface };
    }
    if (ts.isTypeAliasDeclaration(node)) {
      return { name: node.name.text, kind: vscode.SymbolKind.TypeParameter };
    }

    // ── JSX elements ──────────────────────────────────────────
    if (ts.isJsxElement(node)) {
      return {
        name: this.jsxLabel(node.openingElement.tagName, node.openingElement.attributes),
        kind: vscode.SymbolKind.Object,
        detail: 'jsx'
      };
    }
    if (ts.isJsxSelfClosingElement(node)) {
      return {
        name: this.jsxLabel(node.tagName, node.attributes),
        kind: vscode.SymbolKind.Object,
        detail: 'jsx'
      };
    }
    if (ts.isJsxFragment(node)) {
      return { name: '<>', kind: vscode.SymbolKind.Object, detail: 'jsx' };
    }

    return null;
  }

  // ── Variable declaration classifier ───────────────────────────
  private classifyVarDecl(
    node: ts.VariableDeclaration,
    doc: vscode.TextDocument
  ): { name: string; kind: vscode.SymbolKind; detail?: string } | null {
    if (!ts.isIdentifier(node.name)) return null;
    const varName = node.name.text;
    const init = node.initializer;

    if (!init) return { name: varName, kind: vscode.SymbolKind.Variable };

    // Arrow / function expression component
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return { name: varName, kind: vscode.SymbolKind.Function };
    }

    // React hook call: useState, useEffect, useRef, useCallback etc.
    if (ts.isCallExpression(init)) {
      const callee = init.expression.getText();
      if (/^use[A-Z]/.test(callee) || callee === 'React.useState') {
        return { name: varName, kind: vscode.SymbolKind.Event, detail: callee };
      }
    }

    // Regular variable
    return { name: varName, kind: vscode.SymbolKind.Variable };
  }

  // ── JSX label: <div className="foo bar"> → div.foo ────────────
  // mirrors WebStorm: tag.firstClass  or  tag#id
  private jsxLabel(
    tagName: ts.JsxTagNameExpression,
    attributes: ts.JsxAttributes
  ): string {
    const tag = tagName.getText();
    let qualifier = '';

    attributes.properties.forEach(attr => {
      if (qualifier) return; // take first match only
      if (!ts.isJsxAttribute(attr)) return;

      const attrName = attr.name.getText();

      if (attrName === 'className' && attr.initializer) {
        const raw = this.attrStringValue(attr.initializer);
        if (raw) {
          const firstClass = raw.trim().split(/\s+/)[0];
          qualifier = `.${firstClass}`;
        }
      } else if (attrName === 'id' && attr.initializer) {
        const raw = this.attrStringValue(attr.initializer);
        if (raw) qualifier = `#${raw.trim()}`;
      }
    });

    return `${tag}${qualifier}`;
  }

  // ── Extract string value from JSX attribute initializer ────────
  private attrStringValue(init: ts.StringLiteral | ts.JsxExpression): string | null {
    if (ts.isStringLiteral(init)) return init.text;
    // {`template`} or {"string"}
    if (ts.isJsxExpression(init) && init.expression) {
      if (ts.isStringLiteral(init.expression)) return init.expression.text;
      if (ts.isTemplateExpression(init.expression)) {
        return init.expression.head.text || null;
      }
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
}