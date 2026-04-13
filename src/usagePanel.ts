import * as vscode from 'vscode';
import { UsageSummary, KIND_LABELS, KIND_ICONS } from './frameworkAnalyzer';

let _panel: vscode.WebviewPanel | undefined;
let _messageSub: vscode.Disposable | undefined;

export function showUsagePanel(
  _context: vscode.ExtensionContext,
  summary: UsageSummary,
  onNavigate: (filePath: string, line: number, col: number) => void,
  initialFramework: 'all' | 'react' | 'angular' | 'vue' | 'generic' = 'all'
): void {
  const title = `Usages of \`${summary.symbolName}\``;

  if (_panel) {
    _panel.title = title;
    _panel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    _panel = vscode.window.createWebviewPanel(
      'codePilotUsages',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    _panel.onDidDispose(() => {
      _panel = undefined;
      _messageSub?.dispose();
      _messageSub = undefined;
    });
  }

  _panel.webview.html = buildHtml(summary, initialFramework);

  _messageSub?.dispose();
  _messageSub = _panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'navigate') {
      onNavigate(msg.filePath, msg.line, msg.col);
    }
  });
}

function buildHtml(
  summary: UsageSummary,
  initialFramework: 'all' | 'react' | 'angular' | 'vue' | 'generic'
): string {
  const nonce = getNonce();
  const allUsagesJson = JSON.stringify(
    Array.from(summary.byKind.entries()).flatMap(([kind, usages]) =>
      usages.map(usage => ({
        kind,
        kindLabel: usage.kindLabel,
        filePath: usage.filePath,
        line: usage.line,
        col: usage.column,
        lineText: usage.lineText,
        context: usage.context,
        framework: usage.framework,
      }))
    )
  );

  const frameworkOptions = [
    ['all', `All (${summary.totalCount})`],
    ['react', `React (${summary.byFramework.get('react')?.length ?? 0})`],
    ['angular', `Angular (${summary.byFramework.get('angular')?.length ?? 0})`],
    ['vue', `Vue (${summary.byFramework.get('vue')?.length ?? 0})`],
    ['generic', `Generic (${summary.byFramework.get('generic')?.length ?? 0})`],
  ]
    .filter(([framework]) => framework === 'all' || (summary.byFramework.get(framework as 'react' | 'angular' | 'vue' | 'generic')?.length ?? 0) > 0)
    .map(
      ([framework, label]) =>
        `<option value="${framework}" ${initialFramework === framework ? 'selected' : ''}>${label}</option>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-editor-background, #101418);
    --panel: var(--vscode-editorWidget-background, #172028);
    --panel-2: var(--vscode-sideBar-background, #1d2933);
    --border: var(--vscode-widget-border, #31404d);
    --text: var(--vscode-editor-foreground, #d7e1e8);
    --muted: var(--vscode-descriptionForeground, #8ea1b1);
    --accent: var(--vscode-textLink-foreground, #58a6ff);
    --hover: var(--vscode-list-hoverBackground, #24313c);
    --mono: var(--vscode-editor-font-family, Consolas, monospace);
    --ui: var(--vscode-font-family, Segoe UI, sans-serif);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%);
    color: var(--text);
    font-family: var(--ui);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    background: rgba(23, 32, 40, 0.95);
  }
  .title-row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 10px;
  }
  .symbol {
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 700;
    color: var(--accent);
  }
  .count {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
  }
  .controls {
    display: grid;
    grid-template-columns: minmax(140px, 220px) 1fr;
    gap: 10px;
  }
  .select, .search {
    width: 100%;
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 16px 0;
  }
  .pill {
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    border-radius: 999px;
    padding: 5px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .pill.active {
    background: var(--accent);
    color: #081018;
    border-color: var(--accent);
    font-weight: 700;
  }
  .results {
    flex: 1;
    overflow: auto;
    padding: 12px 0 16px;
  }
  .section {
    margin-bottom: 14px;
  }
  .section-header {
    padding: 0 16px 8px;
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .row {
    padding: 10px 16px;
    border-top: 1px solid rgba(49, 64, 77, 0.45);
    cursor: pointer;
  }
  .row:hover { background: var(--hover); }
  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 4px;
    font-size: 11px;
  }
  .kind {
    color: var(--accent);
    font-weight: 700;
  }
  .context {
    color: var(--muted);
    font-style: italic;
  }
  .line {
    margin-left: auto;
    color: var(--muted);
    font-family: var(--mono);
  }
  .code {
    font-family: var(--mono);
    font-size: 12px;
    margin-bottom: 5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-url {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 40px 16px;
    color: var(--muted);
    text-align: center;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <div class="symbol">${escapeHtml(summary.symbolName)}</div>
      <div class="count">${summary.totalCount} usages</div>
    </div>
    <div class="controls">
      <select id="frameworkSelect" class="select">${frameworkOptions}</select>
      <input id="searchInput" class="search" type="text" placeholder="Filter by file, kind, context, or code" />
    </div>
  </div>
  <div id="pills" class="pills"></div>
  <div id="results" class="results"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const ALL_USAGES = ${allUsagesJson};
const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
const KIND_ICONS = ${JSON.stringify(KIND_ICONS)};

let activeFramework = ${JSON.stringify(initialFramework)};
let activeKind = 'all';
let activeSearch = '';

document.getElementById('frameworkSelect').addEventListener('change', event => {
  activeFramework = event.target.value;
  renderPills();
  renderResults();
});

document.getElementById('searchInput').addEventListener('input', event => {
  activeSearch = event.target.value.toLowerCase();
  renderResults();
});

function filteredUsages() {
  return ALL_USAGES.filter(usage => {
    if (activeFramework !== 'all' && usage.framework !== activeFramework) {
      return false;
    }
    if (activeKind !== 'all' && usage.kind !== activeKind) {
      return false;
    }
    if (!activeSearch) {
      return true;
    }

    return [
      usage.filePath,
      usage.kindLabel,
      usage.context || '',
      usage.lineText,
      toFileUrl(usage.filePath, usage.line + 1),
    ].some(value => String(value).toLowerCase().includes(activeSearch));
  });
}

function renderPills() {
  const container = document.getElementById('pills');
  const usages = filteredUsagesIgnoringKind();
  const counts = new Map();

  for (const usage of usages) {
    counts.set(usage.kind, (counts.get(usage.kind) || 0) + 1);
  }

  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const allCount = usages.length;

  container.innerHTML =
    '<button class="pill ' + (activeKind === 'all' ? 'active' : '') + '" onclick="setKind(\\'all\\')">All ' + allCount + '</button>' +
    entries.map(([kind, count]) =>
      '<button class="pill ' + (activeKind === kind ? 'active' : '') + '" onclick="setKind(' + JSON.stringify(kind) + ')">' +
      escapeHtml((KIND_ICONS[kind] || '') + ' ' + (KIND_LABELS[kind] || kind) + ' ' + count) +
      '</button>'
    ).join('');
}

function filteredUsagesIgnoringKind() {
  return ALL_USAGES.filter(usage => activeFramework === 'all' || usage.framework === activeFramework);
}

function setKind(kind) {
  activeKind = kind;
  renderPills();
  renderResults();
}

function renderResults() {
  const results = filteredUsages();
  const root = document.getElementById('results');

  if (results.length === 0) {
    root.innerHTML = '<div class="empty">No usages match the current framework or search.</div>';
    return;
  }

  const grouped = new Map();
  for (const usage of results) {
    if (!grouped.has(usage.kind)) {
      grouped.set(usage.kind, []);
    }
    grouped.get(usage.kind).push(usage);
  }

  root.innerHTML = Array.from(grouped.entries()).map(([kind, usages]) => {
    return '<div class="section">' +
      '<div class="section-header">' + escapeHtml((KIND_ICONS[kind] || '') + ' ' + (KIND_LABELS[kind] || kind) + ' (' + usages.length + ')') + '</div>' +
      usages.map(usage => {
        const fileUrl = toFileUrl(usage.filePath, usage.line + 1);
        return '<div class="row" onclick="navigate(' + JSON.stringify(usage.filePath) + ',' + usage.line + ',' + usage.col + ')">' +
          '<div class="meta">' +
          '<span class="kind">' + escapeHtml(usage.kindLabel) + '</span>' +
          (usage.context ? '<span class="context">' + escapeHtml(usage.context) + '</span>' : '') +
          '<span class="line">:' + (usage.line + 1) + '</span>' +
          '</div>' +
          '<div class="code">' + highlight(usage.lineText) + '</div>' +
          '<div class="file-url">' + escapeHtml(fileUrl) + '</div>' +
          '</div>';
      }).join('') +
      '</div>';
  }).join('');
}

function navigate(filePath, line, col) {
  vscode.postMessage({ type: 'navigate', filePath, line, col });
}

function toFileUrl(filePath, lineNumber) {
  const normalized = String(filePath).replace(/\\\\/g, '/');
  return 'file:///' + normalized.replace(/^([A-Za-z]):/, '$1:') + '#L' + lineNumber;
}

function highlight(text) {
  return escapeHtml(String(text).trim().slice(0, 220));
}

function escapeHtml(text) {
  return String(text).replace(/[<>&"]/g, char =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : '&quot;'
  );
}

renderPills();
renderResults();
</script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, char =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : '&quot;'
  );
}
