import * as ts from "typescript";

export function getJsxBreadcrumbs(code: string, position: number): string[] {
  const sourceFile = ts.createSourceFile(
    "file.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  let targetNode: ts.Node | null = null;

  function findNode(node: ts.Node) {
    if (position >= node.getStart() && position <= node.getEnd()) {
      targetNode = node;
      ts.forEachChild(node, findNode);
    }
  }

  findNode(sourceFile);

  const breadcrumbs: string[] = [];

  function climb(node: ts.Node | undefined) {
    if (!node) return;

    if (ts.isJsxElement(node)) {
      breadcrumbs.unshift(node.openingElement.tagName.getText());
    }

    if (ts.isJsxSelfClosingElement(node)) {
      breadcrumbs.unshift(node.tagName.getText());
    }

    climb(node.parent);
  }

  climb(targetNode || undefined);

  return breadcrumbs;
}