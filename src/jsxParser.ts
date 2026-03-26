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

  function getTag(node: ts.Node): string | null {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
    if (ts.isJsxFragment(node)) return "Fragment";
    return null;
  }

  function getClass(node: ts.Node): string {
    if (ts.isJsxElement(node)) {
      const attrs = node.openingElement.attributes.properties;
      for (const attr of attrs) {
        if (
          ts.isJsxAttribute(attr) &&
          attr.name.text === "className" &&
          attr.initializer
        ) {
          return "." + attr.initializer.getText().replace(/['"]/g, "");
        }
      }
    }
    return "";
  }

  function climb(node?: ts.Node) {
    if (!node) return;
    const tag = getTag(node);
    if (tag) breadcrumbs.unshift(tag + getClass(node));
    climb(node.parent);
  }

  climb(targetNode || undefined);
  return breadcrumbs;
}