import { randomBytes, createHash } from 'node:crypto';

/** 侧栏「默认」会话（仅文档/兼容；Bridge 侧已要求显式传入合法 sessionId）。 */
export const PCHAT_MAIN_SESSION_ID = 'pchat-main';

export type ParseSessionIdResult =
  | { ok: true; sessionId: string; isNew?: boolean }
  | { ok: false; error: string };

/**
 * 解析 AI 传入的 sessionId。若为 "NEW" 或空，则分配一个全新的 8 位十六进制字符串。
 * 若传入了 message，则通过内容的哈希保证 Cursor 工具重试时分配相同 ID，避免分裂会话。
 */
export function parseWaitSessionId(raw: unknown, message?: string): ParseSessionIdResult {
  const s = raw != null ? String(raw).trim() : '';
  if (!s || s === 'NEW' || s.toLowerCase() === 'new') {
    let generated: string;
    if (message && message.trim()) {
      generated = createHash('md5').update(message.trim()).digest('hex').substring(0, 8);
    } else {
      generated = randomBytes(4).toString('hex');
    }
    return { ok: true, sessionId: generated, isNew: true };
  }
  return { ok: true, sessionId: s };
}
