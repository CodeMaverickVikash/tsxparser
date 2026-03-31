/**
 * usagePanel.ts — WebStorm-style "Find Usages" Webview Panel
 *
 * Replaces VS Code's default reference list with a rich, categorised,
 * framework-aware panel that shows:
 *
 *  ┌─ usages of `useAuth`  ─────────────────────────────────────── 12 usages ─┐
 *  │  ⚛ JSX Render (3)          🪝 Hook Call (6)      📥 Import Only (3)      │
 *  │  ─────────────────────────────────────────────────────────────────────── │
 *  │  ⚛ JSX Render                                                            │
 *  │    src/pages/Dashboard.tsx · line 42                                     │
 *  │    › const { user } = useAuth()                                          │
 *  │  ...                                                                     │
 *  └──────────────────────────────────────────────────────────────────────────┘
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { UsageSummary, FrameworkUsage, KIND_LABELS, KIND_ICONS, UsageKind } from './frameworkAnalyzer';

// ─── Panel manager ────────────────────────────────────────────────────────────

let _panel: vscode.WebviewPanel | undefined;

export function showUsagePanel(
  context:     vscode.ExtensionContext,
  summary:     UsageSummary,
  onNavigate:  (filePath: string, line: number, col: number) => void
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

    _panel.onDidDispose(() => { _panel = undefined; });
  }

  _panel.webview.html = buildHtml(_panel.webview, summary);

  _panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'navigate') {
      onNavigate(msg.filePath, msg.line, msg.col);
    }
  });
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(webview: vscode.Webview, summary: UsageSummary): string {
  const nonce = getNonce();

  // Build kind groups — sorted by count desc
  const kinds = Array.from(summary.byKind.entries())
    .sort((a, b) => b[1].length - a[1].length);

  // Category pills HTML
  const pills = kinds.map(([kind, usages]) => `
    <button class="pill" data-kind="${kind}" onclick="filterKind('${kind}')">
      <span class="pill-icon">${KIND_ICONS[kind]}</span>
      <span class="pill-label">${KIND_LABELS[kind]}</span>
      <span class="pill-count">${usages.length}</span>
    </button>
  `).join('');

  // Group usages by file, within each kind
  const allUsagesJson = JSON.stringify(
    Array.from(summary.byKind.entries()).flatMap(([kind, usages]) =>
      usages.map(u => ({
        kind,
        filePath: u.filePath,
        line: u.line,
        col: u.column,
        lineText: u.lineText,
        context: u.context,
        framework: u.framework,
      }))
    )
  );

  const frameworkBadge = summary.framework !== 'generic'
    ? `<span class="fw-badge fw-${summary.framework}">${summary.framework.toUpperCase()}</span>`
    : '';

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root {
    --bg:        var(--vscode-editor-background, #1e1e2e);
    --bg2:       var(--vscode-editorWidget-background, #252537);
    --bg3:       var(--vscode-list-hoverBackground, #2d2d45);
    --fg:        var(--vscode-editor-foreground, #cdd6f4);
    --fg-dim:    var(--vscode-descriptionForeground, #7f849c);
    --accent:    var(--vscode-focusBorder, #89b4fa);
    --accent2:   var(--vscode-textLink-foreground, #cba6f7);
    --border:    var(--vscode-widget-border, #313244);
    --hover:     var(--vscode-list-hoverBackground, #313244);
    --select:    var(--vscode-list-activeSelectionBackground, #45475a);
    --green:     var(--vscode-testing-iconPassed, #a6e3a1);
    --yellow:    var(--vscode-editorWarning-foreground, #f9e2af);
    --red:       var(--vscode-editorError-foreground, #f38ba8);
    --radius:    6px;
    --font-mono: var(--vscode-editor-font-family, 'JetBrains Mono', 'Fira Code', monospace);
    --font-ui:   var(--vscode-font-family, system-ui, sans-serif);
    --font-size: var(--vscode-editor-font-size, 13px);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-ui);
    font-size: var(--font-size);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ─── Header ─────────────────────────────────────────────── */
  .header {
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .symbol-name {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }

  .total-count {
    font-size: 11px;
    color: var(--fg-dim);
    margin-left: auto;
  }

  .fw-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    letter-spacing: 0.05em;
  }
  .fw-react    { background: #20354f; color: #61dafb; }
  .fw-angular  { background: #3f1313; color: #dd0031; }
  .fw-vue      { background: #1a3326; color: #42b883; }
  .fw-mixed    { background: #2d2645; color: #cba6f7; }

  /* ─── Pills ──────────────────────────────────────────────── */
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px 4px 8px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--bg3);
    color: var(--fg);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font-ui);
  }

  .pill:hover { background: var(--hover); border-color: var(--accent); }
  .pill.active { background: var(--accent); color: #1e1e2e; border-color: var(--accent); font-weight: 600; }
  .pill.active .pill-count { background: rgba(0,0,0,0.2); color: #1e1e2e; }

  .pill-icon   { font-size: 13px; }
  .pill-label  { }
  .pill-count  {
    background: var(--bg);
    color: var(--accent);
    border-radius: 10px;
    padding: 1px 6px;
    font-weight: 700;
    font-size: 10px;
  }

  .pill-all {
    border-style: dashed;
  }

  /* ─── Search ──────────────────────────────────────────────── */
  .search-row {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg);
  }

  .search-input {
    width: 100%;
    background: var(--bg2);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 5px 10px;
    border-radius: var(--radius);
    font-size: 12px;
    font-family: var(--font-ui);
    outline: none;
    transition: border-color 0.15s;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--fg-dim); }

  /* ─── Results list ───────────────────────────────────────── */
  .results {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .results::-webkit-scrollbar { width: 6px; }
  .results::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .file-group { margin-bottom: 4px; }

  .file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px 4px;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 1;
    cursor: pointer;
    user-select: none;
  }

  .file-header:hover { background: var(--hover); }

  .file-chevron {
    font-size: 10px;
    color: var(--fg-dim);
    transition: transform 0.15s;
    width: 12px;
  }
  .file-chevron.collapsed { transform: rotate(-90deg); }

  .file-icon { font-size: 13px; }

  .file-path {
    font-size: 11px;
    color: var(--fg-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-path .file-name {
    color: var(--fg);
    font-weight: 500;
  }

  .file-badge {
    font-size: 10px;
    color: var(--fg-dim);
    padding: 1px 6px;
    background: var(--bg2);
    border-radius: 10px;
    flex-shrink: 0;
  }

  .file-usages {
    overflow: hidden;
  }
  .file-usages.collapsed { display: none; }

  .usage-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 16px 5px 30px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: all 0.1s;
  }

  .usage-row:hover {
    background: var(--hover);
    border-left-color: var(--accent);
  }

  .usage-kind-icon {
    font-size: 13px;
    flex-shrink: 0;
    margin-top: 1px;
    width: 18px;
    text-align: center;
  }

  .usage-content { flex: 1; min-width: 0; }

  .usage-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .usage-kind-label {
    font-size: 10px;
    color: var(--accent2);
    font-weight: 500;
    background: rgba(137, 180, 250, 0.08);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .usage-context {
    font-size: 10px;
    color: var(--fg-dim);
    font-style: italic;
  }

  .usage-line-num {
    font-size: 10px;
    color: var(--fg-dim);
    font-family: var(--font-mono);
    margin-left: auto;
    flex-shrink: 0;
  }

  .usage-code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .usage-code .highlight {
    color: var(--accent);
    font-weight: 600;
  }

  /* ─── Empty state ────────────────────────────────────────── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    color: var(--fg-dim);
    gap: 8px;
  }
  .empty-icon { font-size: 32px; }
  .empty-text { font-size: 13px; }

  /* ─── Status bar ─────────────────────────────────────────── */
  .statusbar {
    padding: 4px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg2);
    font-size: 11px;
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .status-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--green);
    flex-shrink: 0;
  }

  .kind-section-header {
    padding: 10px 16px 4px;
    font-size: 10px;
    font-weight: 700;
    color: var(--fg-dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .kind-section-header:first-child { border-top: none; margin-top: 0; }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <span class="symbol-name">${escHtml(summary.symbolName)}</span>
    ${frameworkBadge}
    <span class="total-count">${summary.totalCount} usage${summary.totalCount !== 1 ? 's' : ''}</span>
  </div>
  <div class="pills">
    <button class="pill pill-all active" data-kind="all" onclick="filterKind('all')">
      <span class="pill-icon">◉</span>
      <span class="pill-label">All</span>
      <span class="pill-count">${summary.totalCount}</span>
    </button>
    ${pills}
  </div>
</div>

<div class="search-row">
  <input
    class="search-input"
    type="text"
    placeholder="Filter usages…"
    oninput="filterSearch(this.value)"
    autocomplete="off"
    spellcheck="false"
  />
</div>

<div class="results" id="results"></div>

<div class="statusbar">
  <div class="status-dot"></div>
  <span id="status-text">Showing ${summary.totalCount} usages across ${summary.byFile.size} file${summary.byFile.size !== 1 ? 's' : ''}</span>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const ALL_USAGES = ${allUsagesJson};

// Group ALL_USAGES by kind then by file
function buildGroups(usages) {
  // kind → file → [usage]
  const groups = new Map();
  for (const u of usages) {
    if (!groups.has(u.kind)) groups.set(u.kind, new Map());
    const fileMap = groups.get(u.kind);
    if (!fileMap.has(u.filePath)) fileMap.set(u.filePath, []);
    fileMap.get(u.filePath).push(u);
  }
  return groups;
}

// Map kind to sort priority (more interesting = first)
const KIND_ORDER = [
  'jsx-render','hook-call','context-consumer','context-provider',
  'hoc-wrap','lazy-import','di-injection','decorator-ref',
  'function-call','jsx-prop','hook-dep','class-extends',
  'interface-implements','type-annotation','assignment',
  're-export','generic-usage','import-only'
];

function kindPriority(k) {
  const i = KIND_ORDER.indexOf(k);
  return i === -1 ? 99 : i;
}

const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
const KIND_ICONS  = ${JSON.stringify(KIND_ICONS)};

let activeKind   = 'all';
let activeSearch = '';
const collapsedFiles = new Set();

function filterKind(kind) {
  activeKind = kind;
  document.querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.dataset.kind === kind);
  });
  render();
}

