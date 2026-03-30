/**
 * findUsages.ts — WebStorm-parity "Find All Usages" for the TSX extension
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers VS Code command  codePilot.findUsages
 *  • Also registers as a ReferenceProvider so Shift+F12 works natively
 *  • Finds ALL identifier / JSX-tag usages of the symbol under cursor
 *  • Scans every indexed file's AST — not just a text search
 *  • Groups results by file in the VS Code References panel
 *  • Shows a filterable Quick Pick as a fallback / on-demand panel
 *
 * ─── Algorithm ────────────────────────────────────────────────────────────────
 *
 *  1. Resolve the symbol name at the cursor position.
 *  2. Scan all files in the project index concurrently.
 *  3. Inside each file, walk the full AST and collect every Identifier node
 *     (and JSX tag name node) whose text matches the symbol name.
 *  4. Exclude definition sites from the results (optional — toggle via opts).
 *  5. Stream results into VS Code's native References UI via provideReferences.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerFindUsages(context) inside activate().
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as ts     from 'typescript';
import * as fs     from 'fs';
import { getIndexer }                      from './projectIndexer';
import { findIdentifierOccurrencesInFile } from './symbolResolver';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface UsageLocation {
  filePath: string;
  line:     number;   // 0-based
  column:   number;   // 0-based
  offset:   number;
  /** The full source line text (for preview) */
  lineText: string;
}

// ─── Public registration ──────────────────────────────────────────────────────

export function registerFindUsages(context: vscode.ExtensionContext): void {

  // ── Manual command ─────────────────────────────────────────────────────────
  const cmd = vscode.commands.registerCommand(
    'codePilot.findUsages',
    findUsagesHandler
  );

  // ── Native Shift+F12 / "Find All References" ───────────────────────────────
  const SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript'       },
    { language: 'typescriptreact'  },
    { language: 'javascript'       },
    { language: 'javascriptreact'  },
  ];

  const provider = vscode.languages.registerReferenceProvider(
    SELECTOR,
    new FindUsagesProvider()
  );

  context.subscriptions.push(cmd, provider);
}

// ─── Command handler ──────────────────────────────────────────────────────────

async function findUsagesHandler(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodePilot: No active editor.');
    return;
  }

  const position = editor.selection.active;
  const document = editor.document;

  // Resolve symbol name under cursor
  const symbolName = wordAt(document, position);

  if (!symbolName) {
    vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:    `CodePilot: Searching usages of "${symbolName}"…`,
      cancellable: false,
    },
    async () => {
      const usages = await findAllUsages(symbolName);

      if (usages.length === 0) {
        vscode.window.showInformationMessage(
          `CodePilot: No usages found for "${symbolName}".`
        );
        return;
      }

      // Show as Quick Pick panel with file grouping
      await showUsagesPanel(symbolName, usages);
    }
  );
}

// ─── ReferenceProvider (Shift+F12) ───────────────────────────────────────────

class FindUsagesProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document:  vscode.TextDocument,
    position:  vscode.Position,
    _ctx:      vscode.ReferenceContext,
  ): Promise<vscode.Location[]> {

    const symbolName = wordAt(document, position);
    if (!symbolName) return [];

    const usages = await findAllUsages(symbolName);
    return usages.map(u => {
      const uri = vscode.Uri.file(u.filePath);
      const pos = new vscode.Position(u.line, u.column);
      return new vscode.Location(uri, pos);
    });
  }
}

// ─── Core search engine ───────────────────────────────────────────────────────

/**
 * Scan every file tracked by the project indexer and collect all usages
 * of `symbolName`.
 *
 * Runs file scans with bounded concurrency to avoid blocking the event loop.
 */
