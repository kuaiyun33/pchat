import * as fs from "node:fs";
function logDebug(...args: any[]) {
  fs.appendFileSync("/tmp/pchat.log", new Date().toISOString() + " [EXT] " + args.map(String).join(" ") + "\n");
}

/**
 * @fileoverview 按会话排队 MCP 等待、驱动续期定时器，并与 Webview / IPC 桥接。
 */

import * as vscode from 'vscode';
import type { WaitRequestPayload } from '../shared/ipcProtocol.js';
import type { PchatIpcServer } from './ipcServer.js';
import type { ToWebviewMessage } from './webviewProtocol.js';
import { getCursorAuthInfo, type CursorAuthInfo } from './cursorAuth.js';

const SETTINGS_KEY = 'pchat.settings';
const SESSIONS_KEY = 'pchat.sessions';
const ACTIVE_SESSION_KEY = 'pchat.activeSessionId';

/** 持久化的会话与消息（精简结构，避免 globalState 过大）。 */
export type StoredSession = {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly StoredChatMessage[];
};

export type StoredChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly body: string;
  readonly ts: number;
};

export type PchatSettings = {
  autoRenew: boolean;
  /** Agent 侧超时（分钟），用于续期计算与进度条。 */
  agentTimeoutMin: number;
  /** 在超时前多少分钟发送 `TIMEOUT_RENEW`（须小于 agent 超时）。 */
  renewBeforeMin: number;
  /**
   * MCP / 工具侧上限（分钟），仅用于与 Agent 超时取较小值绘制进度条（与 Cursor 工具超时配置对齐参考）。
   */
  backendTimeoutMin: number;
};

const DEFAULT_SETTINGS: PchatSettings = {
  autoRenew: true,
  agentTimeoutMin: 110,
  renewBeforeMin: 5,
  backendTimeoutMin: 1440,
};

/**
 * 强制续期间隔（毫秒）。
 * Cursor 对 MCP 工具调用存在约 2 小时的硬性超时 (-32001)，
 * 此值必须远小于该上限以确保续期在超时前完成。
 * 设为 55 分钟，给 Cursor 底层留足安全裕量。
 */
const FORCE_RENEW_INTERVAL_MS = 55 * 60_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 合并并校正设置，避免「提前续期 ≥ Agent 超时」等非法组合。
 * autoRenew 被强制为 true——这是对抗 Cursor 硬超时的技术必需品，不可关闭。
 *
 * @param raw - 局部覆盖或完整对象
 */
export function normalizePchatSettings(raw: Partial<PchatSettings> | undefined): PchatSettings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  let agentTimeoutMin = clamp(Math.round(s.agentTimeoutMin), 1, 240);
  let renewBeforeMin = clamp(Math.round(s.renewBeforeMin), 1, 120);
  if (renewBeforeMin >= agentTimeoutMin) {
    renewBeforeMin = Math.max(1, agentTimeoutMin - 1);
  }
  const backendTimeoutMin = clamp(Math.round(s.backendTimeoutMin), 1440, 21600);
  return {
    autoRenew: true, // 强制开启，无视持久化的旧值
    agentTimeoutMin,
    renewBeforeMin,
    backendTimeoutMin,
  };
}

type QueueItem = WaitRequestPayload & { readonly enqueuedAt: number };

/**
 * 协调等待队列、续期定时器与 Webview 同步。
 */
export class PchatCoordinator {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly renewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 记录刚刚自动续期的会话，下一次 enqueueWait 时跳过 appendAssistantMessage */
  private readonly renewedSessionKeys = new Set<string>();
  /** 每个会话最近一次自动续期时间戳 */
  private readonly lastAutoRenewAt = new Map<string, number>();
  private settings: PchatSettings = { ...DEFAULT_SETTINGS };
  private sessions: StoredSession[] = [];
  private activeSessionId = '';
  private bridgeConnected = false;
  private cursorAuthInfo?: CursorAuthInfo;

  /**
   * @param context - 扩展上下文，用于读写 `globalState`
   * @param post - 向 Webview 发消息
   * @param ipc - IPC 服务（发 `waitResult`）
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly post: (msg: ToWebviewMessage) => void,
    private readonly ipc: PchatIpcServer,
  ) {
    this.loadSessions();
    this.settings = this.loadSettings();

    // 异步加载 Cursor Auth 状态，并在完成后推送状态更新
    getCursorAuthInfo().then((info) => {
      this.cursorAuthInfo = info;
      this.postWaitUpdate();

      // 单独拉取使用量，防止网络超时阻塞基础状态的展示
      if (info.accessToken) {
        import('./cursorAuth.js').then(({ fetchStripeUsage }) => {
          fetchStripeUsage(info.accessToken!).then(usd => {
            if (usd && this.cursorAuthInfo) {
               this.cursorAuthInfo.stripeUsageUsd = usd;
               this.postWaitUpdate();
            }
          });
        });
      }
    });
  }

  /**
   * Bridge 套接字连上或断开时由面板更新，用于顶部状态点。
   */
  setBridgeConnected(connected: boolean): void {
    this.bridgeConnected = connected;
    this.postWaitUpdate();
  }

