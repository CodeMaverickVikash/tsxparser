import * as vscode from 'vscode';
import * as fs from 'fs';
import { getIndexer } from './projectIndexer';
import { findIdentifierOccurrencesInFile } from './symbolResolver';
import { analyzeUsages, UsageSummary } from './frameworkAnalyzer';
import { showUsagePanel } from './usagePanel';
import { FIND_CMD } from './smartHoverProvider';
import { detectWorkspaceFramework } from './frameworkWorkspace';

export interface UsageLocation {
  filePath: string;
  line: number;
  column: number;
  offset: number;
  lineText: string;
}

export function registerFindUsages(context: vscode.ExtensionContext): void {
  const smartCmd = vscode.commands.registerCommand(FIND_CMD, async (symbolName?: string) => {
    const editor = vscode.window.activeTextEditor;

    if (!symbolName) {
      if (!editor) {
        vscode.window.showWarningMessage('CodePilot: No active editor.');
        return;
      }
      const pos = editor.selection.active;
      const range = editor.document.getWordRangeAtPosition(pos, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
      symbolName = range ? editor.document.getText(range) : undefined;
    }

    if (!symbolName) {
      vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
      return;
    }

    await openUsagesPanel(context, symbolName, editor?.document.fileName);
  });

  const legacyCmd = vscode.commands.registerCommand('codePilot.findUsages', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('CodePilot: No active editor.');
      return;
    }

    const pos = editor.selection.active;
    const range = editor.document.getWordRangeAtPosition(pos, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
    const symbolName = range ? editor.document.getText(range) : undefined;
    if (!symbolName) {
      vscode.window.showInformationMessage('CodePilot: No symbol at cursor.');
      return;
    }

    await openUsagesPanel(context, symbolName, editor.document.fileName);
  });

  const selector: vscode.DocumentSelector = [
    { language: 'typescript' },
    { language: 'typescriptreact' },
    { language: 'javascript' },
    { language: 'javascriptreact' },
  ];

  const provider = vscode.languages.registerReferenceProvider(selector, new FindUsagesProvider());
  context.subscriptions.push(smartCmd, legacyCmd, provider);
}

export async function openUsagesPanel(
  context: vscode.ExtensionContext,
  symbolName: string,
  sourceFileName?: string
): Promise<void> {
  const indexer = getIndexer();
  const filePaths = Array.from(indexer.index.files.keys());

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `CodePilot: Analysing usages of "${symbolName}"...`,
      cancellable: false,
    },
    async () => {
      const summary = await analyzeUsages(symbolName, filePaths, 10);

      if (summary.totalCount === 0) {
        vscode.window.showInformationMessage(`CodePilot: No usages found for "${symbolName}".`);
        return;
      }

      showUsagePanel(
        context,
        summary,
        async (filePath, line, col) => {
          const uri = vscode.Uri.file(filePath);
          const pos = new vscode.Position(line, col);
          const range = new vscode.Range(pos, pos);
          const editor = await vscode.window.showTextDocument(uri, {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
          });
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(pos, pos);
        },
        preferredFramework(summary, sourceFileName)
      );
    }
  );
}

class FindUsagesProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[]> {
    const symbolName = wordAt(document, position);
    if (!symbolName) {
      return [];
    }

    const usages = await findAllUsages(symbolName);
    return usages.map(
      usage =>
        new vscode.Location(
          vscode.Uri.file(usage.filePath),
          new vscode.Position(usage.line, usage.column)
        )
    );
  }
}

export async function findAllUsages(
  symbolName: string,
  opts: {
    includeDefinitions?: boolean;
    concurrency?: number;
    framework?: 'react' | 'angular' | 'vue' | 'generic' | 'all';
  } = {}
): Promise<UsageLocation[]> {
  const framework = opts.framework ?? 'all';

  if (framework !== 'all') {
    const summary = await analyzeUsages(symbolName, Array.from(getIndexer().index.files.keys()), opts.concurrency ?? 8);
    const usages = summary.byFramework.get(framework) ?? [];
    return usages.map(usage => ({
      filePath: usage.filePath,
      line: usage.line,
      column: usage.column,
      offset: usage.offset,
      lineText: usage.lineText,
    }));
  }

  const indexer = getIndexer();
  const filePaths = Array.from(indexer.index.files.keys());
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
        const hits = findIdentifierOccurrencesInFile(fp, symbolName);
        const lines = readLinesSync(fp);
        for (const hit of hits) {
          const key = `${fp}:${hit.line}:${hit.column}`;
          if (defSites.has(key)) {
            continue;
          }
          allResults.push({
            filePath: fp,
            line: hit.line,
            column: hit.column,
            offset: hit.offset,
            lineText: lines[hit.line] ?? '',
          });
        }
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, filePaths.length) }, worker));

  allResults.sort((a, b) => {
    const fileCompare = a.filePath.localeCompare(b.filePath);
    return fileCompare !== 0 ? fileCompare : a.line - b.line;
  });

  return allResults;
}

const _lineCache = new Map<string, string[]>();

function readLinesSync(filePath: string): string[] {
  if (_lineCache.has(filePath)) {
    return _lineCache.get(filePath)!;
  }

  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    if (lines.length < 5000) {
      _lineCache.set(filePath, lines);
    }
    return lines;
  } catch {
    return [];
  }
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const range = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  return range ? document.getText(range) : undefined;
}

function preferredFramework(
  summary: UsageSummary,
  sourceFileName?: string
): 'all' | 'react' | 'angular' | 'vue' | 'generic' {
  const detected = detectWorkspaceFramework(sourceFileName);
  if (detected !== 'generic' && (summary.byFramework.get(detected)?.length ?? 0) > 0) {
    return detected;
  }
  return 'all';
}
