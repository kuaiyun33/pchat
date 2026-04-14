/**
 * @fileoverview 底部输入区域：@ 补全、图片附件、文件引用、发送/等待队列、快捷指令。
 * @ 补全状态和大部分交互回调由 App 提供，本组件负责渲染。
 */
import type { Ref } from 'preact';
import { CommandPalette } from './CommandPalette';
import { IconImage, IconFile } from './ToolbarIcons';
import type { VsCodeApi } from '../vscode';
import {
  buildSubmitBody,
  truncateOneLine,
  type AtItem,
  type FileRef,
  type ImageAttach,
  type OutboxItem,
  type WaitFront,
  type WaitPendingRow,
} from '../types';

type ComposerProps = {
  vscode: VsCodeApi;
  activeSessionId: string;
  /* 队列数据 */
  front: WaitFront | undefined;
  pendingTail: readonly WaitPendingRow[];
  sendQueue: readonly OutboxItem[];
  /* 输入状态 */
  draft: string;
  refs: FileRef[];
  images: ImageAttach[];
  submitting: boolean;
  canPrimaryAction: boolean;
  /* 等待队列预写 */
  queuedDrafts: Record<string, string>;
  /* 计时 */
  waitElapsed: string;
  sessionRuntime: string;
  renewCount: number;
  /* @ 补全 */
  atOpen: boolean;
  atItems: readonly AtItem[];
  atHighlight: number;
  /* 回调 */
  onDraftInput: (e: Event) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onPasteImages: (e: ClipboardEvent) => void;
  onComposerDragOver: (e: DragEvent) => void;
  onComposerDrop: (e: DragEvent) => void;
  onTriggerAtMenu: () => void;
  onPrimaryAction: () => void;
  pickAtItem: (it: AtItem) => void;
  onSetImages: (fn: (prev: ImageAttach[]) => ImageAttach[]) => void;
  onSetRefs: (fn: (prev: FileRef[]) => FileRef[]) => void;
  onQueuedDraftChange: (requestId: string, text: string) => void;
  onRemoveOutboxItem: (sid: string, itemId: string) => void;
  onMoveOutboxToComposer: (sid: string, item: OutboxItem) => void;
  addImageFiles: (files: FileList | File[]) => void;
  applyCustomCmd: (text: string) => void;
  sessionPayloadEnabled?: boolean;
  onOpenSessionPayload?: () => void;
  /* 转发的 refs */
  taRef: Ref<HTMLTextAreaElement>;
  imgInputRef: Ref<HTMLInputElement>;
};

