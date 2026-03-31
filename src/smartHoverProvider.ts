/**
 * smartHoverProvider.ts — Framework-Aware Smart Hover
 *
 * Replaces the basic hoverProvider.ts with a rich hover that shows:
 *
 *  ┌─────────────────────────────────────────────────────┐
 *  │ ⚛ (function) function useAuth(): AuthContext        │  ← signature
 *  │ import { useAuth } from './hooks/useAuth'           │  ← import path
 *  │ ─────────────────────────────────────────────────── │
 *  │ 🪝 Hook Call ×6   ⚛ JSX Render ×2   📥 Import ×3  │  ← usage summary
 *  │ ─────────────────────────────────────────────────── │
 *  │ 📄 src/hooks/useAuth.ts · line 12   [Go to def]    │
 *  └─────────────────────────────────────────────────────┘
 *
 * The usage summary is built from a lightweight synchronous scan that
 * reads the project index (no full AST re-parse on hover).
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { resolveAtPosition }            from './symbolResolver';
import { getIndexer, IndexedSymbol }    from './projectIndexer';
import {
  classifyUsagesInFile,
  KIND_ICONS,
  KIND_LABELS,
  UsageKind,
  detectFramework,
  FrameworkUsage,
} from './frameworkAnalyzer';

// ─── Command ──────────────────────────────────────────────────────────────────

export const NAV_CMD       = 'codePilot.navigateToLocation';
export const FIND_CMD      = 'codePilot.findUsagesSmart';
export const SHOW_PANEL_CMD = 'codePilot.showUsagePanelFromHover';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript'      },
  { language: 'typescriptreact' },
  { language: 'javascript'      },
  { language: 'javascriptreact' },
];

// ─── Lightweight usage cache (keyed by symbolName, invalidated on index change) ─

interface CachedSummary {
  kindCounts: Map<UsageKind, number>;
  fileCount:  number;
  total:      number;
  framework:  string;
}

const _hoverCache = new Map<string, CachedSummary>();

export function invalidateHoverCache(): void {
  _hoverCache.clear();
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerSmartHoverProvider(context: vscode.ExtensionContext): void {

  const hoverReg = vscode.languages.registerHoverProvider(SELECTOR, new SmartHoverProvider());

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

  // Invalidate cache on index changes
  const onIndex = getIndexer().onDidChangeIndex(() => invalidateHoverCache());

  context.subscriptions.push(hoverReg, navCmd, onIndex);
}

// ─── Hover provider ───────────────────────────────────────────────────────────

class SmartHoverProvider implements vscode.HoverProvider {

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {

    const results = resolveAtPosition(document, position, { exactOnly: false, maxFuzzy: 3 });
    if (!results.length) return undefined;

    const resolved = results[0];
    const sym      = resolved.symbol;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted   = true;
    md.supportHtml = false;

    // ── 1. Framework badge + type signature ─────────────────────────────────
    const fw = detectFramework(sym.filePath, '');  // fast path — no text read
    const fwEmoji = fw === 'react' ? '⚛ ' : fw === 'angular' ? '🅰 ' : fw === 'vue' ? '💚 ' : '';
    md.appendCodeblock(`${fwEmoji}${buildSignature(sym)}`, 'typescript');

    // ── 2. Import statement (if symbol is from another file) ─────────────────
    const isLocal = path.resolve(sym.filePath) === path.resolve(document.fileName);
    if (!isLocal) {
      const imp = findImportLine(sym.name, document.fileName);
      if (imp) md.appendCodeblock(imp, 'typescript');
    }

    // ── 3. Usage summary (lightweight — from index-level scan) ──────────────
    const summary = this._getQuickSummary(sym.name);
    if (summary && summary.total > 0) {
      md.appendMarkdown('\n\n---\n\n');

      // Usage kind pills in markdown
      const topKinds = Array.from(summary.kindCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);  // show max 4 kind groups in hover

      const kindParts = topKinds.map(([kind, count]) =>
        `${KIND_ICONS[kind]} **${KIND_LABELS[kind]}** ×${count}`
      ).join('   ');

      md.appendMarkdown(kindParts);

      if (summary.fileCount > 0) {
        md.appendMarkdown(`\n\n_across ${summary.fileCount} file${summary.fileCount !== 1 ? 's' : ''}_`);
      }

      // "Show all usages" link
      const findArgs = encodeURIComponent(JSON.stringify([sym.name]));
      md.appendMarkdown(
        `\n\n[$(references) Show all ${summary.total} usage${summary.total !== 1 ? 's' : ''}](command:${FIND_CMD}?${findArgs})`
      );
    }

    // ── 4. Separator + definition link ───────────────────────────────────────
    md.appendMarkdown('\n\n---\n\n');

    const rel     = vscode.workspace.asRelativePath(sym.filePath);
    const lineNum = sym.location.line + 1;
    const navArgs = encodeURIComponent(
      JSON.stringify([sym.filePath, sym.location.line, sym.location.column])
    );
    const fileIcon = sym.filePath.match(/\.[jt]sx$/i) ? '$(file-code)' : '$(symbol-file)';

    md.appendMarkdown(
      `${fileIcon} [${rel}](command:${NAV_CMD}?${navArgs})` +
      `&nbsp;&nbsp;·&nbsp;&nbsp;line ${lineNum}`
    );

    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return new vscode.Hover(md, wordRange);
  }

  /** Fast synchronous usage scan from index — no full AST reparse */
  private _getQuickSummary(symbolName: string): CachedSummary | undefined {
    if (_hoverCache.has(symbolName)) return _hoverCache.get(symbolName)!;

    const indexer = getIndexer();
    const filePaths = Array.from(indexer.index.files.keys());

    // Limit hover scan to first 60 files to stay fast
    // (full analysis happens in the panel via findUsagesSmart command)
    const sample = filePaths.slice(0, 60);

    const kindCounts = new Map<UsageKind, number>();
    const filesWithUsages = new Set<string>();
    let total = 0;
    let framework = 'generic';

    for (const fp of sample) {
      try {
        const usages = classifyUsagesInFile(fp, symbolName);
        if (usages.length > 0) {
          filesWithUsages.add(fp);
          if (usages[0].framework !== 'generic') framework = usages[0].framework;
          for (const u of usages) {
            kindCounts.set(u.kind, (kindCounts.get(u.kind) ?? 0) + 1);
            total++;
          }
        }
      } catch { /* skip */ }
    }

    const result: CachedSummary = {
      kindCounts,
      fileCount: filesWithUsages.size,
      total,
      framework,
    };
    _hoverCache.set(symbolName, result);
    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSignature(sym: IndexedSymbol): string {
  const d = sym.detail ?? '';
  switch (sym.type) {
    case 'function': return `function ${sym.name}${d}`;
    case 'class':    return `class ${sym.name}${d ? ` ${d}` : ''}`;
    case 'method': {
      const owner = sym.parent ? `${sym.parent}.` : '';
      return `(method) ${owner}${sym.name}${d}`;
    }
    case 'property': {
      const owner = sym.parent ? `${sym.parent}.` : '';
      return `(property) ${owner}${sym.name}${d ? `: ${d}` : ''}`;
    }
    default:
      return `const ${sym.name}${d ? `: ${d}` : ''}`;
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