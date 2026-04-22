import * as fs from "node:fs";
import { Buffer } from "node:buffer";
function logDebug(...args: any[]) {
  fs.appendFileSync(
    "/tmp/pchat.log",
    new Date().toISOString() + " [EXT] " + args.map(String).join(" ") + "\n",
  );
}

/**
 * @fileoverview 按会话排队 MCP 等待、驱动续期定时器，并与 Webview / IPC 桥接。
 */

import * as vscode from "vscode";
import type { WaitRequestPayload } from "../shared/ipcProtocol.js";
import type { PchatIpcServer } from "./ipcServer.js";
import type { ToWebviewMessage } from "./webviewProtocol.js";
import { getCursorAuthInfo, type CursorAuthInfo } from "./cursorAuth.js";

const SETTINGS_KEY = "pchat.settings";
const SESSIONS_KEY = "pchat.sessions";
const ACTIVE_SESSION_KEY = "pchat.activeSessionId";
const DELETED_SESSIONS_KEY = "pchat.deletedSessions";
const WORKSPACE_SESSIONS_KEY = "pchat.workspaceSessions";

/** 回收站最多保留的已删除会话数量。 */
const MAX_DELETED_SESSIONS = 20;

/** workspace → sessionId 注册条目最大有效期（24 小时） */
const WORKSPACE_SESSION_DEFAULT_MAX_AGE_MS = 24 * 60 * 60_000;
/** 注册表条目数量上限，超过按 lastActiveTs 旧的淘汰 */
const WORKSPACE_SESSION_MAX_ENTRIES = 100;

/** workspace → sessionId 注册表条目 */
type WorkspaceSessionEntry = {
  sessionId: string;
  lastActiveTs: number;
};

/** 持久化的会话与消息（精简结构，避免 globalState 过大）。 */
export type StoredSession = {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly StoredChatMessage[];
  readonly payload?: {
    enabled: boolean;
    position: "head" | "tail";
    text: string;
  };
};

export type StoredChatMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly body: string;
  readonly ts: number;
};

export type PchatSettings = {
  autoRenew: boolean;
  agentTimeoutMin: number;
  renewBeforeMin: number;
  backendTimeoutMin: number;
  /** 强制续期间隔（分钟），防止 Cursor MCP 硬超时 */
  forceRenewMin: number;
  globalPayload?: { enabled: boolean; position: "head" | "tail"; text: string };
  /** 是否在输入框下方展示广告跑马灯 */
  showAd?: boolean;
};

const DEFAULT_SETTINGS: PchatSettings = {
  autoRenew: true,
  agentTimeoutMin: 110,
  renewBeforeMin: 5,
  backendTimeoutMin: 1440,
  forceRenewMin: 20,
  globalPayload: { enabled: false, position: "tail", text: "" },
  showAd: true,
};

/**
 * Cursor 对 MCP 工具调用存在约 2 小时的硬性超时 (-32001)，
 * 强制续期间隔必须远小于该上限，默认 20 分钟。
 * 现在通过 settings.forceRenewMin 可配置。
 */

/** 每个会话最多保留的消息条数硬上限。 */
const MAX_MESSAGES_PER_SESSION = 100;
/**
 * 每个会话消息体（body）的总字节数软上限（约 2MB）。
 * 超出时从最旧的消息开始裁剪，防止含 base64 图片的消息导致 globalState 膨胀。
 */
const MAX_SESSION_BODY_BYTES = 2 * 1024 * 1024;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 裁剪消息列表：先限制条数（硬上限），再限制总字节数（软上限）。
 * 超出字节上限时从最旧的消息开始移除，但至少保留最后一条。
 */
