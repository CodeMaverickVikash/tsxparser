import * as vscode from 'vscode';
import { getIndexer } from './projectIndexer';
import { Framework } from './frameworkDetector';

const FRAMEWORKS: Framework[] = ['react', 'angular', 'vue'];

export function registerFrameworkCommands(context: vscode.ExtensionContext): void {
  const statsCmd = vscode.commands.registerCommand(
    'codePilot.showFrameworkStats',
    async () => {
      const indexer = getIndexer();
      const stats = indexer.frameworkStats();

      const picked = await vscode.window.showQuickPick(
        FRAMEWORKS.map(framework => ({
          label: frameworkLabel(framework),
          description: `${stats[framework] ?? 0} indexed symbols`,
          framework,
        })),
        {
          title: 'CodePilot: Framework symbol stats',
          placeHolder: 'Pick a framework to inspect matching symbols',
        }
      );

      if (picked) {
        await vscode.commands.executeCommand('codePilot.findFrameworkSymbols', picked.framework);
      }
    }
  );

  const browseCmd = vscode.commands.registerCommand(
    'codePilot.findFrameworkSymbols',
    async (initialFramework?: Framework) => {
      const indexer = getIndexer();
      const stats = indexer.frameworkStats();

      let framework = initialFramework;
      if (!framework) {
        const picked = await vscode.window.showQuickPick(
          FRAMEWORKS.map(item => ({
            label: frameworkLabel(item),
            description: `${stats[item] ?? 0} indexed symbols`,
            framework: item,
          })),
          {
            title: 'CodePilot: Browse framework symbols',
            placeHolder: 'Choose a framework',
          }
        );
        framework = picked?.framework;
      }

      if (!framework) {
        return;
      }

      const symbols = indexer.searchByFramework(framework);
      if (symbols.length === 0) {
        vscode.window.showInformationMessage(
          `CodePilot: No indexed ${frameworkLabel(framework).toLowerCase()} symbols found yet.`
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        symbols.map(symbol => ({
          label: `$(${symbolIcon(symbol.type)}) ${symbol.name}`,
          description: symbol.frameworkTag?.label ?? symbol.detail ?? symbol.type,
          detail: `${vscode.workspace.asRelativePath(symbol.filePath)}:${symbol.location.line + 1}`,
          symbol,
        })),
        {
          title: `${frameworkLabel(framework)} symbols`,
          matchOnDescription: true,
          matchOnDetail: true,
          placeHolder: 'Open a symbol definition',
        }
      );

      if (!picked) {
        return;
      }

      const pos = new vscode.Position(picked.symbol.location.line, picked.symbol.location.column);
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(picked.symbol.filePath));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  );

  context.subscriptions.push(statsCmd, browseCmd);
}

function frameworkLabel(framework: Framework): string {
  switch (framework) {
    case 'react':
      return 'React';
    case 'angular':
      return 'Angular';
    case 'vue':
      return 'Vue';
    default:
      return framework;
  }
}

function symbolIcon(type: string): string {
  switch (type) {
    case 'function':
      return 'symbol-function';
    case 'class':
      return 'symbol-class';
    case 'method':
      return 'symbol-method';
    case 'property':
      return 'symbol-property';
    default:
      return 'symbol-variable';
  }
}
