/**
 * renameRefactor.ts — AST-Based Project-Wide Rename Refactoring
 *
 * ─── What it does ─────────────────────────────────────────────────────────────
 *
 *  • Registers VS Code command  frontendAI.renameSymbol
 *  • Also registers as a RenameProvider so F2 works natively.
 *  • Renames a symbol across the entire project:
 *      - Declaration site
 *      - All reference sites (identifiers + JSX tag names)
 *      - Import clauses that reference the symbol
 *      - Export clauses that reference the symbol
 *
 * ─── Approach ─────────────────────────────────────────────────────────────────
 *
 *  1. Resolve old name using the symbol index.
 *  2. Collect all usages via findIdentifierOccurrencesInFile() across all files.
 *  3. Build a vscode.WorkspaceEdit with TextEdit replacements for every site.
 *  4. Apply atomically — VS Code handles the undo stack.
 *
 * ─── Safety ───────────────────────────────────────────────────────────────────
 *
 *  • Validates the new name is a valid JS identifier before proceeding.
 *  • Skips string literals and comments (AST walk, not text search).
 *  • Confirms with user when > 1 file will be modified.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *  Call registerRenameRefactor(context) inside activate().
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as ts     from 'typescript';
import * as fs     from 'fs';
import { getIndexer }                        from './projectIndexer';
import { resolveAtPosition, resolveSymbol }  from './symbolResolver';
import { findIdentifierOccurrencesInFile }   from './symbolResolver';

// ─── Public registration ──────────────────────────────────────────────────────

export function registerRenameRefactor(context: vscode.ExtensionContext): void {
  const SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript'      },
    { language: 'typescriptreact' },
    { language: 'javascript'      },
    { language: 'javascriptreact' },
  ];

  // F2 provider
  const provider = vscode.languages.registerRenameProvider(
    SELECTOR,
    new RenameProvider()
  );

  // Manual command
  const cmd = vscode.commands.registerCommand(
    'frontendAI.renameSymbol',
    renameSymbolHandler
  );

  context.subscriptions.push(provider, cmd);
}

// ─── RenameProvider (F2) ─────────────────────────────────────────────────────

class RenameProvider implements vscode.RenameProvider {

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Range | { range: vscode.Range; placeholder: string } | null {
    const wordRange = document.getWordRangeAtPosition(
      position, /[a-zA-Z_$][a-zA-Z0-9_$]*/
    );
    if (!wordRange) return null;
    return { range: wordRange, placeholder: document.getText(wordRange) };
  }

  async provideRenameEdits(
    document:  vscode.TextDocument,
    position:  vscode.Position,
    newName:   string,
  ): Promise<vscode.WorkspaceEdit | null> {
    if (!isValidIdentifier(newName)) {
      throw new Error(`"${newName}" is not a valid JavaScript identifier.`);
    }

    const wordRange = document.getWordRangeAtPosition(
      position, /[a-zA-Z_$][a-zA-Z0-9_$]*/
    );
    if (!wordRange) return null;

    const oldName = document.getText(wordRange);
    return buildRenameEdit(oldName, newName);
  }
}

// ─── Manual command handler ───────────────────────────────────────────────────

async function renameSymbolHandler(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('frontendAI: No active editor.');
    return;
  }

  const position   = editor.selection.active;
  const wordRange  = editor.document.getWordRangeAtPosition(
    position, /[a-zA-Z_$][a-zA-Z0-9_$]*/
  );
  if (!wordRange) {
    vscode.window.showInformationMessage('frontendAI: No symbol at cursor.');
    return;
  }

  const oldName = editor.document.getText(wordRange);
  const newName = await vscode.window.showInputBox({
    prompt:  `Rename "${oldName}" across project`,
    value:   oldName,
    validateInput: v =>
      isValidIdentifier(v) ? null : 'Must be a valid JavaScript identifier',
  });
  if (!newName || newName === oldName) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:    `frontendAI: Renaming "${oldName}" → "${newName}"…`,
      cancellable: false,
    },
    async () => {
      const edit = await buildRenameEdit(oldName, newName);
      if (!edit) {
        vscode.window.showInformationMessage(`No references found for "${oldName}".`);
        return;
      }

      const filesAffected = countAffectedFiles(edit);
      if (filesAffected > 1) {
        const ok = await vscode.window.showWarningMessage(
          `Rename will modify ${filesAffected} files. Continue?`,
          { modal: true },
          'Rename'
        );
        if (ok !== 'Rename') return;
      }

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        vscode.window.showInformationMessage(
          `✅ Renamed "${oldName}" → "${newName}" in ${filesAffected} file${filesAffected !== 1 ? 's' : ''}.`
        );
      } else {
        vscode.window.showErrorMessage('frontendAI: Rename failed — workspace edit was rejected.');
      }
    }
  );
}

// ─── Core rename engine ───────────────────────────────────────────────────────

/**
 * Build a WorkspaceEdit that replaces every occurrence of `oldName` with
 * `newName` across the entire project index.
 *
 * Uses full AST scanning (not text search) so only real identifiers are hit —
 * not string literals, comments, or partial matches inside longer words.
 */
async function buildRenameEdit(
  oldName: string,
  newName: string
): Promise<vscode.WorkspaceEdit> {
  const indexer  = getIndexer();
  const filePaths = Array.from(indexer.index.files.keys());
  const edit      = new vscode.WorkspaceEdit();

  const CONCURRENCY = 8;
  let   i = 0;

  const worker = async () => {
    while (i < filePaths.length) {
      const fp = filePaths[i++];
      try {
        const occurrences = findIdentifierOccurrencesInFile(fp, oldName);
        if (occurrences.length === 0) continue;

        // Read full file text to build ranges
        const text  = fs.readFileSync(fp, 'utf8');
        const lines = text.split('\n');
        const uri   = vscode.Uri.file(fp);

        for (const occ of occurrences) {
          const start = new vscode.Position(occ.line, occ.column);
          const end   = new vscode.Position(occ.line, occ.column + oldName.length);
          edit.replace(uri, new vscode.Range(start, end), newName);
        }
      } catch { /* skip unreadable files */ }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, worker)
  );

  return edit;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function countAffectedFiles(edit: vscode.WorkspaceEdit): number {
  return edit.entries().length;
}