function trimMessages(msgs: StoredChatMessage[]): StoredChatMessage[] {
  let trimmed =
    msgs.length > MAX_MESSAGES_PER_SESSION
      ? msgs.slice(-MAX_MESSAGES_PER_SESSION)
      : msgs;
  let totalBytes = 0;
  for (const m of trimmed) {
    totalBytes += Buffer.byteLength(m.body, "utf8");
  }
  while (trimmed.length > 1 && totalBytes > MAX_SESSION_BODY_BYTES) {
    totalBytes -= Buffer.byteLength(trimmed[0].body, "utf8");
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/**
 * 合并并校正设置，避免「提前续期 ≥ Agent 超时」等非法组合。
 * autoRenew 被强制为 true——这是对抗 Cursor 硬超时的技术必需品，不可关闭。
 *
 * @param raw - 局部覆盖或完整对象
 */
export function normalizePchatSettings(
  raw: Partial<PchatSettings> | undefined,
): PchatSettings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  let agentTimeoutMin = clamp(Math.round(s.agentTimeoutMin), 1, 240);
  let renewBeforeMin = clamp(Math.round(s.renewBeforeMin), 1, 120);
  if (renewBeforeMin >= agentTimeoutMin) {
    renewBeforeMin = Math.max(1, agentTimeoutMin - 1);
  }
  const backendTimeoutMin = clamp(Math.round(s.backendTimeoutMin), 1440, 21600);
  const forceRenewMin = clamp(Math.round(s.forceRenewMin ?? 20), 1, 120);
  return {
    autoRenew: true, // 强制开启，无视持久化的旧值
    agentTimeoutMin,
    renewBeforeMin,
    backendTimeoutMin,
    forceRenewMin,
    globalPayload: s.globalPayload ?? {
      enabled: false,
      position: "tail",
      text: "",
    },
    showAd: s.showAd !== false, // 默认开启广告
  };
}

type QueueItem = WaitRequestPayload & { readonly enqueuedAt: number };

/**
 * 协调等待队列、续期定时器与 Webview 同步。
 */
export class PchatCoordinator {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly renewTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** 记录刚刚自动续期的会话，下一次 enqueueWait 时跳过 appendAssistantMessage */
  private readonly renewedSessionKeys = new Set<string>();
  /** 每个会话最近一次自动续期时间戳 */
  private readonly lastAutoRenewAt = new Map<string, number>();
  /** 每个会话的运行元数据：创建时间、保活次数 */
  private readonly sessionMeta = new Map<
    string,
    { createdAt: number; renewCount: number }
  >();
  private settings: PchatSettings = { ...DEFAULT_SETTINGS };
  private sessions: StoredSession[] = [];
  /** 已删除会话回收站，支持通过 ID 恢复。 */
  private deletedSessions: StoredSession[] = [];
  /** workspace 路径 → 最近活跃 sessionId 注册表 */
  private workspaceSessions = new Map<string, WorkspaceSessionEntry>();
  private activeSessionId = "";
  private bridgeConnected = false;
  private cursorAuthInfo?: CursorAuthInfo;
  /** persistSessions 防抖定时器，避免高频序列化。 */
  private persistDebounce: ReturnType<typeof setTimeout> | undefined;
  /** persistWorkspaceSessions 防抖定时器 */
  private persistWorkspaceDebounce: ReturnType<typeof setTimeout> | undefined;
  /** rules 自动安装状态，传给 Webview */
  private rulesStatus?: {
    status: "ok" | "error" | "disabled";
    message: string;
    timestamp: number;
  };

  setRulesStatus(status: {
    status: "ok" | "error" | "disabled";
    message: string;
    timestamp: number;
  }): void {
    this.rulesStatus = status;
    this.postWaitUpdate();
  }

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
    this.loadDeletedSessions();
    this.loadWorkspaceSessions();
    this.settings = this.loadSettings();

    getCursorAuthInfo().then((info) => {
      this.cursorAuthInfo = info;
      this.postWaitUpdate();
    });
  }

  /**
   * Bridge 套接字连上或断开时由面板更新，用于顶部状态点。
   * 重连时顺便清理「无消息且无排队」的孤儿会话（重试/断线残留）。
   */
  setBridgeConnected(connected: boolean): void {
    const wasDisconnected = !this.bridgeConnected;
    this.bridgeConnected = connected;
    if (connected && wasDisconnected) {
      this.pruneOrphanedSessions();
    }
    this.postWaitUpdate();
  }

  /**
   * 删除所有无消息且无排队的空会话，避免重试/断线留下的孤儿条目堆积在侧栏。
   * 不会清理当前活动会话，即使它是空的（用户可能正要输入）。
   */
  private pruneOrphanedSessions(): void {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => {
      if (s.id === this.activeSessionId) return true;
      if (s.messages.length > 0) return true;
      if (this.queues.has(s.id) && this.queues.get(s.id)!.length > 0)
        return true;
      return false;
    });
    if (this.sessions.length < before) {
      void this.persistSessions();
    }
  }

  /**
   * 从磁盘恢复后推送给 Webview。
   * 同步 IPC 实际连接状态，避免 Webview 恢复时显示过时的离线状态。
   */
  pushFullState(): void {
    this.bridgeConnected = this.ipc.isConnected;
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
    this.ensureSessionMeta(sessionKey);
    if (payload.workspacePath) {
      this.recordSessionForWorkspace(payload.workspacePath, sessionKey);
    }
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

  private assembleTextWithPayload(sessionId: string, baseText: string): string {
    const session = this.sessions.find((s) => s.id === sessionId);
    const gPayload = this.settings.globalPayload;
    const sPayload = session?.payload;
    let headStrs: string[] = [];
    let tailStrs: string[] = [];
    if (gPayload?.enabled && gPayload.text.trim()) {
      if (gPayload.position === "head") headStrs.push(gPayload.text);
      else tailStrs.push(gPayload.text);
    }
    if (sPayload?.enabled && sPayload.text.trim()) {
      if (sPayload.position === "head") headStrs.push(sPayload.text);
      else tailStrs.push(sPayload.text);
    }
    const result: string[] = [];
    if (headStrs.length) result.push(headStrs.join("\\n\\n"));
    result.push(baseText);
    if (tailStrs.length) result.push(tailStrs.join("\\n\\n"));
    return result.join("\\n\\n");
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

    const assembledText = this.assembleTextWithPayload(key, text);

    this.clearRenewTimer(front.requestId);
    q.shift();
    if (q.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, q);
    }
    this.appendUserMessage(key, assembledText);
    this.ipc.sendWaitResult({
      requestId: front.requestId,
      text: assembledText,
    });
    this.scheduleRenewIfNeeded(key);
    this.postWaitUpdate();
    return true;
  }
  /**
   * 群发消息到选定的一组会话中。
   */
  broadcastSelectedUserText(sessionIds: string[], text: string): void {
    const ids = new Set(sessionIds);
    let sent = false;
    for (const key of ids) {
      const q = this.queues.get(key);
      const front = q?.[0];
      const assembledText = this.assembleTextWithPayload(key, text);

      if (front) {
        this.clearRenewTimer(front.requestId);
        q.shift();
        if (q.length === 0) {
          this.queues.delete(key);
        } else {
          this.queues.set(key, q);
        }
        this.appendUserMessage(key, assembledText);
        this.ipc.sendWaitResult({
          requestId: front.requestId,
          text: assembledText,
        });
        this.scheduleRenewIfNeeded(key);
      } else {
        // 未在排队的情况下直接录入会话中
        this.appendUserMessage(key, assembledText);
      }
      sent = true;
    }
    if (sent) {
      this.pushFullState();
      this.postWaitUpdate();
    }
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
      text: "__USER_DISMISSED_QUEUE__",
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

  updateSessionPayload(
    sessionId: string,
    payload: { enabled: boolean; position: "head" | "tail"; text: string },
  ): void {
    const key = sessionId.trim();
    if (!key) return;
    this.sessions = this.sessions.map((s) =>
      s.id === key ? { ...s, payload } : s,
    );
    void this.persistSessions();
    this.pushFullState();
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
    const nextTitle = title.trim() || "未命名";
    this.sessions = this.sessions.map((s) =>
      s.id === key ? { ...s, title: nextTitle } : s,
    );
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
        this.ipc.sendWaitResult({
          requestId: item.requestId,
          text: "__USER_DISMISSED_QUEUE__",
        });
      }
    }
    this.queues.delete(key);

    // 将被删除的会话存入回收站
    const removed = this.sessions.find((s) => s.id === key);
    if (removed) {
      this.pushToDeletedSessions(removed);
    }

    this.sessions = this.sessions.filter((s) => s.id !== key);
    if (!this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0]?.id ?? "";
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
        this.ipc.sendWaitResult({
          requestId: item.requestId,
          text: "__USER_DISMISSED_QUEUE__",
        });
      }
    }
    this.queues.clear();
    // 将所有会话存入回收站
    for (const s of this.sessions) {
      this.pushToDeletedSessions(s);
    }
    this.sessions = [];
    this.activeSessionId = "";
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
    const title =
      titleHint?.trim() || this.defaultTitleForSessionKey(sessionKey);
    this.sessions = [...this.sessions, { id: sessionKey, title, messages: [] }];
    void this.persistSessions();
  }

  private defaultTitleForSessionKey(sessionKey: string): string {
    // 新格式 "1941-a716b2c3" → "19:41"
    const newMatch = sessionKey.match(/^(\d{2})(\d{2})-[0-9a-f]{4,8}$/i);
    if (newMatch) {
      return `${newMatch[1]}:${newMatch[2]}`;
    }
    // 兼容旧格式 "0404-1401-a716" → "04/04 14:01"
    const oldMatch = sessionKey.match(
      /^(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{4,8}$/i,
    );
    if (oldMatch) {
      return `${oldMatch[1]}/${oldMatch[2]} ${oldMatch[3]}:${oldMatch[4]}`;
    }
    if (sessionKey === "pchat-main") {
      return "主对话";
    }
    return `会话 ${sessionKey.slice(0, 10)}`;
  }

  private buildWaitSnapshot() {
    const key = this.activeSessionId.trim();
    const q = key ? (this.queues.get(key) ?? []) : [];
    const front = q[0];
    const progressTotalMs = this.getForceRenewIntervalMs();
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
            deadlineMs: front.enqueuedAt + this.getForceRenewIntervalMs(),
            /** 进度条总时长（强制续期间隔） */
            progressTotalMs,
          }
        : undefined,
      lastAutoRenewAt: this.lastAutoRenewAt.get(key),
      // 所有会话的排队数，供前端显示角标
      sessionQueueCounts: Object.fromEntries(
        [...this.queues.entries()].map(([k, v]) => [k, v.length]),
      ),
      // 当前活动会话的运行元数据
      sessionMeta: key ? this.sessionMeta.get(key) : undefined,
    };
  }

  private postWaitUpdate(): void {
    this.post({
      type: "state",
      payload: {
        sessions: this.sessions,
        activeSessionId: this.activeSessionId,
        settings: this.settings,
        bridgeConnected: this.bridgeConnected,
        waitSnapshot: this.buildWaitSnapshot(),
        cursorInfo: this.cursorAuthInfo,
        rulesStatus: this.rulesStatus,
      },
    });
  }

  /** 从 settings 动态获取强制续期间隔（毫秒）。 */
  private getForceRenewIntervalMs(): number {
    return (this.settings.forceRenewMin ?? 20) * 60_000;
  }

  private scheduleRenewIfNeeded(sessionKey: string): void {
    const q = this.queues.get(sessionKey);
    const front = q?.[0];
    if (!front) {
      return;
    }
    this.clearRenewTimer(front.requestId);
    // 无条件强制续期，间隔由 settings.forceRenewMin 控制（默认 20 分钟）
    const t = setTimeout(
      () => this.fireRenew(front.requestId, sessionKey),
      this.getForceRenewIntervalMs(),
    );
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
    /* 标记该会话刚发生续期，并记录时间戳与计数 */
    this.renewedSessionKeys.add(sessionKey);
    this.lastAutoRenewAt.set(sessionKey, Date.now());
    const meta = this.sessionMeta.get(sessionKey);
    if (meta) {
      meta.renewCount += 1;
    }
    this.ipc.sendWaitResult({ requestId, text: "TIMEOUT_RENEW" });
    this.scheduleRenewIfNeeded(sessionKey);
    this.postWaitUpdate();
  }

  /** 确保会话元数据存在（首次创建时设置 createdAt）。 */
  private ensureSessionMeta(sessionKey: string): void {
    if (!this.sessionMeta.has(sessionKey)) {
      this.sessionMeta.set(sessionKey, {
        createdAt: Date.now(),
        renewCount: 0,
      });
    }
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
    this.pushMessage(sid, "assistant", body);
  }

  private appendUserMessage(sessionKey: string, body: string): void {
    const sid = this.resolveStoredSessionId(sessionKey);
    this.pushMessage(sid, "user", body);
  }

  private resolveStoredSessionId(sessionKey: string): string {
    /* 禁止把 MCP 消息合并进用户当前选中的其它会话 */
    this.ensureSessionForMcp(sessionKey, undefined);
    return sessionKey;
  }

  private pushMessage(
    sessionId: string,
    role: StoredChatMessage["role"],
    body: string,
  ): void {
    const msg: StoredChatMessage = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role,
      body,
      ts: Date.now(),
    };
    this.sessions = this.sessions.map((s) =>
      s.id === sessionId
        ? { ...s, messages: trimMessages([...s.messages, msg]) }
        : s,
    );
    void this.persistSessions();
  }

  /**
   * 通过会话 ID 从回收站恢复已删除的会话。
   * 返回恢复是否成功。
   */
  restoreSession(sessionId: string): boolean {
    const key = sessionId.trim();
    if (!key) {
      return false;
    }
    // 检查是否已经存在于当前会话列表中
    if (this.sessions.some((s) => s.id === key)) {
      // 会话已存在，直接切换过去
      this.activeSessionId = key;
      void this.persistActiveSession();
      this.pushFullState();
      return true;
    }
    // 从回收站查找
    const idx = this.deletedSessions.findIndex((s) => s.id === key);
    if (idx < 0) {
      return false;
    }
    const [restored] = this.deletedSessions.splice(idx, 1);
    this.sessions.push(restored);
    this.activeSessionId = restored.id;
    void this.persistSessions();
    void this.persistActiveSession();
    void this.persistDeletedSessions();
    this.pushFullState();
    return true;
  }

  /**
   * 记录某工作区最近一次活跃 sessionId；同 workspace 后写覆盖前写。
   * 超出条目上限时按 lastActiveTs 旧的淘汰。
   */
  recordSessionForWorkspace(workspacePath: string, sessionId: string): void {
    const wp = workspacePath.trim();
    const sid = sessionId.trim();
    if (!wp || !sid) return;
    this.workspaceSessions.set(wp, {
      sessionId: sid,
      lastActiveTs: Date.now(),
    });
    if (this.workspaceSessions.size > WORKSPACE_SESSION_MAX_ENTRIES) {
      const sorted = [...this.workspaceSessions.entries()].sort(
        (a, b) => a[1].lastActiveTs - b[1].lastActiveTs,
      );
      const drop = sorted.length - WORKSPACE_SESSION_MAX_ENTRIES;
      for (let i = 0; i < drop; i++) {
        this.workspaceSessions.delete(sorted[i][0]);
      }
    }
    this.persistWorkspaceSessions();
  }

  /**
   * 查询某工作区最近活跃 sessionId；超出 maxAgeMs 视为失效。
   *
   * @returns 命中且未过期返回条目，否则 undefined
   */
  findLatestSessionForWorkspace(
    workspacePath: string,
    maxAgeMs: number = WORKSPACE_SESSION_DEFAULT_MAX_AGE_MS,
  ): WorkspaceSessionEntry | undefined {
    const wp = workspacePath.trim();
    if (!wp) return undefined;
    const entry = this.workspaceSessions.get(wp);
    if (!entry) return undefined;
    if (Date.now() - entry.lastActiveTs > maxAgeMs) {
      this.workspaceSessions.delete(wp);
      this.persistWorkspaceSessions();
      return undefined;
    }
    /* 命中且会话仍在 sessions 列表里才认为可恢复，避免指向已被删除的 sessionId */
    if (!this.sessions.some((s) => s.id === entry.sessionId)) {
      this.workspaceSessions.delete(wp);
      this.persistWorkspaceSessions();
      return undefined;
    }
    return entry;
  }

  private loadWorkspaceSessions(): void {
    const raw = this.context.globalState.get<
      Record<string, WorkspaceSessionEntry>
    >(WORKSPACE_SESSIONS_KEY);
    if (!raw) return;
    for (const [wp, entry] of Object.entries(raw)) {
      if (entry?.sessionId && typeof entry.lastActiveTs === "number") {
        this.workspaceSessions.set(wp, {
          sessionId: entry.sessionId,
          lastActiveTs: entry.lastActiveTs,
        });
      }
    }
  }

  private persistWorkspaceSessions(): void {
    if (this.persistWorkspaceDebounce) {
      clearTimeout(this.persistWorkspaceDebounce);
    }
    this.persistWorkspaceDebounce = setTimeout(() => {
      this.persistWorkspaceDebounce = undefined;
      const obj = Object.fromEntries(this.workspaceSessions);
      void this.context.globalState.update(WORKSPACE_SESSIONS_KEY, obj);
    }, 500);
  }

  private loadSettings(): PchatSettings {
    const raw = this.context.globalState.get<PchatSettings>(SETTINGS_KEY);
    return normalizePchatSettings(raw ?? undefined);
  }

  private loadSessions(): void {
    const raw = this.context.globalState.get<StoredSession[]>(SESSIONS_KEY);
    const savedActive =
      this.context.globalState.get<string>(ACTIVE_SESSION_KEY);
    const filtered = (raw ?? []).filter((s) => s.id !== "default");
    const migrated = filtered.length !== (raw?.length ?? 0);
    if (filtered.length > 0) {
      this.sessions = filtered;
      this.activeSessionId =
        savedActive && filtered.some((s) => s.id === savedActive)
          ? savedActive
          : filtered[0].id;
      if (migrated) {
        this.flushPersistSessions();
      }
      return;
    }
    this.sessions = [];
    this.activeSessionId = "";
    if (migrated && raw?.length) {
      this.flushPersistSessions();
    }
  }

  private loadDeletedSessions(): void {
    this.deletedSessions =
      this.context.globalState.get<StoredSession[]>(DELETED_SESSIONS_KEY) ?? [];
  }

  /**
   * 防抖持久化会话列表（500ms），合并高频写入。
   * AI 快速连续发送多条消息时避免每条都 JSON 序列化整个 sessions 数组。
   */
  private persistSessions(): void {
    if (this.persistDebounce) {
      clearTimeout(this.persistDebounce);
    }
    this.persistDebounce = setTimeout(() => {
      this.persistDebounce = undefined;
      void this.context.globalState.update(SESSIONS_KEY, this.sessions);
    }, 500);
  }

  /** 立即写入会话（跳过防抖），用于 loadSessions 迁移等必须即时生效的场景。 */
  private flushPersistSessions(): void {
    if (this.persistDebounce) {
      clearTimeout(this.persistDebounce);
      this.persistDebounce = undefined;
    }
    void this.context.globalState.update(SESSIONS_KEY, this.sessions);
  }

  private persistActiveSession(): void {
    void this.context.globalState.update(
      ACTIVE_SESSION_KEY,
      this.activeSessionId,
    );
  }

  private persistDeletedSessions(): void {
    void this.context.globalState.update(
      DELETED_SESSIONS_KEY,
      this.deletedSessions,
    );
  }

  /**
   * 将会话加入回收站头部，超出上限时从尾部淘汰最旧的。
   * 为节省内存，仅保留 id 和 title，丢弃消息体。
   */
  private pushToDeletedSessions(session: StoredSession): void {
    // 只保留 id + title，清空消息体以节省内存
    const slim: StoredSession = {
      id: session.id,
      title: session.title,
      messages: [],
    };
    // 如果回收站中已有同 ID 的旧记录，先移除
    this.deletedSessions = this.deletedSessions.filter(
      (s) => s.id !== session.id,
    );
    this.deletedSessions.unshift(slim);
    // 超出上限时裁掉最旧的
    if (this.deletedSessions.length > MAX_DELETED_SESSIONS) {
      this.deletedSessions = this.deletedSessions.slice(
        0,
        MAX_DELETED_SESSIONS,
      );
    }
    void this.persistDeletedSessions();
  }
}