  /**
   * 从磁盘恢复后推送给 Webview。
   */
  pushFullState(): void {
    this.postWaitUpdate();
  }

  /**
   * Bridge 收到新的 `wait_for_user_input` 时由 IPC 层调用。
   */
  enqueueWait(payload: WaitRequestPayload): void {
    const sessionKey = payload.sessionId?.trim();
    if (!sessionKey) {
      return;
    }
    this.ensureSessionForMcp(sessionKey, payload.title);
    if (!this.activeSessionId.trim()) {
      this.activeSessionId = sessionKey;
      void this.persistActiveSession();
    }

    const item: QueueItem = { ...payload, enqueuedAt: Date.now() };
    const q = this.queues.get(sessionKey) ?? [];
    
    if (q.length > 0 && q[q.length - 1].message === payload.message) {
      // 这是一个来自于 Cursor 工具超时的底层重试请求，直接覆盖掉旧的等待，防止 UI 出现多个队列和分裂
      this.clearRenewTimer(q[q.length - 1].requestId);
      q[q.length - 1] = item;
      this.queues.set(sessionKey, q);
    } else {
      q.push(item);
      this.queues.set(sessionKey, q);

      /* 续期后重新入队的等待不写入对话，避免重复消息 */
      if (this.renewedSessionKeys.has(sessionKey)) {
        this.renewedSessionKeys.delete(sessionKey);
      } else {
        this.appendAssistantMessage(sessionKey, payload.message);
      }
    }
    this.scheduleRenewIfNeeded(sessionKey);
    this.postWaitUpdate();
  }

