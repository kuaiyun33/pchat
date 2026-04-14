/**
 * @fileoverview 消息列表区域：空态展示、分页加载、消息气泡渲染和「滚动到底部」浮动按钮。
 */
import type { Ref } from 'preact';
import { MessageBubble } from './MessageBubble';
import type { StoredChatMessage } from '../types';

type MessageListProps = {
  activeSessionId: string;
  active: { messages: readonly StoredChatMessage[] } | undefined;
  visibleMessages: readonly StoredChatMessage[];
  totalCount: number;
  visibleLimit: number;
  hasMore: boolean;
  msgsRef: Ref<HTMLDivElement>;
  onScroll: () => void;
  onLoadMore: () => void;
  onShowAll: () => void;
  /** 是否显示「滚动到底部」浮动按钮 */
  showScrollBtn: boolean;
  onScrollToBottom: () => void;
  /** 拖放文件回调（复用 Composer 的逻辑） */
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  bridgeConnected: boolean;
};

export function MessageList({
  activeSessionId,
  active,
  visibleMessages,
  totalCount,
  visibleLimit,
  hasMore,
  msgsRef,
  onScroll,
  onLoadMore,
  onShowAll,
  showScrollBtn,
  onScrollToBottom,
  onDragOver,
  onDrop,
  bridgeConnected,
}: MessageListProps) {
  return (
    <div class="pchat-msgs-wrap">
      <div class="pchat-msgs" ref={msgsRef} onScroll={onScroll} onDragOver={onDragOver} onDrop={onDrop}>
        {!bridgeConnected ? (
          <div class="pchat-empty">
            <i class="bx bx-error-circle" style={{ fontSize: 36, opacity: 0.4, display: 'block', marginBottom: 12, color: 'var(--vscode-errorForeground, #ef4444)' }}></i>
            <strong style={{ fontSize: 14, color: 'var(--pchat-text)', display: 'block', marginBottom: 8 }}>Bridge 未连接</strong>
            <span style={{ opacity: 0.7, display: 'block', lineHeight: 1.6 }}>
              请在 Cursor 的 MCP 列表里开启或重新挂载（Refresh）<code>pchat</code>。
            </span>
          </div>
        ) : !activeSessionId.trim() ? (
          <div class="pchat-empty">
            <i class="bx bx-plug" style={{ fontSize: 36, opacity: 0.4, display: 'block', marginBottom: 12 }}></i>
            <strong style={{ fontSize: 14, color: 'var(--pchat-text)', display: 'block', marginBottom: 8 }}>等待接入</strong>
            <span style={{ opacity: 0.7 }}>请在新 Agent 对话框发送任意字符触发</span>
          </div>
        ) : !active ? (
          <div class="pchat-empty">
            <i class="bx bx-pointer" style={{ fontSize: 36, opacity: 0.4, display: 'block', marginBottom: 12 }}></i>
            <strong style={{ fontSize: 14, color: 'var(--pchat-text)', display: 'block', marginBottom: 8 }}>暂未选择</strong>
            <span style={{ opacity: 0.7 }}>请从左侧选择一个会话</span>
          </div>
        ) : !active.messages.length ? (
          <div class="pchat-empty">
            <i class="bx bx-bot" style={{ fontSize: 36, opacity: 0.4, display: 'block', marginBottom: 12 }} />
            <strong style={{ fontSize: 14, color: 'var(--pchat-text)', display: 'block', marginBottom: 8 }}>等待 Agent 提问...</strong>
            <span style={{ opacity: 0.7, display: 'block', marginTop: 4 }}>
              支持引用文件、拖放和粘贴截图
            </span>
          </div>
        ) : (
          <>
            {hasMore && (
              <div class="pchat-load-more">
                <button
                  type="button"
                  class="pchat-load-more-btn"
                  onClick={onLoadMore}
                >
                  <i class="bx bx-chevron-up" />
                  查看更多历史（还有 {totalCount - visibleLimit} 条）
                </button>
                <button
                  type="button"
                  class="pchat-load-all-btn"
                  onClick={onShowAll}
                  title="展开全部历史">
                  全部
                </button>
              </div>
            )}
            {visibleMessages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          </>
        )}
      </div>
      {showScrollBtn && (
        <button
          type="button"
          class="pchat-scroll-bottom-btn"
          title="回到最新消息"
          onClick={onScrollToBottom}
        >
          <i class="bx bx-chevron-down" />
        </button>
      )}
    </div>
  );
}
