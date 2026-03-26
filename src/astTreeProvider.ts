import * as vscode from 'vscode';
import * as ts from 'typescript';

export class AstNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly tsNode: ts.Node,
    public readonly document: vscode.TextDocument,
    iconId: string,
    description?: string
  ) {
    super(label, collapsibleState);
    this.iconPath    = new vscode.ThemeIcon(iconId);
    this.description = description ?? '';
    this.tooltip     = ts.SyntaxKind[tsNode.kind];

    const start = document.positionAt(tsNode.getStart());
    const end   = document.positionAt(tsNode.getEnd());
    this.command = {
      command:   'tsxAstTree.revealRange',
      title:     'Go to node',
      arguments: [document.uri, new vscode.Range(start, end)]
    };
  }
}

export class AstTreeProvider implements vscode.TreeDataProvider<AstNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AstNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sourceFile?: ts.SourceFile;
  private document?:   vscode.TextDocument;

  refresh(doc: vscode.TextDocument) {
    this.document   = doc;
    this.sourceFile = ts.createSourceFile(
      doc.fileName, doc.getText(),
      ts.ScriptTarget.Latest, true,
      this.scriptKind(doc.languageId)
    );
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(el: AstNode) { return el; }

  getChildren(el?: AstNode): AstNode[] {
    if (!this.sourceFile || !this.document) return [];
    const parent: ts.Node = el ? el.tsNode : this.sourceFile;
    const results: AstNode[] = [];

    ts.forEachChild(parent, child => {
      const node = this.buildNode(child);
      if (node) results.push(node);
      else {
        // Transparent wrapper — bubble up children
        ts.forEachChild(child, grandchild => {
          const n = this.buildNode(grandchild);
          if (n) results.push(n);
        });
      }
    });

    return results;
  }

  private buildNode(node: ts.Node): AstNode | null {
    const entry = this.classify(node);
    if (!entry || !this.document) return null;
    const hasKids = node.getChildCount() > 0;
    return new AstNode(
      entry.label,
      hasKids
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      node,
      this.document,
      entry.icon,
      entry.detail
    );
  }

  private classify(node: ts.Node): {
    label: string; icon: string; detail?: string
  } | null {

    // Imports
    if (ts.isImportDeclaration(node)) {
      const mod = (node.moduleSpecifier as ts.StringLiteral).text;
      return { label: `'${mod}'`, icon: 'symbol-module', detail: 'import' };
    }

    // Class
    if (ts.isClassDeclaration(node))
      return { label: node.name?.text ?? '(class)', icon: 'symbol-class' };

    // Method
    if (ts.isMethodDeclaration(node))
      return { label: node.name.getText(), icon: 'symbol-method' };

    // Function declaration
    if (ts.isFunctionDeclaration(node))
      return { label: node.name?.text ?? '(anonymous)', icon: 'symbol-function' };

    // Variable statement — unwrap to declaration
    if (ts.isVariableStatement(node)) {
      const decl = node.declarationList.declarations[0];
      if (decl) return this.classifyVarDecl(decl);
      return null;
    }

    // Variable declaration
    if (ts.isVariableDeclaration(node)) return this.classifyVarDecl(node);

    // Interface / Type
    if (ts.isInterfaceDeclaration(node))
      return { label: node.name.text, icon: 'symbol-interface' };
    if (ts.isTypeAliasDeclaration(node))
      return { label: node.name.text, icon: 'symbol-type-parameter' };

    // JSX
    if (ts.isJsxElement(node)) {
      return {
        label: this.jsxLabel(
          node.openingElement.tagName,
          node.openingElement.attributes
        ),
        icon: 'symbol-misc',
        detail: 'jsx'
      };
    }
    if (ts.isJsxSelfClosingElement(node)) {
      return {
        label: this.jsxLabel(node.tagName, node.attributes),
        icon: 'symbol-misc',
        detail: 'jsx'
      };
    }
    if (ts.isJsxFragment(node))
      return { label: '<>', icon: 'symbol-misc', detail: 'jsx' };

    return null;
  }

  private classifyVarDecl(node: ts.VariableDeclaration): {
    label: string; icon: string; detail?: string
  } | null {
    if (!ts.isIdentifier(node.name)) return null;
    const name = node.name.text;
    const init = node.initializer;

    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
      return { label: name, icon: 'symbol-function' };

    if (init && ts.isCallExpression(init)) {
      const callee = init.expression.getText();
      if (/^use[A-Z]/.test(callee))
        return { label: name, icon: 'symbol-event', detail: callee };
    }

    return { label: name, icon: 'symbol-variable' };
  }

  private jsxLabel(
    tagName: ts.JsxTagNameExpression,
    attributes: ts.JsxAttributes
  ): string {
    const tag = tagName.getText();
    for (const attr of attributes.properties) {
      if (!ts.isJsxAttribute(attr)) continue;
      const n = attr.name.getText();
      if ((n === 'className' || n === 'id') && attr.initializer) {
        const val = ts.isStringLiteral(attr.initializer)
          ? attr.initializer.text
          : (ts.isJsxExpression(attr.initializer) &&
             attr.initializer.expression &&
             ts.isStringLiteral(attr.initializer.expression))
            ? attr.initializer.expression.text
            : null;
        if (val) {
          const q = n === 'id'
            ? `#${val.trim()}`
            : `.${val.trim().split(/\s+/)[0]}`;
          return `${tag}${q}`;
        }
      }
    }
    return tag;
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