/**
 * findUsages.ts — Framework-Aware "Find All Usages" (WebStorm-parity)
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers command  codePilot.findUsages  and native ReferenceProvider
 *  • Finds ALL usages of the symbol under cursor across the project
 *  • Groups results by semantic kind (JSX usage / hook call / import / call / …)
 *  • Framework-aware filtering: when in a React file, JSX usages + hook calls
 *    surface first; Angular component usages surface in Angular files, etc.
 *  • Quick Pick layout:  FILE NAME header  →  preview lines beneath it
 *    (matches WebStorm's "Find Usages" panel layout exactly)
 *
 * ─── Quick Pick layout ────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  $(file-code)  src/components/Button.tsx  · 3 usages           │  ← file header
 *   │    $(symbol-misc)  42:  <Button onClick={...} />               │  ← JSX usage
 *   │    $(symbol-misc)  87:  const btn = <Button />                 │  ← JSX usage
 *   │    $(references)   12:  import { Button } from './Button'      │  ← import
 *   │  $(file-code)  src/pages/Home.tsx  · 1 usage                  │  ← file header
 *   │    $(symbol-event) 33:  const [state] = useState(...)          │  ← hook call
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerFindUsages(context) inside activate().
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import {
  getIndexer,
}                                              from './projectIndexer';
import {
  findIdentifierOccurrencesInFile,
  OccurrenceLocation,
  OccurrenceKind,
  classifyOccurrenceNode,
}                                              from './symbolResolver';
import { parseFile }                           from './astParser';
import { Framework }                           from './frameworkDetector';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface UsageLocation {
  filePath:  string;
  line:      number;   // 0-based
  column:    number;   // 0-based
  offset:    number;
  lineText:  string;
  kind:      OccurrenceKind;
}

// ─── Kind metadata ────────────────────────────────────────────────────────────

const KIND_ICON: Record<OccurrenceKind, string> = {
  'definition':     '$(symbol-namespace)',
  'jsx-usage':      '$(symbol-misc)',
  'hook-call':      '$(symbol-event)',
  'import':         '$(references)',
  'export':         '$(export)',
  'call':           '$(symbol-method)',
  'type-reference': '$(symbol-interface)',
  'assignment':     '$(symbol-variable)',
  'reference':      '$(circle-small)',
};

const KIND_LABEL: Record<OccurrenceKind, string> = {
  'definition':     'definition',
  'jsx-usage':      'JSX',
  'hook-call':      'hook call',
  'import':         'import',
  'export':         'export',
  'call':           'call',
  'type-reference': 'type',
  'assignment':     'assignment',
  'reference':      'reference',
};

/**
 * Priority for sorting occurrences within a single file.
 * Lower number = shown first (more important).
 */
const KIND_PRIORITY: Record<OccurrenceKind, number> = {
  'definition':     0,
  'import':         1,
  'jsx-usage':      2,
  'hook-call':      3,
  'call':           4,
  'export':         5,
  'type-reference': 6,
  'assignment':     7,
  'reference':      8,
};

// ─── Public registration ──────────────────────────────────────────────────────

export function registerFindUsages(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand(
    'codePilot.findUsages',
    findUsagesHandler
  );

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

  context.subscriptions.push(cmd, provider);
}

// ─── Command handler ──────────────────────────────────────────────────────────

async function findUsagesHandler(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodePilot: No active editor.');
    return;
  }

  const position   = editor.selection.active;
  const document   = editor.document;
  const symbolName = wordAt(document, position);
  if (!symbolName) {
    vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
    return;
  }

  const callerFramework = getFileFramework(document.fileName);

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Notification,
      title:       `CodePilot: Searching usages of "${symbolName}"…`,
      cancellable: false,
    },
    async () => {
      const usages = await findAllUsages(symbolName, {
        callerFramework,
        callerFile: document.fileName,
      });

      if (usages.length === 0) {
        vscode.window.showInformationMessage(
          `CodePilot: No usages found for "${symbolName}".`
        );
        return;
      }

      await showUsagesPanel(symbolName, usages, callerFramework);
    }
  );
}

// ─── ReferenceProvider (Shift+F12) ───────────────────────────────────────────

class FindUsagesProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[]> {
    const symbolName = wordAt(document, position);
    if (!symbolName) return [];

    const callerFramework = getFileFramework(document.fileName);
    const usages = await findAllUsages(symbolName, {
      callerFramework,
      callerFile: document.fileName,
    });

    return usages.map(u =>
      new vscode.Location(
        vscode.Uri.file(u.filePath),
        new vscode.Position(u.line, u.column),
      )
    );
  }
}

// ─── Core search engine ───────────────────────────────────────────────────────

export interface FindUsagesOptions {
  includeDefinitions?: boolean;
  concurrency?:        number;
  /** Framework of the file that triggered the search */
  callerFramework?:    Framework;
  callerFile?:         string;
}

/**
 * Framework-aware project-wide usage scan.
 *
 * Sorting strategy:
 *  1. Definition sites always first (if includeDefinitions = true)
 *  2. Within a framework match: JSX usages > hook calls > plain calls > …
 *  3. Files that share the caller's framework surface before cross-framework files
 *  4. Within each file: sorted by occurrence kind priority, then line number
 */
export async function findAllUsages(
  symbolName: string,
  opts:       FindUsagesOptions = {}
): Promise<UsageLocation[]> {
  const indexer      = getIndexer();
  const filePaths    = Array.from(indexer.index.files.keys());
  const concurrency  = opts.concurrency ?? 8;
  const callerFw     = opts.callerFramework ?? 'unknown';
  const callerFile   = opts.callerFile ? path.resolve(opts.callerFile) : undefined;

  // Definition sites to optionally exclude
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
            kind:     hit.kind,
          });
        }
      } catch { /* unreadable — skip */ }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, filePaths.length) }, worker)
  );

  // ── Framework-aware sort ────────────────────────────────────────────────────
  return sortUsages(allResults, callerFw, callerFile);
}