export async function findAllUsages(
  symbolName: string,
  opts: {
    /** If true, also include the definition sites themselves. Default false. */
    includeDefinitions?: boolean;
    /** Max concurrent file scans. Default 8. */
    concurrency?: number;
  } = {}
): Promise<UsageLocation[]> {
  const indexer     = getIndexer();
  const filePaths   = Array.from(indexer.index.files.keys());
  const concurrency = opts.concurrency ?? 8;

  // Definition sites to optionally exclude
  const defSites = new Set<string>();
  if (!opts.includeDefinitions) {
    for (const sym of indexer.getSymbolExact(symbolName)) {
      defSites.add(`${sym.filePath}:${sym.location.line}:${sym.location.column}`);
    }
  }

  const allResults: UsageLocation[] = [];

  // Batched concurrent processing
  let i = 0;
  const worker = async () => {
    while (i < filePaths.length) {
      const fp = filePaths[i++];
      try {
        const hits = findIdentifierOccurrencesInFile(fp, symbolName);
        const lines = readLinesSync(fp);

        for (const hit of hits) {
          const key = `${fp}:${hit.line}:${hit.column}`;
          if (defSites.has(key)) continue;          // skip definition site
          allResults.push({
            filePath: fp,
            line:     hit.line,
            column:   hit.column,
            offset:   hit.offset,
            lineText: lines[hit.line] ?? '',
          });
        }
      } catch { /* unreadable file — skip */ }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filePaths.length) }, worker)
  );

  // Sort: by file path, then by line
  allResults.sort((a, b) => {
    const fc = a.filePath.localeCompare(b.filePath);
    return fc !== 0 ? fc : a.line - b.line;
  });

  return allResults;
}

// ─── Results panel ────────────────────────────────────────────────────────────

interface UsageItem extends vscode.QuickPickItem {
  filePath?: string;
  line?:     number;
  column?:   number;
}

async function showUsagesPanel(
  symbolName: string,
  usages:     UsageLocation[]
): Promise<void> {
  // Group by file
  const byFile = new Map<string, UsageLocation[]>();
  for (const u of usages) {
    const arr = byFile.get(u.filePath);
    if (arr) arr.push(u); else byFile.set(u.filePath, [u]);
  }

  const items: UsageItem[] = [];

  for (const [fp, fileUsages] of byFile) {
    const rel = vscode.workspace.asRelativePath(fp);

    // File header (separator)
    items.push({
      label:       `$(file-code)  ${rel}`,
      description: `${fileUsages.length} usage${fileUsages.length !== 1 ? 's' : ''}`,
      kind:        vscode.QuickPickItemKind.Separator,
    });

    for (const u of fileUsages) {
      const lineNum = u.line + 1;   // 1-based for display
      const preview = u.lineText.trim().slice(0, 120);

      items.push({
        label:       `  $(circle-small)  ${lineNum}: ${preview}`,
        description: `col ${u.column + 1}`,
        detail:      rel,
        filePath:    u.filePath,
        line:        u.line,
        column:      u.column,
      });
    }
  }

  const qp = vscode.window.createQuickPick<UsageItem>();
  qp.title       = `Usages of "${symbolName}" — ${usages.length} result${usages.length !== 1 ? 's' : ''}`;
  qp.placeholder = 'Filter usages…';
  qp.items       = items;
  qp.matchOnDescription = true;
  qp.matchOnDetail      = true;

  // Live preview on highlight
  qp.onDidChangeActive(active => {
    const item = active[0];
    if (item?.filePath != null && item.line != null) {
      peekAt(item.filePath, item.line, item.column ?? 0);
    }
  });

  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item?.filePath != null && item.line != null) {
      navigateTo(item.filePath, item.line, item.column ?? 0);
    }
    qp.hide();
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ─── Navigation / preview ─────────────────────────────────────────────────────

async function navigateTo(filePath: string, line: number, column: number): Promise<void> {
  const uri    = vscode.Uri.file(filePath);
  const pos    = new vscode.Position(line, column);
  const range  = new vscode.Range(pos, pos);
  const editor = await vscode.window.showTextDocument(uri, { preview: false });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

async function peekAt(filePath: string, line: number, column: number): Promise<void> {
  const uri   = vscode.Uri.file(filePath);
  const pos   = new vscode.Position(line, column);
  const range = new vscode.Range(pos, pos);
  // Open in preview tab so it doesn't pollute the editor stack
  try {
    const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch { /* file may have been deleted */ }
}

// ─── File line cache ──────────────────────────────────────────────────────────

const _lineCache = new Map<string, string[]>();

function readLinesSync(filePath: string): string[] {
  if (_lineCache.has(filePath)) return _lineCache.get(filePath)!;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    // Only cache modest-sized files
    if (lines.length < 5000) _lineCache.set(filePath, lines);
    return lines;
  } catch {
    return [];
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const range = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  return range ? document.getText(range) : undefined;
}
