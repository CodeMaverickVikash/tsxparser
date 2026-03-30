/**
 * hoverProvider.ts — WebStorm-style rich hover popup
 *
 * Changes in this version
 * ───────────────────────
 *  • Hover popup now shows a framework badge when the symbol carries
 *    framework metadata (React / Angular / Vue) with its role label.
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers a HoverProvider for TS / TSX / JS / JSX.
 *  • On hover over any identifier the popup shows:
 *
 *      ┌────────────────────────────────────────────────────┐
 *      │ (alias) const Cart: () => JSX.Element              │  ← type signature
 *      │ import { Cart } from './shop/Cart'                 │  ← import (code)
 *      │ ⚛ React functional component                       │  ← framework badge
 *      │ ─────────────────────────────────────────────────  │
 *      │ 🟦 src/pages/shop/Cart.tsx  ·  line 42  [link]    │  ← definition link
 *      └────────────────────────────────────────────────────┘
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { resolveAtPosition }          from './symbolResolver';
import { getIndexer, IndexedSymbol }  from './projectIndexer';
import { Framework }                  from './frameworkDetector';

// ─── Constants ────────────────────────────────────────────────────────────────

export const NAV_CMD = 'codePilot.navigateToLocation';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript'      },
  { language: 'typescriptreact' },
  { language: 'javascript'      },
  { language: 'javascriptreact' },
];

// Framework display helpers
const FRAMEWORK_EMOJI: Record<Framework, string> = {
  react:   '⚛',
  angular: '🔺',
  vue:     '💚',
  unknown: '',
};

const FRAMEWORK_LABEL: Record<Framework, string> = {
  react:   'React',
  angular: 'Angular',
  vue:     'Vue',
  unknown: '',
};

// ─── Public registration ──────────────────────────────────────────────────────

export function registerHoverProvider(context: vscode.ExtensionContext): void {

  const hoverReg = vscode.languages.registerHoverProvider(SELECTOR, new SymbolHoverProvider());

  const navCmd = vscode.commands.registerCommand(
    NAV_CMD,
    async (filePath: string, line: number, column: number) => {
      const uri    = vscode.Uri.file(filePath);
      const pos    = new vscode.Position(line, column);
      const editor = await vscode.window.showTextDocument(uri, { preview: false });
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    }
  );

  context.subscriptions.push(hoverReg, navCmd);
}

// ─── Hover provider ───────────────────────────────────────────────────────────

class SymbolHoverProvider implements vscode.HoverProvider {

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {

    const results = resolveAtPosition(document, position, { exactOnly: false, maxFuzzy: 3 });
    if (!results.length) return undefined;

    const sym = results[0].symbol;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted     = true;
    md.supportHtml   = false;

    // ── 1. Type signature ────────────────────────────────────────────────────
    md.appendCodeblock(buildSignature(sym), 'typescript');

    // ── 2. Import statement (only when symbol lives in another file) ─────────
    const isLocal = path.resolve(sym.filePath) === path.resolve(document.fileName);
    if (!isLocal) {
      const imp = findImportLine(sym.name, document.fileName);
      if (imp) { md.appendCodeblock(imp, 'typescript'); }
    }

    // ── 3. Framework badge ───────────────────────────────────────────────────
    if (sym.framework && sym.framework !== 'unknown') {
      const emoji = FRAMEWORK_EMOJI[sym.framework];
      const fwLabel = FRAMEWORK_LABEL[sym.framework];
      const roleLabel = sym.frameworkTag?.label ?? `${fwLabel} symbol`;
      md.appendMarkdown(`\n\n${emoji} *${roleLabel}*`);
    }

    // ── 4. Separator + clickable definition link ──────────────────────────────
    md.appendMarkdown('\n\n---\n\n');

    const rel     = vscode.workspace.asRelativePath(sym.filePath);
    const lineNum = sym.location.line + 1;
    const args    = encodeURIComponent(
      JSON.stringify([sym.filePath, sym.location.line, sym.location.column])
    );
    const icon    = sym.filePath.match(/\.[jt]sx$/i) ? '$(file-code)' : '$(symbol-file)';

    md.appendMarkdown(
      `${icon} [${rel}](command:${NAV_CMD}?${args})` +
      `&nbsp;&nbsp;·&nbsp;&nbsp;line ${lineNum}`
    );

    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return new vscode.Hover(md, wordRange);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSignature(sym: IndexedSymbol): string {
  const d = sym.detail ?? '';

  switch (sym.type) {
    case 'function':
      return `(function) function ${sym.name}${d}`;
    case 'class':
      return `(class) class ${sym.name}${d ? ` ${d}` : ''}`;
    case 'method': {
      const owner = sym.parent ? `${sym.parent}.` : '';
      return `(method) ${owner}${sym.name}${d}`;
    }
    case 'property': {
      const owner = sym.parent ? `${sym.parent}.` : '';
      return `(property) ${owner}${sym.name}${d ? `: ${d}` : ''}`;
    }
    default:
      return `(alias) const ${sym.name}${d ? `: ${d}` : ''}`;
  }
}

function findImportLine(symbolName: string, fromFile: string): string | undefined {
  const parsed = getIndexer().getFile(fromFile);
  if (!parsed) return undefined;

  for (const imp of parsed.imports) {
    if (imp.defaultImport === symbolName) {
      return `import ${symbolName} from '${imp.module}'`;
    }
    const n = imp.named.find(x => (x.alias ?? x.name) === symbolName);
    if (n) {
      const clause = n.alias ? `{ ${n.name} as ${n.alias} }` : `{ ${symbolName} }`;
      return `import ${clause} from '${imp.module}'`;
    }
    if (imp.namespaceImport === symbolName) {
      return `import * as ${symbolName} from '${imp.module}'`;
    }
  }
  return undefined;
}