// ─── Framework-aware sort ────────────────────────────────────────────────────

function getFileFramework(filePath: string): Framework {
  try {
    const parsed = parseFile(filePath);
    return parsed.framework ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function sortUsages(
  usages:      UsageLocation[],
  callerFw:    Framework,
  callerFile?: string
): UsageLocation[] {
  // Pre-compute per-file framework (cached map to avoid re-parsing)
  const fwCache = new Map<string, Framework>();
  const getFileFw = (fp: string): Framework => {
    if (!fwCache.has(fp)) fwCache.set(fp, getFileFramework(fp));
    return fwCache.get(fp)!;
  };

  // File-level sort key:
  //   0 = caller's own file  (always first)
  //   1 = same framework as caller
  //   2 = unknown / framework-agnostic
  //   3 = different framework
  const fileSortKey = (fp: string): number => {
    if (callerFile && fp === callerFile)     return 0;
    const fw = getFileFw(fp);
    if (fw === 'unknown')                    return 2;
    if (callerFw === 'unknown')              return 2;
    if (fw === callerFw)                     return 1;
    return 3;
  };

  return usages.sort((a, b) => {
    // First: file-level framework group
    const fsDiff = fileSortKey(a.filePath) - fileSortKey(b.filePath);
    if (fsDiff !== 0) return fsDiff;

    // Second: within same file, sort by file path alphabetically
    const fpDiff = a.filePath.localeCompare(b.filePath);
    if (fpDiff !== 0) return fpDiff;

    // Third: within same file, sort by kind priority
    const kindDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (kindDiff !== 0) return kindDiff;

    // Fourth: by line number
    return a.line - b.line;
  });
}

// ─── Quick Pick panel ─────────────────────────────────────────────────────────

interface UsageItem extends vscode.QuickPickItem {
  filePath?: string;
  line?:     number;
  column?:   number;
  isHeader?: boolean;
}

async function showUsagesPanel(
  symbolName:    string,
  usages:        UsageLocation[],
  callerFw:      Framework
): Promise<void> {

  // Group by file, preserving the already-sorted order
  const fileOrder: string[]                    = [];
  const byFile    = new Map<string, UsageLocation[]>();

  for (const u of usages) {
    if (!byFile.has(u.filePath)) {
      fileOrder.push(u.filePath);
      byFile.set(u.filePath, []);
    }
    byFile.get(u.filePath)!.push(u);
  }

  const items: UsageItem[] = [];

  for (const fp of fileOrder) {
    const fileUsages = byFile.get(fp)!;
    const rel        = vscode.workspace.asRelativePath(fp);
    const count      = fileUsages.length;
    const fileFw     = getFileFramework(fp);

    // ── File header ──────────────────────────────────────────────────────────
    // Format: $(file-code)  src/components/Button.tsx  · 3 usages  [React]
    const fwBadge = fileFw !== 'unknown' && fileFw !== callerFw
      ? `  [${fileFw}]`
      : '';

    items.push({
      label:       `$(file-code)  ${rel}`,
      description: `${count} usage${count !== 1 ? 's' : ''}${fwBadge}`,
      kind:        vscode.QuickPickItemKind.Separator,
      isHeader:    true,
    });

    // ── Usage lines under this file ──────────────────────────────────────────
    for (const u of fileUsages) {
      const lineNum  = u.line + 1;             // 1-based display
      const colNum   = u.column + 1;
      const icon     = KIND_ICON[u.kind];
      const kindLbl  = KIND_LABEL[u.kind];

      // Preview: trim leading whitespace, cap at 100 chars, highlight the symbol
      const rawPreview = u.lineText.trimStart();
      const preview    = rawPreview.length > 100
        ? rawPreview.slice(0, 100) + '…'
        : rawPreview;

      items.push({
        // Primary label: icon + line:col  kind  ·  code preview
        label:       `  ${icon}  ${lineNum}:${colNum}  $(tag) ${kindLbl}  ·  ${preview}`,
        description: '',
        filePath:    fp,
        line:        u.line,
        column:      u.column,
        isHeader:    false,
      });
    }
  }

  const total     = usages.length;
  const fileCount = fileOrder.length;

  const qp = vscode.window.createQuickPick<UsageItem>();
  qp.title       = `Usages of "${symbolName}" — ${total} result${total !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
  qp.placeholder = 'Filter by file name or code preview…';
  qp.items       = items;
  qp.matchOnDescription = true;
  qp.matchOnDetail      = true;

  // Live preview on highlight (navigate with preserveFocus)
  qp.onDidChangeActive(active => {
    const item = active[0];
    if (item?.filePath != null && item.line != null && !item.isHeader) {
      peekAt(item.filePath, item.line, item.column ?? 0);
    }
  });

  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item?.filePath != null && item.line != null && !item.isHeader) {
      navigateTo(item.filePath, item.line, item.column ?? 0);
    }
    qp.hide();
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigateTo(filePath: string, line: number, column: number): Promise<void> {
  const uri    = vscode.Uri.file(filePath);
  const pos    = new vscode.Position(line, column);
  const editor = await vscode.window.showTextDocument(uri, { preview: false });
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

async function peekAt(filePath: string, line: number, column: number): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const pos = new vscode.Position(line, column);
  try {
    const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch { /* file may have been deleted */ }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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