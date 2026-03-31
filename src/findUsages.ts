/**
 * findUsages.ts — WebStorm-parity "Find All Usages" (Framework-Aware Edition)
 *
 * ─── What changed from the original ──────────────────────────────────────────
 *
 *  • Replaces the plain occurrence-based Quick Pick with a rich WebviewPanel
 *    (usagePanel.ts) that groups results by semantic kind:
 *      ⚛ JSX Render  🪝 Hook Call  📡 Context Consumer  📞 Function Call …
 *
 *  • Uses frameworkAnalyzer.ts to classify every usage in its AST context —
 *    understands React component trees, hooks, prop passing, Angular DI, etc.
 *
 *  • The native ReferenceProvider (Shift+F12) still works for the VS Code
 *    references panel; the rich panel opens via codePilot.findUsagesSmart.
 *
 *  • The old Quick Pick fallback is removed; navigation happens via postMessage
 *    from the webview.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { getIndexer }                      from './projectIndexer';
import { findIdentifierOccurrencesInFile } from './symbolResolver';
import { analyzeUsages, FrameworkUsage }   from './frameworkAnalyzer';
import { showUsagePanel }                  from './usagePanel';
import { FIND_CMD }                        from './smartHoverProvider';

// ─── Public types (kept for backward compatibility) ───────────────────────────

export interface UsageLocation {
  filePath: string;
  line:     number;
  column:   number;
  offset:   number;
  lineText: string;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerFindUsages(context: vscode.ExtensionContext): void {

  // ── Smart panel command (called from hover link & manual shortcut) ─────────
  const smartCmd = vscode.commands.registerCommand(
    FIND_CMD,
    async (symbolName?: string) => {
      const editor = vscode.window.activeTextEditor;

      // If called with a symbol name (from hover link), use it directly
      if (!symbolName) {
        if (!editor) {
          vscode.window.showWarningMessage('CodePilot: No active editor.');
          return;
        }
        const pos = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(
          pos, /[a-zA-Z_$][a-zA-Z0-9_$]*/
        );
        symbolName = range ? editor.document.getText(range) : undefined;
      }

      if (!symbolName) {
        vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
        return;
      }

      await findAndShowPanel(context, symbolName);
    }
  );

  // ── Legacy command alias (codePilot.findUsages) ───────────────────────────
  const legacyCmd = vscode.commands.registerCommand(
    'codePilot.findUsages',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('CodePilot: No active editor.');
        return;
      }
      const pos = editor.selection.active;
      const range = editor.document.getWordRangeAtPosition(
        pos, /[a-zA-Z_$][a-zA-Z0-9_$]*/
      );
      const symbolName = range ? editor.document.getText(range) : undefined;
      if (!symbolName) {
        vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
        return;
      }
      await findAndShowPanel(context, symbolName);
    }
  );

  // ── Native Shift+F12 provider (VS Code References panel) ──────────────────
  const SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript'      },
    { language: 'typescriptreact' },
    { language: 'javascript'      },
    { language: 'javascriptreact' },
  ];

  const provider = vscode.languages.registerReferenceProvider(
    SELECTOR,
    new FindUsagesProvider()
  );

  context.subscriptions.push(smartCmd, legacyCmd, provider);
}

// ─── Core: open the smart usage panel ────────────────────────────────────────

async function findAndShowPanel(
  context:    vscode.ExtensionContext,
  symbolName: string
): Promise<void> {
  const indexer   = getIndexer();
  const filePaths = Array.from(indexer.index.files.keys());

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Window,
      title:       `CodePilot: Analysing usages of "${symbolName}"…`,
      cancellable: false,
    },
    async () => {
      const summary = await analyzeUsages(symbolName, filePaths, 10);

      if (summary.totalCount === 0) {
        vscode.window.showInformationMessage(
          `CodePilot: No usages found for "${symbolName}".`
        );
        return;
      }

      showUsagePanel(context, summary, async (filePath, line, col) => {
        const uri    = vscode.Uri.file(filePath);
        const pos    = new vscode.Position(line, col);
        const range  = new vscode.Range(pos, pos);
        const editor = await vscode.window.showTextDocument(uri, {
          preview: false,
          viewColumn: vscode.ViewColumn.One,
        });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
      });
    }
  );
}

// ─── Native ReferenceProvider (Shift+F12 — plain locations for VS Code UI) ───

class FindUsagesProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[]> {
    const symbolName = wordAt(document, position);
    if (!symbolName) return [];

    const usages = await findAllUsages(symbolName);
    return usages.map(u =>
      new vscode.Location(
        vscode.Uri.file(u.filePath),
        new vscode.Position(u.line, u.column)
      )
    );
  }
}

// ─── findAllUsages (kept for backward compat with inlineUsagesLens.ts) ────────

export async function findAllUsages(
  symbolName: string,
  opts: {
    includeDefinitions?: boolean;
    concurrency?:        number;
  } = {}
): Promise<UsageLocation[]> {
  const indexer     = getIndexer();
  const filePaths   = Array.from(indexer.index.files.keys());
  const concurrency = opts.concurrency ?? 8;

  const defSites = new Set<string>();
  if (!opts.includeDefinitions) {
    for (const sym of indexer.getSymbolExact(symbolName)) {
      defSites.add(`${sym.filePath}:${sym.location.line}:${sym.location.column}`);
    }
  }

  const allResults: UsageLocation[] = [];
  let i = 0;

  const worker = async () => {
    while (i < filePaths.length) {
      const fp = filePaths[i++];
      try {
        const hits  = findIdentifierOccurrencesInFile(fp, symbolName);
        const lines = readLinesSync(fp);
        for (const hit of hits) {
          const key = `${fp}:${hit.line}:${hit.column}`;
          if (defSites.has(key)) continue;
          allResults.push({
            filePath: fp,
            line:     hit.line,
            column:   hit.column,
            offset:   hit.offset,
            lineText: lines[hit.line] ?? '',
          });
        }
      } catch { /* skip */ }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filePaths.length) }, worker)
  );

  allResults.sort((a, b) => {
    const fc = a.filePath.localeCompare(b.filePath);
    return fc !== 0 ? fc : a.line - b.line;
  });

  return allResults;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _lineCache = new Map<string, string[]>();

function readLinesSync(filePath: string): string[] {
  if (_lineCache.has(filePath)) return _lineCache.get(filePath)!;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    if (lines.length < 5000) _lineCache.set(filePath, lines);
    return lines;
  } catch { return []; }
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const range = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  return range ? document.getText(range) : undefined;
}