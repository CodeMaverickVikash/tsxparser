/**
 * goToDefinition.ts — Framework-Aware "Go To Definition" (WebStorm-parity)
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers command  codePilot.goToDefinition  and native DefinitionProvider
 *  • Framework-aware resolution: when in a React file, prefers React components
 *    and hooks; in Angular prefers services/components; in Vue prefers composables
 *  • JSX tag names resolve directly to the component definition file
 *  • Hook calls  useAuth()  resolve to the hook's declaration, not call sites
 *  • Import path strings resolve to the actual module file
 *  • Multiple candidates → Quick Pick showing file name + role + signature
 *
 * ─── Resolution priority (example: React file) ────────────────────────────────
 *
 *   1.  Exported React functional component  (same framework, exported)
 *   2.  Exported React class component
 *   3.  Exported React custom hook
 *   4.  Any other exported symbol in the project
 *   5.  Non-exported symbols (local only)
 *
 * ─── Quick Pick layout ────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  $(symbol-class)  Button                                            │
 *   │  React functional component  ·  src/components/Button.tsx  line 12 │
 *   │                                                                     │
 *   │  $(symbol-class)  Button                                            │
 *   │  React functional component  ·  src/ui/Button.tsx  line 5          │
 *   └─────────────────────────────────────────────────────────────────────┘
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import {
  resolveAtPosition,
  resolveSymbol,
  resolveImportPath,
  ResolvedSymbol,
}                  from './symbolResolver';
import { parseFile } from './astParser';
import { Framework } from './frameworkDetector';

// ─── Public registration ──────────────────────────────────────────────────────

export function registerGoToDefinition(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand(
    'codePilot.goToDefinition',
    goToDefinitionHandler
  );

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

  // ── Import path string? ───────────────────────────────────────────────────
  const importPath = tryExtractImportPath(document, position);
  if (importPath !== null) {
    const resolved = resolveImportPath(importPath, document.fileName);
    if (resolved) { await navigateTo(resolved, 0, 0); return; }
    vscode.window.showInformationMessage(
      `CodePilot: Cannot resolve module "${importPath}"`
    );
    return;
  }

  const results = resolveAtPosition(document, position, { maxFuzzy: 15 });

  if (results.length === 0) {
    const word = wordAt(document, position) ?? '(unknown)';
    vscode.window.showInformationMessage(
      `CodePilot: No definition found for "${word}"`
    );
    return;
  }

  if (results.length === 1) {
    const r = results[0];
    await navigateTo(r.filePath, r.line, r.column);
    return;
  }

  await pickAndNavigate(results, document.fileName);
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
        return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
      }
      return null;
    }

    const results = resolveAtPosition(document, position, {
      exactOnly: false,
      maxFuzzy:  5,
    });
    if (results.length === 0) return null;

    // Return framework-ranked results as DefinitionLinks (richer than Location)
    return results.map(r => {
      const targetUri  = vscode.Uri.file(r.filePath);
      const targetPos  = new vscode.Position(r.line, r.column);
      const targetRange = new vscode.Range(targetPos, targetPos);

      return {
        targetUri,
        targetRange,
        targetSelectionRange: targetRange,
      } as vscode.DefinitionLink;
    });
  }
}

// ─── Framework-aware Quick Pick ───────────────────────────────────────────────

interface DefinitionItem extends vscode.QuickPickItem {
  resolved: ResolvedSymbol;
}

async function pickAndNavigate(
  results:    ResolvedSymbol[],
  fromFile:   string
): Promise<void> {
  const callerFw = getFileFramework(fromFile);

  const items: DefinitionItem[] = results.map(r => {
    const rel      = vscode.workspace.asRelativePath(r.filePath);
    const lineNum  = r.line + 1;
    const sym      = r.symbol;

    // Icon based on symbol type
    const icon = symbolIcon(sym.type);

    // Primary label: icon + symbol name
    const label = `$(${icon})  ${sym.name}`;

    // Description: framework role label (e.g. "React functional component")
    const roleLabel   = r.rankReason ?? sym.type;
    const matchBadge  = r.matchKind !== 'exact' ? `  [${r.matchKind}]` : '';

    // Detail: file name  ·  line  (this appears below the label in VS Code)
    const detail = `${roleLabel}${matchBadge}  ·  ${rel}  line ${lineNum}`;

    return { label, description: detail, resolved: r };
  });

  // Add section separators for different frameworks when mixed results
  const hasMultiFramework = new Set(
    results.map(r => r.symbol.framework ?? 'unknown')
  ).size > 1;

  const picked = await vscode.window.showQuickPick(items, {
    title:              `Go To Definition${callerFw !== 'unknown' ? `  (${callerFw} context)` : ''}`,
    placeHolder:        'Select definition to navigate to…',
    matchOnDescription: true,
    matchOnDetail:      true,
  });

  if (!picked) return;
  const r = picked.resolved;
  await navigateTo(r.filePath, r.line, r.column);
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

// ─── Utilities ────────────────────────────────────────────────────────────────

function getFileFramework(filePath: string): Framework {
  try {
    const parsed = parseFile(filePath);
    return parsed.framework ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * If the cursor is inside an import path string, return the module specifier.
 * Returns null otherwise.
 */
function tryExtractImportPath(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;

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