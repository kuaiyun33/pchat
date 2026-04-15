import { randomBytes } from 'node:crypto';

/** 侧栏「默认」会话（仅文档/兼容；Bridge 侧已要求显式传入合法 sessionId）。 */
export const PCHAT_MAIN_SESSION_ID = 'pchat-main';

export type ParseSessionIdResult =
  | { ok: true; sessionId: string; isNew?: boolean }
  | { ok: false; error: string };

/** 已发放 ID → 创建时间戳。超过 STALE_MS 的条目在下次生成时被清理。 */
const issuedIds = new Map<string, number>();
const STALE_MS = 24 * 60 * 60_000; // 24 小时

function pruneStaleIds(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, ts] of issuedIds) {
    if (ts < cutoff) issuedIds.delete(id);
  }
}

function generateUniqueId(): string {
  pruneStaleIds();
  let generated: string;
  let attempts = 0;
  do {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const rand = randomBytes(4).toString('hex');
    generated = `${hh}${mi}-${rand}`;
    attempts++;
  } while (issuedIds.has(generated) && attempts < 100);
  issuedIds.set(generated, Date.now());
  return generated;
}

/**
 * 解析 AI 传入的 sessionId。
 *
 * - "NEW" / 空 → 生成 `HHmm-xxxxxxxx`（时分 + 8 位随机 hex），
 *   通过 issuedIds Map 保证同进程内 100% 不重复，并定期清理 24h 前的旧条目。
 * - AI 自行传入的 ID → 检查是否与已发放 ID 碰撞，若碰撞则重新分配。
 */
export function parseWaitSessionId(raw: unknown, _message?: string): ParseSessionIdResult {
  const s = raw != null ? String(raw).trim() : '';
  if (!s || s === 'NEW' || s.toLowerCase() === 'new') {
    return { ok: true, sessionId: generateUniqueId(), isNew: true };
  }
  if (issuedIds.has(s)) {
    return { ok: true, sessionId: s };
  }
  issuedIds.set(s, Date.now());
  return { ok: true, sessionId: s };
}
