/**
 * goToDefinition.ts — WebStorm-parity "Go To Definition" for the TSX extension
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers VS Code command  codePilot.goToDefinition
 *  • Also registers as a DefinitionProvider so F12 / Ctrl+Click work natively
 *  • Extracts the word under the cursor
 *  • Resolves symbol via symbolResolver  (exact → CI → fuzzy)
 *  • Single result  → navigate immediately
 *  • Multiple results → show Quick Pick with file path + line number
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerGoToDefinition(context) inside activate().
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { resolveAtPosition, resolveSymbol, resolveImportPath, ResolvedSymbol } from './symbolResolver';

// ─── Public registration ──────────────────────────────────────────────────────

export function registerGoToDefinition(context: vscode.ExtensionContext): void {

  // ── Manual command ─────────────────────────────────────────────────────────
  const cmd = vscode.commands.registerCommand(
    'codePilot.goToDefinition',
    goToDefinitionHandler
  );

  // ── Native F12 / Ctrl+Click provider ──────────────────────────────────────
  const SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript'      },
    { language: 'typescriptreact' },
    { language: 'javascript'      },
    { language: 'javascriptreact' },
  ];

  const provider = vscode.languages.registerDefinitionProvider(
    SELECTOR,
    new GoToDefinitionProvider()
  );

  context.subscriptions.push(cmd, provider);
}

// ─── Command handler ──────────────────────────────────────────────────────────

async function goToDefinitionHandler(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodePilot: No active editor.');
    return;
  }

  const position = editor.selection.active;
  const document = editor.document;

  // ── Check if cursor is on an import path string ───────────────────────────
  const importPath = tryExtractImportPath(document, position);
  if (importPath !== null) {
    const resolved = resolveImportPath(importPath, document.fileName);
    if (resolved) {
      await navigateTo(resolved, 0, 0);
      return;
    }
    vscode.window.showInformationMessage(`CodePilot: Cannot resolve module "${importPath}"`);
    return;
  }

  // ── Resolve identifier under cursor ───────────────────────────────────────
  const results = resolveAtPosition(document, position, { maxFuzzy: 15 });

  if (results.length === 0) {
    const word = wordAt(document, position) ?? '(unknown)';
    vscode.window.showInformationMessage(`CodePilot: No definition found for "${word}"`);
    return;
  }

  if (results.length === 1) {
    const r = results[0];
    await navigateTo(r.filePath, r.line, r.column);
    return;
  }

  // ── Multiple results → Quick Pick ─────────────────────────────────────────
  await pickAndNavigate(results);
}

// ─── DefinitionProvider (F12 / Ctrl+Click) ───────────────────────────────────

class GoToDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | vscode.DefinitionLink[] | null {

    // Import path string?
    const importPath = tryExtractImportPath(document, position);
    if (importPath !== null) {
      const resolved = resolveImportPath(importPath, document.fileName);
      if (resolved) {
        const uri  = vscode.Uri.file(resolved);
        const pos  = new vscode.Position(0, 0);
        return new vscode.Location(uri, pos);
      }
      return null;
    }

    const results = resolveAtPosition(document, position, { exactOnly: false, maxFuzzy: 5 });
    if (results.length === 0) return null;

    return results.map(r => {
      const uri = vscode.Uri.file(r.filePath);
      const pos = new vscode.Position(r.line, r.column);
      return new vscode.Location(uri, pos);
    });
  }
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

async function navigateTo(
  filePath: string,
  line:     number,
  column:   number
): Promise<void> {
  const uri    = vscode.Uri.file(filePath);
  const pos    = new vscode.Position(line, column);
  const range  = new vscode.Range(pos, pos);
  const editor = await vscode.window.showTextDocument(uri, { preview: false });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

interface DefinitionItem extends vscode.QuickPickItem {
  resolved: ResolvedSymbol;
}

async function pickAndNavigate(results: ResolvedSymbol[]): Promise<void> {
  const items: DefinitionItem[] = results.map(r => {
    const rel  = vscode.workspace.asRelativePath(r.filePath);
    const line = r.line + 1;          // 1-based for display
    const col  = r.column + 1;

    return {
      label:       `$(${symbolIcon(r.symbol.type)})  ${r.symbol.name}`,
      description: r.symbol.detail ?? r.symbol.type,
      detail:      `${rel}  ·  line ${line}, col ${col}  [${r.matchKind}]`,
      resolved:    r,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title:           'Go To Definition',
    placeHolder:     'Select a definition to navigate to',
    matchOnDescription: true,
    matchOnDetail:   true,
  });

  if (!picked) return;
  const r = picked.resolved;
  await navigateTo(r.filePath, r.line, r.column);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * If the cursor is inside an import string literal, return the module specifier.
 * Returns null otherwise.
 */
function tryExtractImportPath(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;

  // Match:  from '...'  |  require('...')  |  import('...')
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const start = line.indexOf(m[1], m.index);
      const end   = start + m[1].length;
      if (position.character >= start && position.character <= end) {
        return m[1];
      }
    }
  }

  return null;
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const range = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  return range ? document.getText(range) : undefined;
}

function symbolIcon(type: string): string {
  switch (type) {
    case 'function':  return 'symbol-function';
    case 'class':     return 'symbol-class';
    case 'method':    return 'symbol-method';
    case 'property':  return 'symbol-property';
    default:          return 'symbol-variable';
  }
}