export function Composer({
  vscode,
  activeSessionId,
  front,
  pendingTail,
  sendQueue,
  draft,
  refs,
  images,
  submitting,
  canPrimaryAction,
  queuedDrafts,
  waitElapsed,
  sessionRuntime,
  renewCount,
  atOpen,
  atItems,
  atHighlight,
  onDraftInput,
  onKeyDown,
  onPasteImages,
  onComposerDragOver,
  onComposerDrop,
  onTriggerAtMenu,
  onPrimaryAction,
  pickAtItem,
  onSetImages,
  onSetRefs,
  onQueuedDraftChange,
  onRemoveOutboxItem,
  onMoveOutboxToComposer,
  addImageFiles,
  applyCustomCmd,
  sessionPayloadEnabled,
  onOpenSessionPayload,
  taRef,
  imgInputRef,
}: ComposerProps) {
  return (
    <div
      class="pchat-composer"
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
    >
      {/* ─── 发送队列 ─── */}
      {activeSessionId.trim() && sendQueue.length > 0 ? (
        <div class="pchat-send-queue">
          <div class="pchat-send-queue-h">
            <i class="bx bx-paper-plane" /> 发送队列（轮到时自动发出）
          </div>
          {sendQueue.map((it, idx) => (
            <div key={it.id} class="pchat-send-q-item">
              <div class="pchat-send-q-meta">
                <span class="pchat-send-q-badge">#{idx + 1}</span>
                <span class="pchat-send-q-preview" title={buildSubmitBody(it.draft, it.refs, it.images)}>
                  {truncateOneLine(it.draft, 100)}
                  {it.refs.length || it.images.length ? (
                    <span class="pchat-send-q-attach">
                      {' '}
                      · {it.images.length ? `图×${it.images.length}` : ''}
                      {it.images.length && it.refs.length ? ' ' : ''}
                      {it.refs.length ? `文件×${it.refs.length}` : ''}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  class="pchat-send-q-action"
                  title="载入到输入框编辑"
                  onClick={() => onMoveOutboxToComposer(activeSessionId, it)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="pchat-send-q-remove"
                  title="从发送队列移除"
                  onClick={() => onRemoveOutboxItem(activeSessionId, it.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ─── 等待排队 ─── */}
      {activeSessionId.trim() && pendingTail.length > 0 ? (
        <div class="pchat-out-queue">
          <div class="pchat-out-queue-h">
            <i class="bx bx-list-ul" /> 等待排队中（可预先填写回复）
          </div>
          {pendingTail.map((w) => (
            <div key={w.requestId} class="pchat-out-q-item">
              <div class="pchat-out-q-meta">
                <span class="pchat-out-q-badge">#{w.index + 1}</span>
                <span class="pchat-out-q-preview" title={w.message}>
                  {truncateOneLine(w.message, 120)}
                </span>
                <button
                  type="button"
                  class="pchat-out-q-remove"
                  title="从队列移除"
                  onClick={() =>
                    vscode.postMessage({
                      type: 'queue:cancel',
                      sessionId: activeSessionId,
                      requestId: w.requestId,
                    })
                  }
                >
                  移除
                </button>
              </div>
              <textarea
                class="pchat-out-q-draft"
                rows={2}
                placeholder="预写回复..."
                value={queuedDrafts[w.requestId] ?? ''}
                onInput={(e) => {
                  const v = (e.target as HTMLTextAreaElement).value;
                  onQueuedDraftChange(w.requestId, v);
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {/* ─── 工具栏 ─── */}
      <div class="pchat-composer-tools" style={{ display: 'flex', alignItems: 'center' }}>
        <button
          type="button"
          class="pchat-icon-btn pchat-btn-sec"
          title="提起当前上下文 (@)"
          onClick={onTriggerAtMenu}
        >
          <span style={{ fontSize: '15px', fontWeight: 600 }}>@</span>
        </button>
        <button
          type="button"
          class="pchat-icon-btn pchat-btn-sec"
          title="插入图片"
          onClick={() => (imgInputRef as any).current?.click()}
        >
          <IconImage />
        </button>
        <button
          type="button"
          class="pchat-icon-btn pchat-btn-sec"
          title="附加工作区文件"
          onClick={() => vscode.postMessage({ type: 'file:pick' })}
        >
          <IconFile />
        </button>
        <CommandPalette onApply={applyCustomCmd} />
        <button
          type="button"
          class="pchat-icon-btn pchat-btn-sec"
          title="会话附加内容规则 (点击设置)"
          onClick={onOpenSessionPayload}
          style={{ 
            color: sessionPayloadEnabled ? '#10b981' : 'var(--pchat-text)',
            marginLeft: '4px'
          }}
        >
          <i class={sessionPayloadEnabled ? 'bx bxs-tag' : 'bx bx-tag'} style={{ fontSize: '15px' }} />
        </button>
        {front ? (
          <div
            title="已等待时间"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              color: 'var(--pchat-text)',
              opacity: 0.8,
              marginLeft: 'auto',
              paddingRight: 8
            }}
          >
            <i class="bx bx-loader-alt bx-spin" style={{ color: 'var(--pchat-warning)' }} />
            <span>
              等待中 <span style={{ color: 'var(--pchat-warning)', fontWeight: 600, fontFamily: 'monospace', fontSize: 13, letterSpacing: '0.5px' }}>{waitElapsed}</span>
            </span>
            {sessionRuntime ? (
              <span style={{ marginLeft: 6, color: 'var(--pchat-text)', opacity: 0.6, fontFamily: 'monospace', fontSize: 11 }} title="会话运行时间">
                · {sessionRuntime}
              </span>
            ) : null}
            {renewCount > 0 ? (
              <span
                style={{ marginLeft: 4, fontSize: 10, lineHeight: '16px', padding: '0 4px', borderRadius: 8, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', fontWeight: 600 }}
                title={`已保活 ${renewCount} 次`}
              >
                ♻{renewCount}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ─── 附件标签 ─── */}
      {images.length > 0 || refs.length > 0 ? (
        <div class="pchat-chips-scroll" role="list">
          {images.map((im) => (
            <span key={im.id} class="pchat-chip pchat-chip-img" title={im.name}>
              <i class="bx bx-image" />
              {im.name}
              <button
                type="button"
                aria-label="移除"
                onClick={() => onSetImages((x) => x.filter((y) => y.id !== im.id))}
              >
                ×
              </button>
            </span>
          ))}
          {refs.map((r, i) => (
            <span key={`${r.path}-${i}`} class="pchat-chip" title={r.path}>
              <i class="bx bx-file" />
              {r.label}
              <button
                type="button"
                aria-label="移除"
                onClick={() => onSetRefs((x) => x.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* ─── 隐藏文件输入 ─── */}
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        multiple
        class="pchat-hidden-input"
        onChange={(e) => {
          const fl = (e.target as HTMLInputElement).files;
          if (fl?.length) {
            addImageFiles(fl);
          }
          (e.target as HTMLInputElement).value = '';
        }}
      />

      {/* ─── @ 补全 + 输入框 + 发送按钮 ─── */}
      <div class="pchat-at-wrap pchat-ta-shell">
        {atOpen && atItems.length > 0 ? (
          <div class="pchat-at-menu" role="listbox">
            {atItems.map((it, idx) => (
              <button
                key={it.fsPath}
                type="button"
                role="option"
                class={`pchat-at-item${idx === atHighlight ? ' active' : ''}`}
                title={it.fsPath}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pickAtItem(it)}
              >
                {it.rel}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          class="pchat-ta"
          title={front ? '发送 (Ctrl+Enter)' : '加入队列 (Ctrl+Enter)'}
          placeholder={front ? '输入回复... 支持 @ 或图片' : '暂无等待，输入将加入发送队列'}
          disabled={!activeSessionId.trim()}
          value={draft}
          onInput={onDraftInput}
          onKeyDown={onKeyDown}
          onPaste={onPasteImages}
        />
        <button
          type="button"
          class="pchat-ta-send"
          title={submitting ? '发送中' : (front ? '发送' : '加入队列')}
          disabled={!canPrimaryAction}
          onClick={onPrimaryAction}
          aria-label={front ? '发送' : '加入队列'}
        >
          {submitting ? (
            <span class="pchat-ta-send-dots">…</span>
          ) : (
            <i class="bx bx-send" />
          )}
        </button>
      </div>
    </div>
  );
}
