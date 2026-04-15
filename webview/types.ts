/**
 * @fileoverview PChat Webview 共享类型定义与工具函数。
 */

/* ─── 设置 ─── */

export type PchatSettings = {
  autoRenew: boolean;
  agentTimeoutMin: number;
  renewBeforeMin: number;
  backendTimeoutMin: number;
  /** 强制续期间隔（分钟），防止 Cursor MCP 硬超时 */
  forceRenewMin: number;
  globalPayload?: { enabled: boolean; position: 'head' | 'tail'; text: string };
  /** 是否在输入框下方展示广告跑马灯 */
  showAd?: boolean;
};

/* ─── 消息 ─── */

export type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  ts: number;
};

/* ─── 会话 ─── */

export type StoredSession = {
  id: string;
  title: string;
  messages: readonly StoredChatMessage[];
  payload?: { enabled: boolean; position: 'head' | 'tail'; text: string };
};

/* ─── 等待 ─── */

export type WaitFront = {
  requestId: string;
  message: string;
  prompt?: string;
  enqueuedAt: number;
  deadlineMs: number;
  progressTotalMs: number;
};

export type WaitPendingRow = {
  requestId: string;
  message: string;
  prompt?: string;
  enqueuedAt: number;
  index: number;
};

/* ─── 快捷指令 ─── */

export type CustomCmd = {
  id: string;
  text: string;
};

/* ─── 宿主状态 ─── */

export type HostState = {
  sessions: readonly StoredSession[];
  activeSessionId: string;
  settings: PchatSettings;
  bridgeConnected: boolean;
  waitSnapshot: {
    activeSessionId: string;
    queueLength: number;
    pendingWaits: readonly WaitPendingRow[];
    front?: WaitFront;
    /** 最近一次自动续期时间戳（毫秒） */
    lastAutoRenewAt?: number;
    sessionQueueCounts?: Record<string, number>;
    /** 当前活动会话的运行元数据 */
    sessionMeta?: { createdAt: number; renewCount: number };
  };
  cursorInfo?: {
    email?: string;
    membership?: string;
    subscriptionStatus?: string;
  };
  rulesStatus?: { status: 'ok' | 'error' | 'disabled'; message: string; timestamp: number };
};

/* ─── 附件 ─── */

export type FileRef = { path: string; label: string; snippet: string };

export type AtItem = { rel: string; fsPath: string };

export type ImageAttach = { id: string; name: string; dataUrl: string };

/** 用户侧「发送队列」：无队首等待时可预写；新等待出现或轮到下一条时自动按序发出。 */
export type OutboxItem = {
  id: string;
  draft: string;
  refs: FileRef[];
  images: ImageAttach[];
};

/* ─── 持久化 ─── */

export type PchatWebPersist = {
  sidebarCollapsed?: boolean;
  waitCollapsed?: boolean;
  outboxBySession?: Record<string, OutboxItem[]>;
  /** 每个会话默认显示的历史消息数量 */
  historyLimit?: number;
  /** 各会话已展开的历史消息数量（切换会话不丢失） */
  historyExpandedBySession?: Record<string, number>;
};

/* ─── 常量 ─── */

/** 光标前 `@` 后允许非空白、非 `@` 的查询片段（支持中文路径等）。 */
export const AT_TAIL = /@([^\s@]*)$/;

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** 每个对话框默认显示的历史消息数量 */
export const DEFAULT_HISTORY_LIMIT = 5;

/** 每次「查看更多」加载的条数 */
export const LOAD_MORE_COUNT = 5;

export const SCROLL_BOTTOM_PX = 20;

/* ─── 工具函数 ─── */

export function buildSubmitBody(draftText: string, irefs: readonly FileRef[], iimgs: readonly ImageAttach[]): string {
  let body = '';
  for (const im of iimgs) {
    body += `![${im.name}](${im.dataUrl})\n\n`;
  }
  for (const r of irefs) {
    body += `@${r.path}\n\n`;
  }
  body += draftText.trim();
  return body;
}

export function truncateOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function formatElapsed(enqueuedAt: number, now: number): string {
  const elapsed = Math.max(0, now - enqueuedAt);
  const s = Math.floor(elapsed / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
