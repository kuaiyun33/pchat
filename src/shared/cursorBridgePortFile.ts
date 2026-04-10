/**
 * @fileoverview 将 MCP bridge 的监听端口落在 ~/.cursor，避免「仓库里的 bridge.js」与「VSIX 扩展目录」不一致时读不到 `.pchat-port`。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 与全局 `mcp.json` 同目录，任意路径下的 `bridge.js` 均可读取。 */
export function getCursorPchatBridgePortPath(): string {
  return path.join(os.homedir(), '.cursor', 'pchat-bridge.port');
}
