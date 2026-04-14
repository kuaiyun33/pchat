/**
 * @fileoverview 扩展宿主 ⟷ Webview 的 JSON 消息类型（与 Preact 侧镜像一致）。
 */

import type { PchatSettings, StoredSession } from './coordinator.js';

/** @file 列表项（@ 引用） */
export type WorkspaceFileItem = {
  readonly rel: string;
  readonly fsPath: string;
};

/** 宿主 → Webview */
export type ToWebviewMessage =
  | {
      type: 'state';
      payload: {
        sessions: readonly StoredSession[];
        activeSessionId: string;
        settings: PchatSettings;
        bridgeConnected: boolean;
        waitSnapshot: {
          activeSessionId: string;
          queueLength: number;
          /** 当前会话内全部等待（0=队首即当前），供输入框上方排队区展示 */
          pendingWaits: readonly {
            readonly requestId: string;
            readonly message: string;
            readonly prompt?: string;
            readonly enqueuedAt: number;
            readonly index: number;
          }[];
          front?: {
            requestId: string;
            message: string;
            prompt?: string;
            enqueuedAt: number;
            deadlineMs: number;
            /** 进度条总时长（ms），为 Agent 与工具上限的较小值 */
            progressTotalMs: number;
          };
          /** 最近一次自动续期的时间戳（毫秒），无则 undefined */
          lastAutoRenewAt?: number;
          /** 所有会话的排队等待数量 { sessionId: count } */
          sessionQueueCounts: Record<string, number>;
          /** 当前活动会话的运行元数据 */
          sessionMeta?: { createdAt: number; renewCount: number };
        };
        cursorInfo?: import('./cursorAuth.js').CursorAuthInfo;
        rulesStatus?: { status: 'ok' | 'error' | 'disabled'; message: string; timestamp: number };
      };
    }
  | { type: 'ref'; payload: { path: string; label: string; snippet: string } }
  | {
      type: 'at:matches';
      payload: { query: string; seq: number; items: readonly WorkspaceFileItem[] };
    }
  | { type: 'submit:ack'; payload: { ok: boolean } }
  | { type: 'rules:result'; payload: { ok: boolean; message: string } };

/** Webview → 宿主 */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'rules:rewrite' }
  | { type: 'submit'; sessionId: string; text: string }
  | { type: 'submit:broadcast_selected'; sessionIds: string[]; text: string }
  | { type: 'settings'; settings: Partial<PchatSettings> }
  | { type: 'session:active'; sessionId: string }
  | { type: 'session:clear'; sessionId: string }
  | { type: 'session:delete'; sessionId: string; title?: string }
  | { type: 'session:clear-all' }
  | { type: 'session:rename'; sessionId: string; title: string }
  | { type: 'session:reorder'; sessionIds: string[] }
  | { type: 'session:restore'; sessionId: string }
  | { type: 'session:payload'; sessionId: string; payload: { enabled: boolean; position: 'head' | 'tail'; text: string; } }
  | { type: 'file:pick' }
  | { type: 'at:suggest'; query: string; seq: number }
  | { type: 'ref:fsPath'; fsPath: string }
  | { type: 'queue:cancel'; sessionId: string; requestId: string }
  | { type: 'requestActiveContext' };
