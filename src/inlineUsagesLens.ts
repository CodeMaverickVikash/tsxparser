/**
 * inlineUsagesLens.ts — WebStorm-style "N usages" CodeLens
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Displays a clickable  "$(references) N usages"  hint above every symbol
 *    definition in the active JSX/TSX/TS/JS file.
 *  • Click → executes  editor.action.showReferences  which opens VS Code's
 *    native inline peek-references panel (the WebStorm-style floating popup)
 *    with every usage pre-loaded and clickable.
 *  • Usage counts are computed lazily (resolved per-lens) and memoised with a
 *    shared Promise cache so concurrent lenses never duplicate work.
 *  • Cache is invalidated whenever the project index changes.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerInlineUsagesLens(context) inside activate().
 */

import * as vscode from 'vscode';
import { getIndexer }    from './projectIndexer';
import { findAllUsages } from './findUsages';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMAND = 'frontendAI.showInlineUsages';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript'      },
  { language: 'typescriptreact' },
  { language: 'javascript'      },
  { language: 'javascriptreact' },
];

// ─── Shared promise cache (symbolName → usage count) ─────────────────────────

const _countCache = new Map<string, Promise<number>>();

function getCachedCount(symbolName: string): Promise<number> {
  if (!_countCache.has(symbolName)) {
    const p = findAllUsages(symbolName).then(u => u.length);
    _countCache.set(symbolName, p);
  }
  return _countCache.get(symbolName)!;
}

// ─── CodeLens subclass that carries symbol metadata ───────────────────────────

class SymbolCodeLens extends vscode.CodeLens {
  constructor(
    range:                    vscode.Range,
    public readonly symName:  string,
    public readonly docUri:   vscode.Uri,
  ) {
    super(range);
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

class InlineUsagesLensProvider implements vscode.CodeLensProvider {

  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._emitter.event;

  /** Clear cache + re-query all lenses (called on index change). */
  refresh(): void {
    _countCache.clear();
    this._emitter.fire();
  }

  // ── Step 1: emit one lens per definition in the file ─────────────────────

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const symbols = getIndexer().getSymbolsInFile(document.fileName);
    return symbols.map(sym => {
      const pos   = new vscode.Position(sym.location.line, sym.location.column);
      const range = new vscode.Range(pos, pos);
      return new SymbolCodeLens(range, sym.name, document.uri);
    });
  }

  // ── Step 2: resolve the command (fills in count + navigation args) ────────

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const symLens = lens as SymbolCodeLens;
    const count   = await getCachedCount(symLens.symName);

    const label = count === 0
      ? `$(circle-slash) No usages`
      : `$(references) ${count} usage${count !== 1 ? 's' : ''}`;

    lens.command = {
      title:     label,
      command:   COMMAND,
      tooltip:   `Show all usages of "${symLens.symName}"`,
      arguments: [symLens.docUri, lens.range.start, symLens.symName],
    };

    return lens;
  }
}

// ─── Public registration ──────────────────────────────────────────────────────

export function registerInlineUsagesLens(context: vscode.ExtensionContext): void {

  const provider = new InlineUsagesLensProvider();

  // ── Register CodeLens provider ────────────────────────────────────────────
  const lensReg = vscode.languages.registerCodeLensProvider(SELECTOR, provider);

  // ── Command: smart-route by usage count ──────────────────────────────────
  //    0 usages  → info message
  //    1 usage   → navigate directly (no panel)
  //    2+ usages → open VS Code peek-references panel
  const showCmd = vscode.commands.registerCommand(
    COMMAND,
    async (uri: vscode.Uri, position: vscode.Position, symbolName: string) => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Finding usages of "${symbolName}"…` },
        async () => {
          const usages    = await findAllUsages(symbolName);
          const locations = usages.map(u =>
            new vscode.Location(
              vscode.Uri.file(u.filePath),
              new vscode.Position(u.line, u.column),
            )
          );

          if (locations.length === 0) {
            vscode.window.showInformationMessage(
              `frontendAI: No usages found for "${symbolName}".`
            );
            return;
          }

          if (locations.length === 1) {
            // Single usage — jump straight there, no panel needed.
            const loc    = locations[0];
            const editor = await vscode.window.showTextDocument(loc.uri, { preview: false });
            editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
            return;
          }

          // Multiple usages — open the inline peek-references panel.
          await vscode.commands.executeCommand(
            'editor.action.showReferences',
            uri,
            position,
            locations,
          );
        }
      );
    }
  );

  // ── Invalidate cache when index is updated ────────────────────────────────
  const onIndexChange = getIndexer().onDidChangeIndex(() => provider.refresh());

  context.subscriptions.push(lensReg, showCmd, onIndexChange);
}

