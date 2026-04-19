/**
 * @fileoverview 在本地回环上监听 TCP，供 `dist/bridge.js` 连接并交换等待/结果消息。
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  encodeIpcMessage,
  tryDecodeIpcMessage,
  type IpcMessage,
  type WaitResultPayload,
  type FindLatestSessionRequestPayload,
  type FindLatestSessionResponsePayload,
} from '../shared/ipcProtocol.js';
import { getCursorPchatBridgePortPath } from '../shared/cursorBridgePortFile.js';

/** 收到来自 Bridge 的 `waitRequest` 时回调。 */
export type OnWaitRequest = (msg: Extract<IpcMessage, { type: 'waitRequest' }>) => void;

/** 收到来自 Bridge 的 `findLatestSessionRequest` 时回调，需返回应答 */
export type OnFindLatestSession = (
  payload: FindLatestSessionRequestPayload,
) => FindLatestSessionResponsePayload;

/** Bridge 客户端连接，附带其自报告的 workspace 路径 */
type BridgeClient = {
  socket: net.Socket;
  inbound: Buffer;
  workspacePath?: string;
};

/**
 * 管理扩展根目录下的端口文件，并向 Bridge 写入 `waitResult`。
 */
export class PchatIpcServer {
  private server: net.Server | undefined;
  private clients = new Set<BridgeClient>();
  private readonly onWaitRequest: OnWaitRequest;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private readonly onFindLatestSession?: OnFindLatestSession;

  /**
   * @param extensionRoot - `context.extensionPath`
   * @param onWaitRequest - 将 MCP 等待分发给业务协调器
   * @param onConnectionChange - Bridge TCP 连接/断开
   * @param onFindLatestSession - 处理 workspace 最近 session 查询
   */
  constructor(
    private readonly extensionRoot: string,
    onWaitRequest: OnWaitRequest,
    onConnectionChange?: (connected: boolean) => void,
    onFindLatestSession?: OnFindLatestSession,
  ) {
    this.onWaitRequest = onWaitRequest;
    this.onConnectionChange = onConnectionChange;
    this.onFindLatestSession = onFindLatestSession;
  }

  /**
   * 启动监听并写入 `.pchat-port`（与 bridge 约定的端口文件）。
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = net.createServer((sock) => this.attachSocket(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Invalid listen address');
    }
    const port = String(addr.port);
    const portFile = path.join(this.extensionRoot, '.pchat-port');
    await fs.writeFile(portFile, port, 'utf8');
    const cursorPortFile = getCursorPchatBridgePortPath();
    await fs.mkdir(path.dirname(cursorPortFile), { recursive: true });
    await fs.writeFile(cursorPortFile, port, 'utf8');
  }

  /**
   * 释放端口与端口文件。
   */
  async dispose(): Promise<void> {
    this.onConnectionChange?.(false);
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!srv) {
        resolve();
        return;
      }
      srv.close(() => resolve());
    });
    try {
      await fs.unlink(path.join(this.extensionRoot, '.pchat-port'));
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(getCursorPchatBridgePortPath());
    } catch {
      /* ignore */
    }
  }

  /**
   * 向所有连接的 Bridge 广播消息。
   * Bridge 侧通过匹配 requestId 决定是否处理。
   */
  send(message: IpcMessage): void {
    if (this.clients.size === 0) {
      return;
    }
    const encoded = encodeIpcMessage(message);
    for (const client of this.clients) {
      if (!client.socket.destroyed) {
        try {
          client.socket.write(encoded);
        } catch {
          /* socket 可能处于 ending/closed 但尚未触发 close 事件，忽略写入错误 */
        }
      }
    }
  }

  /**
   * 当前是否有活跃的 Bridge TCP 连接。
   */
  get isConnected(): boolean {
    return this.clients.size > 0;
  }

  /**
   * 封装发送 `waitResult`。
   */
  sendWaitResult(payload: WaitResultPayload): void {
    this.send({ type: 'waitResult', payload });
  }

  private attachSocket(sock: net.Socket): void {
    const client: BridgeClient = { socket: sock, inbound: Buffer.alloc(0) };
    this.clients.add(client);
    this.onConnectionChange?.(this.clients.size > 0);

    sock.on('data', (chunk) => this.onData(client, chunk));
    sock.on('close', () => {
      this.clients.delete(client);
      this.onConnectionChange?.(this.clients.size > 0);
    });
    sock.on('error', () => {
      this.clients.delete(client);
      this.onConnectionChange?.(this.clients.size > 0);
    });
  }

  private onData(client: BridgeClient, chunk: Buffer): void {
    client.inbound = Buffer.concat([client.inbound, chunk]);
    for (;;) {
      let decoded;
      try {
        decoded = tryDecodeIpcMessage(client.inbound);
      } catch {
        client.inbound = Buffer.alloc(0);
        client.socket.destroy();
        return;
      }
      if (!decoded) {
        break;
      }
      client.inbound = Buffer.from(decoded.rest);
      this.dispatch(decoded.msg, client);
    }
  }

  private dispatch(msg: IpcMessage, client: BridgeClient): void {
    if (msg.type === 'bridgeHello') {
      if (msg.payload.cwd) {
        client.workspacePath = msg.payload.cwd;
      }
      return;
    }
    if (msg.type === 'ping') {
      /* 心跳：立即向来源 Bridge 回复 pong */
      if (!client.socket.destroyed) {
        try {
          client.socket.write(encodeIpcMessage({ type: 'pong' }));
        } catch {
          /* 写入瞬间 socket 已被对端关闭，忽略 */
        }
      }
      return;
    }
    if (msg.type === 'waitRequest') {
      const augmented = msg.payload.workspacePath
        ? msg
        : ({
            type: 'waitRequest' as const,
            payload: {
              ...msg.payload,
              workspacePath: client.workspacePath,
            },
          });
      this.onWaitRequest(augmented);
      return;
    }
    if (msg.type === 'findLatestSessionRequest') {
      if (!this.onFindLatestSession) return;
      let reply: FindLatestSessionResponsePayload;
      try {
        reply = this.onFindLatestSession(msg.payload);
      } catch {
        /* 业务回调抛错时也要回个空应答，否则 Bridge 会等到 5s 超时 */
        reply = { requestId: msg.payload.requestId };
      }
      if (!client.socket.destroyed) {
        try {
          client.socket.write(
            encodeIpcMessage({ type: 'findLatestSessionResponse', payload: reply }),
          );
        } catch {
          /* 同 ping：写入瞬间 socket 关闭则放弃 */
        }
      }
      return;
    }
    if (msg.type === 'waitResult') {
      /* Bridge 不应向 Extension 发 waitResult */
    }
  }
}
