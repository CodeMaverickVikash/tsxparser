import * as vscode from 'vscode';
import { getIndexer } from './projectIndexer';
import { findAllUsages, openUsagesPanel } from './findUsages';
import { detectWorkspaceFramework } from './frameworkWorkspace';

const COMMAND = 'codePilot.showInlineUsages';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript' },
  { language: 'typescriptreact' },
  { language: 'javascript' },
  { language: 'javascriptreact' },
];

const _countCache = new Map<string, Promise<number>>();

function cacheKey(symbolName: string, framework: 'react' | 'angular' | 'vue' | 'generic' | 'all'): string {
  return `${framework}::${symbolName}`;
}

function getCachedCount(
  symbolName: string,
  framework: 'react' | 'angular' | 'vue' | 'generic' | 'all'
): Promise<number> {
  const key = cacheKey(symbolName, framework);
  if (!_countCache.has(key)) {
    _countCache.set(key, findAllUsages(symbolName, { framework }).then(usages => usages.length));
  }
  return _countCache.get(key)!;
}

class SymbolCodeLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    public readonly symName: string,
    public readonly docUri: vscode.Uri
  ) {
    super(range);
  }
}

class InlineUsagesLensProvider implements vscode.CodeLensProvider {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._emitter.event;

  refresh(): void {
    _countCache.clear();
    this._emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return getIndexer().getSymbolsInFile(document.fileName).map(sym => {
      const pos = new vscode.Position(sym.location.line, sym.location.column);
      return new SymbolCodeLens(new vscode.Range(pos, pos), sym.name, document.uri);
    });
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const symLens = lens as SymbolCodeLens;
    const workspaceFramework = detectWorkspaceFramework(symLens.docUri.fsPath);
    const scopedFramework = workspaceFramework === 'generic' ? 'all' : workspaceFramework;
    const count = await getCachedCount(symLens.symName, scopedFramework);

    lens.command = {
      title:
        count === 0
          ? '$(circle-slash) No usages'
          : `$(references) ${frameworkPrefix(scopedFramework)}${count} usage${count !== 1 ? 's' : ''}`,
      command: COMMAND,
      tooltip: `Show ${frameworkLabel(scopedFramework).toLowerCase()} usages of "${symLens.symName}"`,
      arguments: [symLens.docUri, symLens.symName],
    };

    return lens;
  }
}

export function registerInlineUsagesLens(context: vscode.ExtensionContext): void {
  const provider = new InlineUsagesLensProvider();

  const lensReg = vscode.languages.registerCodeLensProvider(SELECTOR, provider);
  const showCmd = vscode.commands.registerCommand(
    COMMAND,
    async (uri: vscode.Uri, symbolName: string) => {
      const framework = detectWorkspaceFramework(uri.fsPath);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Finding usages of "${symbolName}"...` },
        async () => {
          const usages = await findAllUsages(symbolName, {
            framework: framework === 'generic' ? 'all' : framework,
          });

          if (usages.length === 0) {
            vscode.window.showInformationMessage(`CodePilot: No usages found for "${symbolName}".`);
            return;
          }

          await openUsagesPanel(context, symbolName, uri.fsPath);
        }
      );
    }
  );

  const onIndexChange = getIndexer().onDidChangeIndex(() => provider.refresh());
  context.subscriptions.push(lensReg, showCmd, onIndexChange);
}

function frameworkLabel(framework: 'react' | 'angular' | 'vue' | 'generic' | 'all'): string {
  switch (framework) {
    case 'react':
      return 'React';
    case 'angular':
      return 'Angular';
    case 'vue':
      return 'Vue';
    case 'generic':
      return 'Generic';
    default:
      return 'All';
  }
}

function frameworkPrefix(framework: 'react' | 'angular' | 'vue' | 'generic' | 'all'): string {
  return framework === 'all' ? '' : `${frameworkLabel(framework)} `;
}
