import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type WorkspaceFramework = 'react' | 'angular' | 'vue' | 'generic';

const _frameworkCache = new Map<string, WorkspaceFramework>();

export function detectWorkspaceFramework(filePath?: string): WorkspaceFramework {
  const workspaceFolder = resolveWorkspaceFolder(filePath);
  if (!workspaceFolder) {
    return 'generic';
  }

  if (_frameworkCache.has(workspaceFolder)) {
    return _frameworkCache.get(workspaceFolder)!;
  }

  const framework = detectFromPackageJson(findNearestPackageJson(workspaceFolder));
  _frameworkCache.set(workspaceFolder, framework);
  return framework;
}

export function clearWorkspaceFrameworkCache(): void {
  _frameworkCache.clear();
}

function resolveWorkspaceFolder(filePath?: string): string | undefined {
  if (filePath) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (folder) {
      return folder.uri.fsPath;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function findNearestPackageJson(startPath: string): string | undefined {
  let current = startPath;

  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function detectFromPackageJson(packageJsonPath?: string): WorkspaceFramework {
  if (!packageJsonPath) {
    return 'generic';
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const deps = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.peerDependencies,
    };
    const names = Object.keys(deps);

    if (names.some(name => name === '@angular/core' || name.startsWith('@angular/'))) {
      return 'angular';
    }
    if (names.some(name => name === 'vue' || name.startsWith('@vue/') || name === 'nuxt')) {
      return 'vue';
    }
    if (names.some(name => name === 'react' || name === 'react-dom' || name === 'next')) {
      return 'react';
    }
  } catch {
    return 'generic';
  }

  return 'generic';
}
