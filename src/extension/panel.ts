/**
 * @fileoverview 注册侧栏 Webview：HTML/CSP、静态资源 URI、工作区 @ 补全与文件引用。
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PchatCoordinator } from './coordinator.js';
import { ensurePchatRules } from './cursorRules.js';
import type { FromWebviewMessage, ToWebviewMessage, WorkspaceFileItem } from './webviewProtocol.js';

/** 工作区文件列表缓存，降低 `findFiles` 频率。 */
type FileIndexCache = {
  readonly t: number;
  readonly items: readonly WorkspaceFileItem[];
};

const FILE_INDEX_TTL_MS = 25_000;
const MAX_INDEX_FILES = 500;
const MAX_SNIPPET_CHARS = 120_000;
const MAX_AT_RESULTS = 40;

/**
 * 生成 Webview 使用的 nonce（用于 CSP `script-src`）。
 */
function getNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 将二进制读为 UTF-8 文本（非法字节替换），并截断。
 */
async function readUtf8Snippet(uri: vscode.Uri): Promise<string> {
  const buf = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return text.slice(0, MAX_SNIPPET_CHARS);
}

/**
 * 侧栏 `pchat.sidePanel` 的 `WebviewViewProvider` 实现。
 */
export class PchatSidePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'pchat.sidePanel';

  private fileIndexCache: FileIndexCache | undefined;

  /** 丢弃过期的 @ 补全缓存（工作区文件变更时由 extension 订阅调用）。 */
  invalidateFileIndex(): void {
    this.fileIndexCache = undefined;
  }

  /**
   * @param extensionUri - `context.extensionUri`
   * @param coordinator - 会话与等待队列协调器
   * @param onView - 在视图创建/销毁时回传实例，便于命令向当前 Webview 发消息
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly coordinator: PchatCoordinator,
    private readonly onView: (view: vscode.WebviewView | undefined) => void,
  ) {}

  /** @inheritdoc */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this.onView(webviewView);
    webviewView.onDidDispose(() => this.onView(undefined));

    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    webview.html = this.buildHtml(webview);
    webview.onDidReceiveMessage((raw: unknown) => this.onMessage(webview, raw));
    this.coordinator.pushFullState();
  }

  /**
   * 由命令触发：向输入区插入文件引用块（不自动发送）。
   */
  insertFileRef(webview: vscode.Webview | undefined, path: string, label: string, snippet: string): void {
    this.post(webview, { type: 'ref', payload: { path, label, snippet } });
  }

  /**
   * 从任意 `Uri` 读取内容并推入 Webview 引用区（用于编辑器 / 资源管理器命令）。
   */
  async addRefFromUri(webview: vscode.Webview | undefined, uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        void vscode.window.showInformationMessage('不能引用文件夹');
        return;
      }
    } catch {
      void vscode.window.showWarningMessage(`无法访问: ${uri.fsPath}`);
      return;
    }
    try {
      const snippet = await readUtf8Snippet(uri);
      const rel = vscode.workspace.asRelativePath(uri, false);
      const label = rel.startsWith('..') ? uri.fsPath : rel;
      this.insertFileRef(webview, uri.fsPath, label, snippet);
    } catch {
      void vscode.window.showWarningMessage(`无法读取文件: ${uri.fsPath}`);
    }
  }

  private post(webview: vscode.Webview | undefined, msg: ToWebviewMessage): void {
    void webview?.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'assets', 'webview.css'));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${csp}; img-src ${csp} data: blob:;" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>PChat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private onMessage(webview: vscode.Webview, raw: unknown): void {
    const msg = raw as FromWebviewMessage;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.coordinator.pushFullState();
        break;
      case 'submit': {
        const ok = this.coordinator.resolveFrontWithUserText(msg.sessionId, msg.text);
        this.post(webview, { type: 'submit:ack', payload: { ok } });
        break;
      }
      case 'submit:broadcast_selected': {
        this.coordinator.broadcastSelectedUserText(msg.sessionIds, msg.text);
        this.post(webview, { type: 'submit:ack', payload: { ok: true } });
        break;
      }
      case 'settings':
        this.coordinator.updateSettings(msg.settings);
        break;
      case 'session:active':
        this.coordinator.setActiveSession(msg.sessionId);
        break;
      case 'session:clear': {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        if (!sid) {
          break;
        }
        void vscode.window
          .showWarningMessage('清空当前会话的聊天记录？此操作不可撤销。', { modal: true }, '清空')
          .then((choice) => {
            if (choice === '清空') {
              this.coordinator.clearSessionMessages(sid);
            }
          });
        break;
      }
      case 'session:delete': {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        const label = typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim() : sid || '该会话';
        void vscode.window
          .showWarningMessage(`确定删除会话「${label}」？`, { modal: true }, '删除')
          .then((choice) => {
            if (choice === '删除' && sid) {
              this.coordinator.deleteSession(sid);
            }
          });
        break;
      }
      case 'session:clear-all': {
        void vscode.window
          .showWarningMessage('确定清空所有会话？此操作不可撤销。', { modal: true }, '全部清空')
          .then((choice) => {
            if (choice === '全部清空') {
              this.coordinator.clearAllSessions();
            }
          });
        break;
      }
      case 'session:rename': {
        const id = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        const t = typeof msg.title === 'string' ? msg.title.trim() : '';
        if (id && t) {
          this.coordinator.renameSession(id, t);
        }
        break;
      }
      case 'session:reorder': {
        const ids = Array.isArray(msg.sessionIds) ? msg.sessionIds : [];
        if (ids.length > 0) {
          this.coordinator.reorderSessions(ids);
        }
        break;
      }
      case 'session:restore': {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        if (!sid) {
          void vscode.window.showWarningMessage('请输入有效的会话 ID。');
          break;
        }
        const ok = this.coordinator.restoreSession(sid);
        if (ok) {
          void vscode.window.showInformationMessage(`会话「${sid}」已恢复。`);
        } else {
          void vscode.window.showWarningMessage(`回收站中未找到 ID 为「${sid}」的会话。`);
        }
        break;
      }
      case 'session:payload': {
        this.coordinator.updateSessionPayload(msg.sessionId, msg.payload);
        break;
      }
      case 'rules:rewrite':
        void (async () => {
          try {
            const res = await ensurePchatRules(true);
            this.coordinator.setRulesStatus(res);
            this.post(webview, {
              type: 'rules:result',
              payload: { ok: res.status === 'ok', message: res.message },
            });
          } catch (e: any) {
            const errMsg = e?.message || String(e);
            this.coordinator.setRulesStatus({ status: 'error', message: errMsg, timestamp: Date.now() });
            this.post(webview, {
              type: 'rules:result',
              payload: { ok: false, message: `写入规则失败：${errMsg}` },
            });
          }
        })();
        break;
      case 'file:pick':
        void this.pickFiles(webview);
        break;
      case 'at:suggest':
        void this.handleAtSuggest(webview, msg.query, msg.seq);
        break;
      case 'ref:fsPath':
        void this.handleRefFsPath(webview, msg.fsPath);
        break;
      case 'queue:cancel': {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        const rid = typeof msg.requestId === 'string' ? msg.requestId.trim() : '';
        if (!sid || !rid) {
          break;
        }
        void vscode.window
          .showWarningMessage('从队列移除此条等待？Agent 侧会收到取消哨兵。', { modal: true }, '移除')
          .then((c) => {
            if (c === '移除') {
              this.coordinator.cancelQueuedWait(sid, rid);
            }
          });
        break;
      }
      case 'requestActiveContext': {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.scheme === 'file') {
          void this.addRefFromUri(webview, editor.document.uri);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 根据查询字符串过滤工作区文件并回传 Webview。
   */
  private async handleAtSuggest(webview: vscode.Webview, query: string, seq: number): Promise<void> {
    const items = await this.getWorkspaceFileItems();
    const q = query.trim().toLowerCase();
    
    let filtered: WorkspaceFileItem[];
    if (q) {
      filtered = items.filter((it) => it.rel.toLowerCase().includes(q));
    } else {
      // 获取当前真正处于打开状态（各个 Tab 分组中）的文件
      const openPaths = new Set<string>();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as any;
          if (input && input.uri && input.uri.scheme === 'file') {
            openPaths.add(input.uri.fsPath);
          }
        }
      }
      const openedItems = items.filter((it) => openPaths.has(it.fsPath));
      const restItems = items.filter((it) => !openPaths.has(it.fsPath));
      filtered = [...openedItems, ...restItems];
    }
    
    const slice = filtered.slice(0, MAX_AT_RESULTS);
    this.post(webview, { type: 'at:matches', payload: { query, seq, items: slice } });
  }

  /**
   * 按绝对路径读取文件并作为引用插入。
   * 仅允许工作区内的路径，避免异常消息读取任意本地文件。
   */
  private async handleRefFsPath(webview: vscode.Webview, fsPath: string): Promise<void> {
    if (typeof fsPath !== 'string' || !fsPath.trim()) {
      return;
    }
    const normalized = path.normalize(fsPath.trim());
    const uri = vscode.Uri.file(normalized);
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      void vscode.window.showWarningMessage('只能引用工作区内的文件');
      return;
    }
    await this.addRefFromUri(webview, uri);
  }

  /**
   * 带 TTL 的工作区文件索引（相对路径排序）。
   */
  private async getWorkspaceFileItems(): Promise<WorkspaceFileItem[]> {
    const now = Date.now();
    if (this.fileIndexCache && now - this.fileIndexCache.t < FILE_INDEX_TTL_MS) {
      return [...this.fileIndexCache.items];
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.fileIndexCache = { t: now, items: [] };
      return [];
    }
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', MAX_INDEX_FILES);
    const items: WorkspaceFileItem[] = files
      .filter((u) => u.scheme === 'file')
      .map((u) => ({
        rel: vscode.workspace.asRelativePath(u, false),
        fsPath: u.fsPath,
      }))
      .filter((x) => !x.rel.startsWith('..'))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    this.fileIndexCache = { t: now, items };
    return [...items];
  }

  private async pickFiles(webview: vscode.Webview): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true });
    if (!uris?.length) {
      return;
    }
    for (const uri of uris) {
      await this.addRefFromUri(webview, uri);
    }
  }
}
