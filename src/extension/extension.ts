/**
 * @fileoverview PChat 扩展入口：IPC、协调器、侧栏与命令注册。
 */

import * as vscode from 'vscode';
import { ensurePchatMcpInCursorConfig } from './cursorMcpInstall.js';
import { PchatCoordinator } from './coordinator.js';
import { PchatIpcServer } from './ipcServer.js';
import { PchatSidePanelProvider } from './panel.js';

/**
 * 扩展载入时：启动本地 TCP、注册 Webview 与引用类命令。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let sideView: vscode.WebviewView | undefined;

  const holder: { coordinator: PchatCoordinator | undefined } = { coordinator: undefined };

  const ipc = new PchatIpcServer(
    context.extensionPath,
    (msg) => {
      holder.coordinator?.enqueueWait(msg.payload);
    },
    (c) => {
      holder.coordinator?.setBridgeConnected(c);
    },
  );

  const coordinator = new PchatCoordinator(
    context,
    (m) => {
      void sideView?.webview.postMessage(m);
    },
    ipc,
  );
  holder.coordinator = coordinator;

  await ipc.start();

  void ensurePchatMcpInCursorConfig(context).catch((err) => {
    console.error('[pchat] ensurePchatMcpInCursorConfig', err);
  });

  const provider = new PchatSidePanelProvider(context.extensionUri, coordinator, (v) => {
    sideView = v;
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PchatSidePanelProvider.viewId, provider),
    { dispose: () => void ipc.dispose() },
    vscode.workspace.onDidCreateFiles(() => provider.invalidateFileIndex()),
    vscode.workspace.onDidDeleteFiles(() => provider.invalidateFileIndex()),
    vscode.workspace.onDidRenameFiles(() => provider.invalidateFileIndex()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pchat.openPanel', async () => {
      await vscode.commands.executeCommand('pchat.sidePanel.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pchat.copyMcpConfig', async () => {
      const bridge = vscode.Uri.joinPath(context.extensionUri, 'dist', 'bridge.js');
      const snippet = JSON.stringify(
        {
          mcpServers: {
            pchat: {
              command: 'node',
              args: [bridge.fsPath],
            },
          },
        },
        null,
        2,
      );
      await vscode.env.clipboard.writeText(snippet);
      await vscode.window.showInformationMessage(
        '已复制 MCP 配置。若未使用自动写入 ~/.cursor/mcp.json，请手动合并；保存后刷新 MCP，并先打开一次 PChat 侧栏。',
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pchat.refFile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      await provider.addRefFromUri(sideView?.webview, ed.document.uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pchat.refSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        return;
      }
      const text = ed.document.getText(ed.selection);
      const uri = ed.document.uri;
      const rel = vscode.workspace.asRelativePath(uri);
      provider.insertFileRef(sideView?.webview, uri.fsPath, `${rel} (选区)`, text);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pchat.refExplorerFile', async (uri: vscode.Uri) => {
      const u = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!u) {
        return;
      }
      await provider.addRefFromUri(sideView?.webview, u);
    }),
  );
}

/**
 * 扩展卸载时（IPC 等已由 subscription dispose）。
 */
export function deactivate(): void {}