  /**
   * 用户从输入框提交（对当前会话队列队首解析）。
   */
  resolveFrontWithUserText(sessionId: string, text: string): boolean {
    const key = sessionId.trim() || this.activeSessionId;
    if (!key) {
      return false;
    }
    const q = this.queues.get(key);
    const front = q?.[0];
    if (!front) {
      return false;
    }
    this.clearRenewTimer(front.requestId);
    q.shift();
    if (q.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, q);
    }
    this.appendUserMessage(key, text);
    this.ipc.sendWaitResult({ requestId: front.requestId, text });
    this.scheduleRenewIfNeeded(key);
    this.postWaitUpdate();
    return true;
  }

  /**
   * 取消队列中某条等待（向 Bridge 返回哨兵，侧栏可删除排队项或放弃当前）。
   */
  cancelQueuedWait(sessionId: string, requestId: string): boolean {
    const key = sessionId.trim();
    const rid = requestId.trim();
    if (!key || !rid) {
      return false;
    }
    const q = this.queues.get(key);
    if (!q?.length) {
      return false;
    }
    const idx = q.findIndex((x) => x.requestId === rid);
    if (idx < 0) {
      return false;
    }
    const [removed] = q.splice(idx, 1);
    this.clearRenewTimer(removed.requestId);
    if (q.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, q);
    }
    this.ipc.sendWaitResult({
      requestId: removed.requestId,
      text: '__USER_DISMISSED_QUEUE__',
    });
    this.scheduleRenewIfNeeded(key);
    this.postWaitUpdate();
    return true;
  }

  /**
   * 更新设置并持久化。
   */
  updateSettings(partial: Partial<PchatSettings>): void {
    this.settings = normalizePchatSettings({ ...this.settings, ...partial });
    void this.context.globalState.update(SETTINGS_KEY, this.settings);
    this.postWaitUpdate();
    /* 重算续期 */
    for (const key of this.queues.keys()) {
      this.scheduleRenewIfNeeded(key);
    }
  }

  setActiveSession(id: string): void {
    this.activeSessionId = id.trim();
    void this.persistActiveSession();
    this.postWaitUpdate();
  }

  clearSessionMessages(sessionId: string): void {
    const key = sessionId.trim();
    if (!key) {
      return;
    }
    this.sessions = this.sessions.map((s) =>
      s.id === key ? { ...s, messages: [] } : s,
    );
    void this.persistSessions();
    this.pushFullState();
  }

  /**
   * 用户自定义侧栏显示的会话标题。
   */
  renameSession(sessionId: string, title: string): void {
    const key = sessionId.trim();
    if (!key) {
      return;
    }
    const nextTitle = title.trim() || '未命名';
    this.sessions = this.sessions.map((s) => (s.id === key ? { ...s, title: nextTitle } : s));
    void this.persistSessions();
    this.pushFullState();
  }

  deleteSession(sessionId: string): void {
    const key = sessionId.trim();
    if (!key) {
      return;
    }
    const q = this.queues.get(key);
    if (q) {
      for (const item of q) {
        this.clearRenewTimer(item.requestId);
        // 向 Bridge 发送取消哨兵，避免 Agent 永远卡死
        this.ipc.sendWaitResult({ requestId: item.requestId, text: '__USER_DISMISSED_QUEUE__' });
      }
    }
    this.queues.delete(key);

    this.sessions = this.sessions.filter((s) => s.id !== key);
    if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0]?.id ?? '';
    }
    void this.persistSessions();
    void this.persistActiveSession();
    this.pushFullState();
  }

  /**
   * 拖拽重排序后，按前端传来的 ID 顺序更新 sessions 列表。
   */
  reorderSessions(sessionIds: string[]): void {
    if (!sessionIds.length) {
      return;
    }
    const map = new Map(this.sessions.map((s) => [s.id, s]));
    const reordered: StoredSession[] = [];
    for (const id of sessionIds) {
      const s = map.get(id);
      if (s) {
        reordered.push(s);
        map.delete(id);
      }
    }
    // 将未出现在 sessionIds 中的会话追加到末尾（防御性）
    for (const s of map.values()) {
      reordered.push(s);
    }
    this.sessions = reordered;
    void this.persistSessions();
    this.pushFullState();
  }

  /**
   * 一键清空所有会话（包括队列和定时器）。
   */
  clearAllSessions(): void {
    // 清理所有续期定时器，并向 Bridge 发送取消哨兵
    for (const q of this.queues.values()) {
      for (const item of q) {
        this.clearRenewTimer(item.requestId);
        this.ipc.sendWaitResult({ requestId: item.requestId, text: '__USER_DISMISSED_QUEUE__' });
      }
    }
    this.queues.clear();
    this.sessions = [];
    this.activeSessionId = '';
    void this.persistSessions();
    void this.persistActiveSession();
    this.pushFullState();
  }

  /**
   * 若 MCP 传入新的 `sessionId`，自动建会话并切为活动，避免队列与侧栏不同步。
   */
  private ensureSessionForMcp(sessionKey: string, titleHint?: string): void {
    const existing = this.sessions.find((s) => s.id === sessionKey);
    if (existing) {
      // 若 AI 在后续调用中传了更好的标题，更新之（避免一直显示 "对话 1"）
      if (titleHint?.trim() && existing.title !== titleHint.trim()) {
        const isAutoTitle = /^(对话|会话|任务)\s/.test(existing.title);
        if (isAutoTitle) {
          this.sessions = this.sessions.map((s) =>
            s.id === sessionKey ? { ...s, title: titleHint.trim() } : s,
          );
          void this.persistSessions();
        }
      }
      return;
    }
    const title = titleHint?.trim() || this.defaultTitleForSessionKey(sessionKey);
    this.sessions = [...this.sessions, { id: sessionKey, title, messages: [] }];
    void this.persistSessions();
  }

  private defaultTitleForSessionKey(sessionKey: string): string {
    // 新短格式: "0404-1401-a716" → "04/04 14:01"
    const shortMatch = sessionKey.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{4}$/i);
    if (shortMatch) {
      return `${shortMatch[1]}/${shortMatch[2]} ${shortMatch[3]}:${shortMatch[4]}`;
    }
    if (sessionKey === 'pchat-main') {
      return '主对话';
    }
    return `会话 ${sessionKey.slice(0, 10)}`;
  }

  private buildWaitSnapshot() {
    const key = this.activeSessionId.trim();
    const q = key ? (this.queues.get(key) ?? []) : [];
    const front = q[0];
    const progressTotalMs = FORCE_RENEW_INTERVAL_MS;
    const pendingWaits = q.map((item, index) => ({
      requestId: item.requestId,
      message: item.message,
      prompt: item.prompt,
      enqueuedAt: item.enqueuedAt,
      index,
    }));
    return {
      activeSessionId: this.activeSessionId,
      queueLength: q.length,
      pendingWaits,
      front: front
        ? {
            requestId: front.requestId,
            message: front.message,
            prompt: front.prompt,
            enqueuedAt: front.enqueuedAt,
            deadlineMs: front.enqueuedAt + FORCE_RENEW_INTERVAL_MS,
            /** 进度条总时长（强制续期间隔） */
            progressTotalMs,
          }
        : undefined,
      lastAutoRenewAt: this.lastAutoRenewAt.get(key),
      // 所有会话的排队数，供前端显示角标
      sessionQueueCounts: Object.fromEntries(
        [...this.queues.entries()].map(([k, v]) => [k, v.length]),
      ),
    };
  }

  private postWaitUpdate(): void {
    this.post({
      type: 'state',
      payload: {
        sessions: this.sessions,
        activeSessionId: this.activeSessionId,
        settings: this.settings,
        bridgeConnected: this.bridgeConnected,
        waitSnapshot: this.buildWaitSnapshot(),
        cursorInfo: this.cursorAuthInfo,
      },
    });
  }

  private scheduleRenewIfNeeded(sessionKey: string): void {
    const q = this.queues.get(sessionKey);
    const front = q?.[0];
    if (!front) {
      return;
    }
    this.clearRenewTimer(front.requestId);
    // 无条件强制续期，间隔固定 55 分钟，远低于 Cursor 的 ~2 小时硬超时
    const t = setTimeout(() => this.fireRenew(front.requestId, sessionKey), FORCE_RENEW_INTERVAL_MS);
    this.renewTimers.set(front.requestId, t);
  }

  private fireRenew(requestId: string, sessionKey: string): void {
    const q = this.queues.get(sessionKey);
    const front = q?.[0];
    if (!front || front.requestId !== requestId) {
      return;
    }
    this.renewTimers.delete(requestId);
    q.shift();
    if (q.length === 0) {
      this.queues.delete(sessionKey);
    }
    /* 标记该会话刚发生续期，并记录时间戳 */
    this.renewedSessionKeys.add(sessionKey);
    this.lastAutoRenewAt.set(sessionKey, Date.now());
    this.ipc.sendWaitResult({ requestId, text: 'TIMEOUT_RENEW' });
    this.scheduleRenewIfNeeded(sessionKey);
    this.postWaitUpdate();
  }

  private clearRenewTimer(requestId: string): void {
    const t = this.renewTimers.get(requestId);
    if (t) {
      clearTimeout(t);
      this.renewTimers.delete(requestId);
    }
  }

  private appendAssistantMessage(sessionKey: string, body: string): void {
    const sid = this.resolveStoredSessionId(sessionKey);
    this.pushMessage(sid, 'assistant', body);
  }

  private appendUserMessage(sessionKey: string, body: string): void {
    const sid = this.resolveStoredSessionId(sessionKey);
    this.pushMessage(sid, 'user', body);
  }

  private resolveStoredSessionId(sessionKey: string): string {
    /* 禁止把 MCP 消息合并进用户当前选中的其它会话 */
    this.ensureSessionForMcp(sessionKey, undefined);
    return sessionKey;
  }

  private pushMessage(sessionId: string, role: StoredChatMessage['role'], body: string): void {
    const msg: StoredChatMessage = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role,
      body,
      ts: Date.now(),
    };
    this.sessions = this.sessions.map((s) =>
      s.id === sessionId ? { ...s, messages: [...s.messages, msg].slice(-400) } : s,
    );
    void this.persistSessions();
  }

  private loadSettings(): PchatSettings {
    const raw = this.context.globalState.get<PchatSettings>(SETTINGS_KEY);
    return normalizePchatSettings(raw ?? undefined);
  }

  private loadSessions(): void {
    const raw = this.context.globalState.get<StoredSession[]>(SESSIONS_KEY);
    const savedActive = this.context.globalState.get<string>(ACTIVE_SESSION_KEY);
    const filtered = (raw ?? []).filter((s) => s.id !== 'default');
    const migrated = filtered.length !== (raw?.length ?? 0);
    if (filtered.length > 0) {
      this.sessions = filtered;
      this.activeSessionId =
        savedActive && filtered.some((s) => s.id === savedActive) ? savedActive : filtered[0].id;
      if (migrated) {
        void this.persistSessions();
      }
      return;
    }
    this.sessions = [];
    this.activeSessionId = '';
    if (migrated && raw?.length) {
      void this.persistSessions();
    }
  }

  private persistSessions(): void {
    void this.context.globalState.update(SESSIONS_KEY, this.sessions);
  }

  private persistActiveSession(): void {
    void this.context.globalState.update(ACTIVE_SESSION_KEY, this.activeSessionId);
  }
}