function filterSearch(val) {
  activeSearch = val.toLowerCase();
  render();
}

function toggleFile(key) {
  if (collapsedFiles.has(key)) collapsedFiles.delete(key);
  else collapsedFiles.add(key);
  render();
}

function navigate(filePath, line, col) {
  vscode.postMessage({ type: 'navigate', filePath, line, col });
}

function highlight(text, symbol) {
  const escaped = text.replace(/[<>&"]/g, c =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'
  );
  // Highlight symbol occurrences — split/join avoids regex-literal issues
  if (!symbol) return escaped;
  return escaped.split(symbol).join('<span class="highlight">' + symbol + '</span>');
}

function getFileName(fp) {
  return fp.replace(/\\\\/g, '/').split('/').pop();
}

function getRelPath(fp) {
  // Try to shorten the path
  const parts = fp.replace(/\\\\/g, '/').split('/');
  if (parts.length > 3) return '…/' + parts.slice(-3, -1).join('/') + '/';
  return parts.slice(0, -1).join('/') + '/';
}

function render() {
  let filtered = ALL_USAGES;

  if (activeKind !== 'all') {
    filtered = filtered.filter(u => u.kind === activeKind);
  }

  if (activeSearch) {
    filtered = filtered.filter(u =>
      u.lineText.toLowerCase().includes(activeSearch) ||
      u.filePath.toLowerCase().includes(activeSearch) ||
      (u.context || '').toLowerCase().includes(activeSearch) ||
      KIND_LABELS[u.kind].toLowerCase().includes(activeSearch)
    );
  }

  const el = document.getElementById('results');

  if (filtered.length === 0) {
    el.innerHTML = \`
      <div class="empty">
        <div class="empty-icon">○</div>
        <div class="empty-text">No usages match the current filter</div>
      </div>
    \`;
    document.getElementById('status-text').textContent =
      'No results';
    return;
  }

  // Group by kind, then by file
  const byKind = new Map();
  for (const u of filtered) {
    if (!byKind.has(u.kind)) byKind.set(u.kind, new Map());
    const fileMap = byKind.get(u.kind);
    if (!fileMap.has(u.filePath)) fileMap.set(u.filePath, []);
    fileMap.get(u.filePath).push(u);
  }

  const sortedKinds = Array.from(byKind.keys())
    .sort((a, b) => kindPriority(a) - kindPriority(b));

  let html = '';

  for (const kind of sortedKinds) {
    const fileMap = byKind.get(kind);
    const kindCount = Array.from(fileMap.values()).reduce((s, a) => s + a.length, 0);

    html += \`<div class="kind-section">
      <div class="kind-section-header">
        <span>\${KIND_ICONS[kind] || '●'}</span>
        <span>\${KIND_LABELS[kind] || kind}</span>
        <span style="font-weight:400;color:var(--accent)">\${kindCount}</span>
      </div>\`;

    for (const [filePath, usages] of fileMap) {
      const fileKey = kind + '::' + filePath;
      const collapsed = collapsedFiles.has(fileKey);
      const fname = getFileName(filePath);
      const fdir  = getRelPath(filePath);

      html += \`<div class="file-group">
        <div class="file-header" onclick="toggleFile('\${fileKey.replace(/'/g, "\\\\'")}')">
          <span class="file-chevron \${collapsed ? 'collapsed' : ''}">▾</span>
          <span class="file-icon">📄</span>
          <span class="file-path">
            <span style="color:var(--fg-dim)">\${escHtml(fdir)}</span><span class="file-name">\${escHtml(fname)}</span>
          </span>
          <span class="file-badge">\${usages.length}</span>
        </div>
        <div class="file-usages \${collapsed ? 'collapsed' : ''}">\`;

      for (const u of usages) {
        html += \`<div class="usage-row"
          onclick="navigate(\${JSON.stringify(u.filePath)}, \${u.line}, \${u.col})">
          <div class="usage-kind-icon">\${KIND_ICONS[u.kind] || '●'}</div>
          <div class="usage-content">
            <div class="usage-meta">
              <span class="usage-kind-label">\${KIND_LABELS[u.kind]}</span>
              \${u.context ? \`<span class="usage-context">\${escHtml(u.context)}</span>\` : ''}
              <span class="usage-line-num">:\${u.line + 1}</span>
            </div>
            <div class="usage-code">\${highlight(u.lineText.trim().slice(0, 150), ${JSON.stringify(summary.symbolName)})}</div>
          </div>
        </div>\`;
      }

      html += '</div></div>';
    }

    html += '</div>';
  }

  el.innerHTML = html;

  const fileCount = new Set(filtered.map(u => u.filePath)).size;
  document.getElementById('status-text').textContent =
    \`Showing \${filtered.length} usage\${filtered.length !== 1 ? 's' : ''} across \${fileCount} file\${fileCount !== 1 ? 's' : ''}\`;
}

function escHtml(s) {
  return String(s).replace(/[<>&"]/g, c =>
    c==='<'?'&lt;':c==='>'?'&gt;':c==='&'?'&amp;':'&quot;');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelector('.search-input').value = '';
    filterSearch('');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.querySelector('.search-input').focus();
  }
});

render();
</script>
</body>
</html>`;
}

// ─── Nonce helper ─────────────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escHtml(s: string): string {
  return s.replace(/[<>&"]/g, c =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'
  );
}