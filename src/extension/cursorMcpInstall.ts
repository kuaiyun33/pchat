/**
 * @fileoverview 在 Cursor 用户目录下合并 `mcp.json`，接近旧版「装好就能用」的体验。
 *
 * @remarks Cursor 的 `user-persistent-chat` 等内置 MCP 由客户端自带；本扩展通过写入
 * `~/.cursor/mcp.json` 注册本地 `bridge.js`，与手动配置等价。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

function cursorMcpJsonPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

/**
 * 若 `pchat.disableAutoMcp` 未开启，则确保 `mcpServers.pchat` 指向当前扩展内的 `dist/bridge.js`。
 */
export async function ensurePchatMcpInCursorConfig(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('pchat');
  if (cfg.get<boolean>('disableAutoMcp')) {
    return;
  }

  const bridge = vscode.Uri.joinPath(context.extensionUri, 'dist', 'bridge.js');
  const bridgePath = bridge.fsPath;
  const desired = { command: 'node', args: [bridgePath] };

  const mcpPath = cursorMcpJsonPath();
  const cursorDir = path.dirname(mcpPath);

  let raw = '';
  try {
    raw = await fs.readFile(mcpPath, 'utf8');
  } catch {
    raw = '';
  }

  let root: Record<string, unknown>;
  try {
    root = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    void vscode.window.showWarningMessage(
      `PChat：无法解析 ${mcpPath}，已跳过自动写入 MCP。可用命令「复制 MCP 配置」手动合并。`,
    );
    return;
  }

  let servers = root.mcpServers;
  if (servers == null || typeof servers !== 'object' || Array.isArray(servers)) {
    root.mcpServers = {};
    servers = root.mcpServers;
  }
  const mcpServers = servers as Record<string, unknown>;

  const existing = mcpServers.pchat as Record<string, unknown> | undefined;
  if (
    existing &&
    existing.command === desired.command &&
    Array.isArray(existing.args) &&
    existing.args[0] === desired.args[0]
  ) {
    return;
  }

  mcpServers.pchat = desired;

  await fs.mkdir(cursorDir, { recursive: true });
  const next = `${JSON.stringify(root, null, 2)}\n`;
  await fs.writeFile(mcpPath, next, 'utf8');

  void vscode.window.showInformationMessage(
    'PChat：已写入 ~/.cursor/mcp.json（mcpServers.pchat）。请在 Cursor 中刷新 MCP 列表，并打开一次左侧 PChat 侧栏。',
  );
}
