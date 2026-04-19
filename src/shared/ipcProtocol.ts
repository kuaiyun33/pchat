/**
 * @fileoverview 扩展宿主与 MCP bridge 之间的长度前缀 JSON 帧协议。
 */

/** 单帧最大字节数。 */
export const IPC_MAX_FRAME_BYTES = 48 * 1024 * 1024;

/** Bridge → Extension：一次 `wait_for_user_input` 调用。 */
export type WaitRequestPayload = {
  readonly requestId: string;
  readonly message: string;
  readonly prompt?: string;
  readonly sessionId?: string;
  readonly title?: string;
  /** 当前 Bridge 进程所在工作区路径，用于 workspace → sessionId 注册 */
  readonly workspacePath?: string;
};

/** Extension → Bridge：结束等待。 */
export type WaitResultPayload = {
  readonly requestId: string;
  readonly text: string;
};

export type BridgeHelloPayload = {
  readonly pid: number;
  /** Bridge 进程当前 Cursor 工作区路径，多根用逗号分隔 */
  readonly cwd?: string;
};

/** Bridge → Extension：查询某工作区最近活跃 sessionId */
export type FindLatestSessionRequestPayload = {
  readonly requestId: string;
  readonly workspacePath: string;
  /** 最大有效期（毫秒），缺省 24 小时 */
  readonly maxAgeMs?: number;
};

/** Extension → Bridge：返回 sessionId 或 undefined */
export type FindLatestSessionResponsePayload = {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly lastActiveTs?: number;
};

export type IpcMessage =
  | { readonly type: 'bridgeHello'; readonly payload: BridgeHelloPayload }
  | { readonly type: 'waitRequest'; readonly payload: WaitRequestPayload }
  | { readonly type: 'waitResult'; readonly payload: WaitResultPayload }
  | { readonly type: 'findLatestSessionRequest'; readonly payload: FindLatestSessionRequestPayload }
  | { readonly type: 'findLatestSessionResponse'; readonly payload: FindLatestSessionResponsePayload }
  | { readonly type: 'ping' }
  | { readonly type: 'pong' };

export function encodeIpcMessage(msg: IpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > IPC_MAX_FRAME_BYTES) {
    throw new Error(`IPC frame too large: ${body.length}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function tryDecodeIpcMessage(buffer: Buffer): { msg: IpcMessage; rest: Buffer } | undefined {
  if (buffer.length < 4) {
    return undefined;
  }
  const len = buffer.readUInt32BE(0);
  if (len > IPC_MAX_FRAME_BYTES) {
    throw new Error(`IPC frame length out of range: ${len}`);
  }
  if (buffer.length < 4 + len) {
    return undefined;
  }
  const slice = buffer.subarray(4, 4 + len);
  const rest = buffer.subarray(4 + len);
  const msg = JSON.parse(slice.toString('utf8')) as IpcMessage;
  return { msg, rest };
}
