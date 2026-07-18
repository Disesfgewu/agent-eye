import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

interface ArtifactEvent {
  id: string;
  timestamp: string;
  type: string;
  tool?: string;
  title: string;
  detail?: string;
  screenshot?: string;
  status?: string;
}

const MAX_RENDER = 200;

/**
 * Sidebar Webview showing the agent's live operation timeline (screenshots,
 * logs, approvals, steps) so the user can watch what the agent is doing and
 * build trust. Reads the append-only events.jsonl the MCP server writes.
 */
export class AgentEyePanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "agentEye.activity";

  private view?: vscode.WebviewView;
  private watcher?: vscode.FileSystemWatcher;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get artifactsDir(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, ".agent-artifacts") : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const artifactsDir = this.artifactsDir;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        ...(artifactsDir ? [vscode.Uri.file(artifactsDir)] : []),
      ],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "refresh") this.postEvents();
      if (msg.type === "clear") this.clearArtifacts();
    });

    this.startWatching();
    this.postEvents();
  }

  private startWatching(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".agent-artifacts/events.jsonl")
    );
    const refresh = () => this.postEvents();
    this.watcher.onDidChange(refresh);
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
    this.context.subscriptions.push(this.watcher);
  }

  private readEvents(): ArtifactEvent[] {
    const dir = this.artifactsDir;
    if (!dir) return [];
    const file = path.join(dir, "events.jsonl");
    if (!fs.existsSync(file)) return [];
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const recent = lines.slice(Math.max(0, lines.length - MAX_RENDER));
      return recent
        .map((line) => {
          try {
            return JSON.parse(line) as ArtifactEvent;
          } catch {
            return undefined;
          }
        })
        .filter((e): e is ArtifactEvent => e !== undefined);
    } catch {
      return [];
    }
  }

  postEvents(): void {
    if (!this.view) return;
    const dir = this.artifactsDir;
    const events = this.readEvents().map((e) => {
      let screenshotUri: string | undefined;
      if (e.screenshot && dir) {
        const abs = path.join(dir, e.screenshot);
        if (fs.existsSync(abs)) {
          screenshotUri = this.view!.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
        }
      }
      return { ...e, screenshotUri };
    });
    void this.view.webview.postMessage({ type: "events", events });
  }

  private clearArtifacts(): void {
    const dir = this.artifactsDir;
    if (!dir) return;
    try {
      fs.rmSync(path.join(dir, "events.jsonl"), { force: true });
      const shots = path.join(dir, "screenshots");
      if (fs.existsSync(shots)) {
        for (const name of fs.readdirSync(shots)) {
          fs.rmSync(path.join(shots, name), { force: true });
        }
      }
    } catch {
      /* best-effort */
    }
    this.postEvents();
  }

  clear(): void {
    this.clearArtifacts();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
    border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .empty { opacity: 0.6; font-style: italic; padding: 16px 4px; }
  .event { border-left: 3px solid var(--vscode-panel-border, #444); padding: 6px 10px; margin-bottom: 6px; }
  .event.ok { border-left-color: #4ec9b0; }
  .event.denied { border-left-color: #f14c4c; }
  .event.error { border-left-color: #f14c4c; }
  .event.pending { border-left-color: #cca700; }
  .row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .title { font-weight: 600; font-size: 13px; }
  .time { opacity: 0.55; font-size: 11px; white-space: nowrap; }
  .tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: 0.8; }
  .detail { font-size: 12px; opacity: 0.85; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .badge { font-size: 10px; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; opacity: 0.9; }
  .badge.denied, .badge.error { background: #5a1d1d; color: #f14c4c; }
  .badge.ok { background: #133a32; color: #4ec9b0; }
  img.shot { max-width: 100%; margin-top: 6px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <button id="clear">Clear</button>
  </div>
  <div id="list"><div class="empty">No agent activity yet. Set up the MCP server and let your agent drive the browser.</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type !== 'events') return;
    if (!msg.events.length) {
      list.innerHTML = '<div class="empty">No agent activity yet.</div>';
      return;
    }
    const html = msg.events.slice().reverse().map(e => {
      const status = e.status || '';
      const time = new Date(e.timestamp).toLocaleTimeString();
      const shot = e.screenshotUri ? '<img class="shot" src="' + esc(e.screenshotUri) + '" />' : '';
      const badge = status ? '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>' : '';
      const tool = e.tool ? '<div class="tool">' + esc(e.tool) + '</div>' : '';
      const detail = e.detail ? '<div class="detail">' + esc(e.detail) + '</div>' : '';
      return '<div class="event ' + esc(status) + '">'
        + '<div class="row"><span class="title">' + esc(e.title) + '</span><span class="time">' + esc(time) + '</span></div>'
        + tool + detail + badge + shot
        + '</div>';
    }).join('');
    list.innerHTML = html;
  });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
