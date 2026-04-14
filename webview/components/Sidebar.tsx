/**
 * @fileoverview 左侧会话列表侧栏，包含拖拽排序与行内重命名。
 * 自管理拖拽和重命名的局部状态。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { VsCodeApi } from '../vscode';
import type { StoredSession } from '../types';

type SidebarProps = {
  vscode: VsCodeApi;
  sessions: readonly StoredSession[];
  activeSessionId: string;
  sessionQueueCounts?: Record<string, number>;
  collapsed: boolean;
  onToggle: () => void;
};

export function Sidebar({
  vscode,
  sessions,
  activeSessionId,
  sessionQueueCounts,
  collapsed,
  onToggle,
}: SidebarProps) {
  /* ─── 重命名状态 ─── */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameEscapeRef = useRef(false);

  /* ─── 拖拽排序状态 ─── */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverHalf, setDragOverHalf] = useState<'top' | 'bottom'>('bottom');

  /* ─── 恢复会话状态 ─── */
  const [restoreMode, setRestoreMode] = useState(false);
  const [restoreId, setRestoreId] = useState('');
  const restoreInputRef = useRef<HTMLInputElement>(null);

  /** 会话被删除时清理重命名状态 */
  useEffect(() => {
    if (!renamingId) return;
    if (!sessions.some((x) => x.id === renamingId)) {
      setRenamingId(null);
      setRenameDraft('');
    }
  }, [sessions, renamingId]);

  /** 恢复输入框展开时自动聚焦 */
  useEffect(() => {
    if (restoreMode) {
      requestAnimationFrame(() => {
        restoreInputRef.current?.focus();
      });
    }
  }, [restoreMode]);

  const activateSession = useCallback(
    (sessionId: string) => {
      vscode.postMessage({ type: 'session:active', sessionId });
    },
    [vscode],
  );

  const startRename = useCallback((s: StoredSession) => {
    renameEscapeRef.current = false;
    setRenamingId(s.id);
    setRenameDraft(s.title);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, []);

  const finishRename = useCallback(
    (sessionId: string, title: string) => {
      const t = title.trim() || '未命名';
      vscode.postMessage({ type: 'session:rename', sessionId, title: t });
      setRenamingId(null);
      setRenameDraft('');
    },
    [vscode],
  );

  const submitRestore = useCallback(() => {
    const id = restoreId.trim();
    if (!id) return;
    vscode.postMessage({ type: 'session:restore', sessionId: id });
    setRestoreId('');
    setRestoreMode(false);
  }, [vscode, restoreId]);

  /* ─── 拖拽回调 ─── */
  const onSessionDragStart = useCallback((e: DragEvent, sessionId: string) => {
    setDragId(sessionId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sessionId);
    }
  }, []);

  const onSessionDragOver = useCallback((e: DragEvent, sessionId: string) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverHalf(e.clientY < midY ? 'top' : 'bottom');
    setDragOverId(sessionId);
  }, []);

  const onSessionDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const fromId = e.dataTransfer?.getData('text/plain') ?? '';
      const targetEl = (e.currentTarget as HTMLElement).closest('[data-session-id]') as HTMLElement | null;
      const toId = targetEl?.dataset.sessionId ?? '';
      setDragId(null);
      setDragOverId(null);
      if (!fromId || !toId || fromId === toId) return;
      const rect = targetEl!.getBoundingClientRect();
      const half: 'top' | 'bottom' = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
      const ids = sessions.map((s) => s.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return;
      ids.splice(fromIdx, 1);
      let insertIdx = ids.indexOf(toId);
      if (half === 'bottom') insertIdx += 1;
      ids.splice(insertIdx, 0, fromId);
      vscode.postMessage({ type: 'session:reorder', sessionIds: ids });
    },
    [sessions, vscode],
  );

  const onSessionDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  return (
    <aside class="pchat-sidebar">
      <div class="pchat-sidebar-h">
        {!collapsed ? <span>会话{sessions.length > 0 ? <span style={{ opacity: 0.6, marginLeft: 4 }}>({sessions.length})</span> : null}</span> : <span />}
        <div style={{ display: 'flex', gap: 2 }}>
          {!collapsed && sessions.length > 0 && (
            <button
              type="button"
              class="pchat-icon-btn"
              title="清空所有会话"
              onClick={() => {
                vscode.postMessage({ type: 'session:clear-all' });
              }}
            >
              <i class="bx bx-trash" style={{ fontSize: 13 }} />
            </button>
          )}
          <button
            type="button"
            class="pchat-icon-btn"
            title={collapsed ? '展开会话栏' : '收起会话栏'}
            onClick={onToggle}
          >
            <i class={`bx ${collapsed ? 'bx-chevrons-right' : 'bx-chevrons-left'}`} />
          </button>
        </div>
      </div>
      {!collapsed ? (
        <div class="pchat-sessions">
          {sessions.length === 0 ? (
            <div class="pchat-sessions-empty" style={{ padding: '24px 10px', textAlign: 'center', color: 'var(--pchat-muted)', fontSize: 12 }}>
              <i class="bx bx-archive" style={{ fontSize: 28, opacity: 0.4, display: 'block', marginBottom: 8 }}></i>
              暂无会话
              <span style={{ opacity: 0.6, fontSize: 10, marginTop: 6, display: 'block' }}>请让 Agent 调用 <code>wait</code></span>
            </div>
          ) : null}
          {sessions.map((s) => (
            <div
              key={s.id}
              class={[
                'pchat-sess-row',
                s.id === activeSessionId ? 'active' : '',
                dragId === s.id ? 'pchat-sess-row--dragging' : '',
                dragOverId === s.id && dragId !== s.id ? `pchat-sess-row--drop-${dragOverHalf}` : '',
              ].filter(Boolean).join(' ')}
              draggable={renamingId !== s.id}
              data-session-id={s.id}
              onDragStart={(e) => onSessionDragStart(e as unknown as DragEvent, s.id)}
              onDragOver={(e) => onSessionDragOver(e as unknown as DragEvent, s.id)}
              onDrop={(e) => onSessionDrop(e as unknown as DragEvent)}
              onDragEnd={onSessionDragEnd}
            >
              {renamingId === s.id ? (
                <div class="pchat-sess-item pchat-sess-item--edit">
                  <i class="bx bx-message-dots" style={{ opacity: 0.7, flexShrink: 0 }} />
                  <input
                    ref={renameInputRef}
                    type="text"
                    class="pchat-sess-rename-input"
                    value={renameDraft}
                    onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        finishRename(s.id, renameDraft);
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        renameEscapeRef.current = true;
                        setRenamingId(null);
                        setRenameDraft('');
                      }
                    }}
                    onBlur={() => {
                      if (renameEscapeRef.current) {
                        renameEscapeRef.current = false;
                        return;
                      }
                      finishRename(s.id, renameDraft);
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  class="pchat-sess-item"
                  style={{ flex: 1, border: 'none', minWidth: 0 }}
                  onClick={() => activateSession(s.id)}
                >
                  <i class={`bx ${dragId ? 'bx-grid-vertical' : 'bx-message-dots'}`} style={{ opacity: 0.7, flexShrink: 0, alignSelf: 'flex-start', marginTop: 2 }} />
                  <div
                    class="pchat-sess-info"
                    title="双击重命名"
                    onDblClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      startRename(s);
                    }}
                  >
                    <span class="pchat-sess-title">{s.title}</span>
                    <span class="pchat-sess-id">{s.id}</span>
                  </div>
                  {(() => {
                    const cnt = sessionQueueCounts?.[s.id] ?? 0;
                    return cnt > 0 ? (
                      <span class="pchat-sess-badge" title={`${cnt} 条等待中`}>{cnt}</span>
                    ) : null;
                  })()}
                </button>
              )}
              <button
                type="button"
                class="pchat-icon-btn pchat-sess-del"
                title="删除会话"
                onMouseDown={(ev) => {
                  if (renamingId === s.id) {
                    ev.preventDefault();
                  }
                }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  vscode.postMessage({
                    type: 'session:delete',
                    sessionId: s.id,
                    title: s.title,
                  });
                }}
              >
                <i class="bx bx-x" style={{ fontSize: 14 }} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div class="pchat-sidebar-mini">
          {sessions.map((s) => {
            const trimmed = s.title.trim();
            const initials = trimmed.slice(0, 2) || '?';
            const isActive = s.id === activeSessionId;
            const cnt = sessionQueueCounts?.[s.id] ?? 0;
            return (
              <button
                key={s.id}
                type="button"
                class={`pchat-mini-avatar${isActive ? ' active' : ''}${initials.length === 1 ? ' single-char' : ''}`}
                title={`${s.title}\n${s.id}`}
                onClick={() => activateSession(s.id)}
              >
                {initials}
                {cnt > 0 && <span class="pchat-mini-badge">{cnt}</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* ── 恢复会话入口 ── */}
      {!collapsed && (
        <div class="pchat-sidebar-restore">
          {restoreMode ? (
            <div class="pchat-restore-input-wrap">
              <input
                ref={restoreInputRef}
                type="text"
                class="pchat-restore-input"
                placeholder="输入会话 ID…"
                value={restoreId}
                onInput={(e) => setRestoreId((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitRestore();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRestoreMode(false);
                    setRestoreId('');
                  }
                }}
                onBlur={() => {
                  if (!restoreId.trim()) {
                    setRestoreMode(false);
                    setRestoreId('');
                  }
                }}
              />
              <button
                type="button"
                class="pchat-icon-btn"
                title="恢复"
                onClick={submitRestore}
                disabled={!restoreId.trim()}
              >
                <i class="bx bx-check" style={{ fontSize: 16, color: 'var(--pchat-success)' }} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              class="pchat-restore-btn"
              title="通过会话 ID 恢复已删除的会话"
              onClick={() => setRestoreMode(true)}
            >
              <i class="bx bx-revision" style={{ fontSize: 13 }} /> 恢复会话
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
