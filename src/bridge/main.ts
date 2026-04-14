/**
 * @fileoverview MCP stdio 入口：暴露 `wait_for_user_input`，经 TCP 与 VS Code 扩展同步阻塞。
 *
 * @remarks 必须先完成 MCP `stdio` 握手，再异步连接扩展 TCP；不得在 `connect(transport)` 之前阻塞等待端口文件。
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  encodeIpcMessage,
  tryDecodeIpcMessage,
  type IpcMessage,
  type WaitRequestPayload,
} from '../shared/ipcProtocol.js';
import { parseWaitSessionId } from './sessionKey.js';
import { getCursorPchatBridgePortPath } from '../shared/cursorBridgePortFile.js';

type Pending = {
  readonly resolve: (text: string) => void;
  readonly reject: (err: Error) => void;
  readonly payload: WaitRequestPayload;
};

function readPortFile(extensionRoot: string): number | undefined {
  const candidates = [
    path.join(extensionRoot, '.pchat-port'),
    getCursorPchatBridgePortPath(),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function getExtensionRoot(): string {
  return path.resolve(path.dirname(__filename), '..');
}

async function main(): Promise<void> {
  const extensionRoot = getExtensionRoot();
  const pending = new Map<string, Pending>();
  let socket: net.Socket | undefined;
  let inbound = Buffer.alloc(0);
  /** 单一飞行中的连接 Promise，避免链式 `then` 无限增长与断线后状态错乱。 */
  let connecting: Promise<void> | undefined;

  /* ── 应用层心跳 ── */
  /** Bridge 每隔此毫秒数向 Extension 发一次 ping。 */
  const HEARTBEAT_INTERVAL_MS = 30_000;
  /** 超过此毫秒数未收到 pong 则认定连接失效，主动断开。 */
  const HEARTBEAT_TIMEOUT_MS = 60_000;
  let lastPongAt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const flushReject = (reason: string) => {
    const err = new Error(reason);
    for (const p of pending.values()) {
      p.reject(err);
    }
    pending.clear();
  };

  const onFrame = (msg: IpcMessage): void => {
    if (msg.type === 'pong') {
      /* 心跳回复：更新最后收到时间 */
      lastPongAt = Date.now();
      return;
    }
    if (msg.type !== 'waitResult') {
      return;
    }
    const p = pending.get(msg.payload.requestId);
    if (p) {
      pending.delete(msg.payload.requestId);
      p.resolve(msg.payload.text);
    }
  };

  const pushBuf = (chunk: Buffer): void => {
    inbound = Buffer.concat([inbound, chunk]);
    for (;;) {
      let decoded;
      try {
        decoded = tryDecodeIpcMessage(inbound);
      } catch {
        inbound = Buffer.alloc(0);
        socket?.destroy();
        return;
      }
      if (!decoded) {
        break;
      }
      inbound = Buffer.from(decoded.rest);
      onFrame(decoded.msg);
    }
  };

  const sendMsg = (msg: IpcMessage): boolean => {
    const sk = socket;
    if (!sk || sk.destroyed) {
      return false;
    }
    sk.write(encodeIpcMessage(msg));
    return true;
  };

  // 声明在 attachSocket 前面，以便在 close/error 时调用
  let ensureTcpConnected: () => Promise<void>;

  const triggerReconnectAndResend = () => {
    if (pending.size === 0) return;
    ensureTcpConnected().then(() => {
      for (const p of pending.values()) {
        sendMsg({ type: 'waitRequest', payload: p.payload });
      }
    }).catch(() => {
      /* 忽略，ensureTcpConnected 永远不断重试 */
    });
  };

  /** 清理心跳定时器。 */
  const clearHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  /** 启动心跳定时器：定期发 ping，超时则断开。 */
  const startHeartbeat = (): void => {
    clearHeartbeat();
    lastPongAt = Date.now(); // 连接刚建立时视为一次隐含的 pong
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.destroyed) {
        clearHeartbeat();
        return;
      }
      /* 检查上次 pong 是否已超时 */
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        clearHeartbeat();
        socket.destroy(); // 触发 close → triggerReconnectAndResend
        return;
      }
      sendMsg({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  };

  const attachSocket = (s: net.Socket): void => {
    socket?.destroy();
    socket = s;
    inbound = Buffer.alloc(0);
    s.setKeepAlive(true, 10000);
    s.on('data', (c) => pushBuf(c));
    s.on('close', () => {
      if (socket === s) {
        clearHeartbeat();
        socket = undefined;
        connecting = undefined;
        triggerReconnectAndResend();
      }
    });
    s.on('error', () => {
      if (socket === s) {
        clearHeartbeat();
        socket = undefined;
        connecting = undefined;
        triggerReconnectAndResend();
      }
    });
    startHeartbeat();
  };

  /**
   * 轮询端口直至连上；同一时刻仅一个连接过程在飞。
   */
  ensureTcpConnected = (): Promise<void> => {
    if (socket && !socket.destroyed) {
      return Promise.resolve();
    }
    if (!connecting) {
      connecting = new Promise<void>((resolve, reject) => {
        const tryConnect = (): void => {
          if (socket && !socket.destroyed) {
            connecting = undefined;
            resolve();
            return;
          }
          const port = readPortFile(extensionRoot);
          if (port) {
            const s = net.connect({ host: '127.0.0.1', port }, () => {
              attachSocket(s);
              sendMsg({ type: 'bridgeHello', payload: { pid: process.pid } });
              connecting = undefined;
              resolve();
            });
            s.once('error', () => {
              s.destroy();
              setTimeout(tryConnect, 400);
            });
            return;
          }
          setTimeout(tryConnect, 400);
        };
        tryConnect();
      });
    }
    return connecting;
  };

  void ensureTcpConnected().catch(() => {});

  const server = new Server({ name: 'pchat', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'wait_for_user_input',
        description:
          'Wait for user input in the persistent chat panel.\n\nRULES:\n- Normal text returned: process as user reply\n- Text starting with "TIMEOUT_RENEW" returned: system renewal signal with instructions. Do NOT output anything. Follow the instruction if applicable, then immediately call this tool again. This may repeat many times - always re-call.\n- Responses include a [session_id: xxx] tag. You MUST pass this value back as the sessionId argument in ALL subsequent calls. This is critical for multi-session routing.\n\nParameters:\n- message: Complete assistant reply to show in chat history\n- prompt: Hint text above the input box\n- sessionId: Session identifier from the [session_id: xxx] tag in the previous response. Pass it back in every subsequent call. Omit on first call - the server will assign one.\n- title: Cursor Chat window title for display in session tabs. Pass on first call or when title changes.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Complete assistant reply to show in chat history' },
            prompt: { type: 'string', description: 'Hint text above the input box' },
            sessionId: {
              type: 'string',
              description:
                'CRITICAL REQUIRED FIELD: You MUST pass the exact session ID from the [session_id: xxx] tag present in the prior wait_for_user_input tool result. IF THE PREVIOUS TOOL CALL FAILED OR TIMED OUT, do NOT pass "NEW"; instead, look at the arguments you used in your last tool call and reuse that EXACT SAME sessionId. ONLY pass "NEW" if you have NEVER called wait_for_user_input in this entire chat window before. Failure to do so will severely break chat context routing!',
            },
            title: { type: 'string', description: 'Cursor Chat window title for display in session tabs. Pass on first call or when title changes.' },
          },
          required: ['message', 'sessionId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'wait_for_user_input') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const message = String(args.message ?? '');
    const titleRaw = args.title != null ? String(args.title) : undefined;
    const promptRaw = args.prompt != null ? String(args.prompt) : undefined;
    
    const requestId = randomUUID();
    const parsed = parseWaitSessionId(args.sessionId, message);
    if (!parsed.ok) {
      return {
        content: [{ type: 'text' as const, text: parsed.error }],
        isError: true,
      };
    }
    const sessionId = parsed.sessionId;

    const payload: WaitRequestPayload = {
      requestId,
      message,
      prompt: promptRaw,
      sessionId,
      title: titleRaw,
    };

    await ensureTcpConnected();

    const text = await new Promise<string>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, payload });
      const ok = sendMsg({ type: 'waitRequest', payload });
      if (!ok) {
        pending.delete(requestId);
        reject(
          new Error(
            '无法连接 PChat 扩展：请确认扩展已加载，并打开左侧 PChat 侧栏一次以写入端口文件。',
          ),
        );
      }
    });

    // "Responses include a [session_id: xxx] tag."
    // 结尾附带 [session_id: xxx]
    const finalResponse = `${text}\n\n[session_id: ${sessionId}]`;

    // 提取所有的 markdown 格式的 Data URL 图片，并将其转为标准的 MCP ImageContent 数组，
    // 以便 Cursor Agent 能够触发原生的视觉（Vision）多模态处理，而不是当做超长文本存为文件。
    const content: any[] = [];
    let lastIndex = 0;
    const imgRegex = /!\[([^\]]*)\]\((data:image\/([^;]+);base64,([^)]+))\)/g;
    let match;
    while ((match = imgRegex.exec(finalResponse)) !== null) {
      if (match.index > lastIndex) {
        content.push({ type: 'text' as const, text: finalResponse.substring(lastIndex, match.index) });
      }
      content.push({
        type: 'image' as const,
        data: match[4],
        mimeType: `image/${match[3]}`
      });
      lastIndex = imgRegex.lastIndex;
    }
    if (lastIndex < finalResponse.length) {
      content.push({ type: 'text' as const, text: finalResponse.substring(lastIndex) });
    }

    return { content };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
