/**
 * @fileoverview PChat 侧栏根组件（编排器）：管理全局状态与 effects，将渲染委托给子组件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VsCodeApi } from './vscode';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import {
  AT_TAIL,
  DEFAULT_HISTORY_LIMIT,
  LOAD_MORE_COUNT,
  MAX_IMAGE_BYTES,
  SCROLL_BOTTOM_PX,
  buildSubmitBody,
  formatElapsed,
  type AtItem,
  type FileRef,
  type HostState,
  type ImageAttach,
  type OutboxItem,
  type PchatWebPersist,
} from './types';

/**
 * @param props.vscode - `acquireVsCodeApi()` 实例
 */
export function App({ vscode }: { vscode: VsCodeApi }) {
  const saved = (vscode.getState() as PchatWebPersist | undefined) ?? {};

  /* ═══════════════════════════════ 状态 ═══════════════════════════════ */

  const [state, setState] = useState<HostState | null>(null);
  const [draft, setDraft] = useState('');
  const [refs, setRefs] = useState<FileRef[]>([]);
  const [images, setImages] = useState<ImageAttach[]>([]);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const [atOpen, setAtOpen] = useState(false);
  const [atItems, setAtItems] = useState<AtItem[]>([]);
  const [atHighlight, setAtHighlight] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(saved.sidebarCollapsed));
  const [waitCollapsed, setWaitCollapsed] = useState(saved.waitCollapsed !== false);
  const [submitting, setSubmitting] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [queuedDrafts, setQueuedDrafts] = useState<Record<string, string>>({});
  const [outboxBySession, setOutboxBySession] = useState<Record<string, OutboxItem[]>>(
    () => saved.outboxBySession ?? {},
  );
  const [historyLimit, setHistoryLimit] = useState(() => saved.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  const [historyExpandedBySession, setHistoryExpandedBySession] = useState<Record<string, number>>(
    () => ({}),
  );

  /* ═══════════════════════════════ Refs ═══════════════════════════════ */

  const msgsRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const stickBottomRef = useRef(true);
  const prevFrontRidRef = useRef<string | undefined>(undefined);
  const queuedDraftsRef = useRef(queuedDrafts);
  queuedDraftsRef.current = queuedDrafts;
  const atTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const atSeqRef = useRef(0);
  const pendingSubmit = useRef<{
    draft: string;
    refs: FileRef[];
    images: ImageAttach[];
    fromAutoOutbox?: boolean;
    restoreOutbox?: OutboxItem;
    restoreSessionId?: string;
  } | null>(null);
  const atItemsRef = useRef(atItems);
  const atHighlightRef = useRef(atHighlight);
  atItemsRef.current = atItems;
  atHighlightRef.current = atHighlight;
  const outboxBySessionRef = useRef(outboxBySession);
  outboxBySessionRef.current = outboxBySession;
  const autoSentOutboxKeyRef = useRef('');
  /** 切换会话时保留各会话的输入草稿（draft + refs + images） */
  const sessionDraftsRef = useRef<Record<string, { draft: string; refs: FileRef[]; images: ImageAttach[] }>>({});

  /* ═══════════════════════════════ 持久化 ═══════════════════════════════ */

  const persistUi = useCallback(
    (partial: PchatWebPersist) => {
      const prev = (vscode.getState() as PchatWebPersist | undefined) ?? {};
      vscode.setState({ ...prev, ...partial });
    },
    [vscode],
  );

  useEffect(() => {
    persistUi({ outboxBySession });
  }, [outboxBySession, persistUi]);

  useEffect(() => {
    persistUi({ historyLimit });
  }, [historyLimit, persistUi]);

  /* ═══════════════════════════════ Effects ═══════════════════════════════ */

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, [vscode]);

  /**
   * 页面切回前台时自动重新请求完整状态。
   * 当弹出模态对话框（或切换标签）后恢复可见时，
   * 可能丢失了中间的状态推送，此处兜底刷新。
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        vscode.postMessage({ type: 'ready' });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [vscode]);

  /** 来自扩展宿主的消息处理 */
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;

      if (d.type === 'state') {
        const p = d.payload as HostState;
        setState({
          ...p,
          waitSnapshot: {
            ...p.waitSnapshot,
            pendingWaits: p.waitSnapshot.pendingWaits ?? [],
          },
        });
        return;
      }
      if (d.type === 'ref') {
        const p = d.payload as FileRef;
        setRefs((r) => [...r, p]);
        setAtOpen(false);
        setAtItems([]);
        return;
      }
      if (d.type === 'at:matches') {
        const { seq, items } = d.payload as { seq: number; items: AtItem[] };
        if (seq !== atSeqRef.current) return;
        setAtItems([...items]);
        setAtHighlight(0);
        return;
      }
      if (d.type === 'submit:ack') {
        setSubmitting(false);
        const ok = Boolean(d.payload?.ok);
        const pend = pendingSubmit.current;
        if (ok) {
          setDraft('');
          setRefs([]);
          setImages([]);
          pendingSubmit.current = null;
        } else if (pend) {
          setDraft(pend.draft);
          setRefs(pend.refs);
          setImages(pend.images);
          const { fromAutoOutbox, restoreOutbox, restoreSessionId } = pend;
          pendingSubmit.current = null;
          if (fromAutoOutbox && restoreOutbox && restoreSessionId) {
            setOutboxBySession((m) => ({
              ...m,
              [restoreSessionId]: [restoreOutbox, ...(m[restoreSessionId] ?? [])],
            }));
            autoSentOutboxKeyRef.current = '';
          }
          setToast('发送失败：当前没有可匹配的等待（请确认会话与队列）。');
          setTimeout(() => setToast(''), 4500);
        }
        return;
      }
      if (d.type === 'rules:result') {
        const { ok, message } = d.payload as { ok: boolean; message: string };
        setToast(ok ? `✓ ${message}` : `✗ ${message}`);
        setTimeout(() => setToast(''), ok ? 3000 : 6000);
        return;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  /** 每秒 tick（驱动等待计时） */
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /** 宿主未回 `submit:ack` 时避免输入区永久卡在「发送中」。 */
  useEffect(() => {
    if (!submitting) return;
    const t = setTimeout(() => {
      setSubmitting(false);
      const pend = pendingSubmit.current;
      if (pend) {
        setDraft(pend.draft);
        setRefs(pend.refs);
        setImages(pend.images);
        if (pend.fromAutoOutbox && pend.restoreOutbox && pend.restoreSessionId) {
          setOutboxBySession((m) => ({
            ...m,
            [pend.restoreSessionId!]: [pend.restoreOutbox!, ...(m[pend.restoreSessionId!] ?? [])],
          }));
          autoSentOutboxKeyRef.current = '';
        }
        pendingSubmit.current = null;
      }
      setToast('发送超时：未收到扩展确认，请重试。');
      setTimeout(() => setToast(''), 4500);
    }, 45_000);
    return () => clearTimeout(t);
  }, [submitting]);

  const onMsgsScroll = useCallback(() => {
    const el = msgsRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = gap <= SCROLL_BOTTOM_PX;
    stickBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = msgsRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickBottomRef.current = true;
    setShowScrollBtn(false);
  }, []);

  /** 自动滚到底部 */
  useEffect(() => {
    const el = msgsRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state?.sessions, state?.activeSessionId]);

  /** 清理已失效的排队预写 */
  useEffect(() => {
    const waits = state?.waitSnapshot.pendingWaits;
    if (!waits?.length) return;
    const ids = new Set(waits.map((w) => w.requestId));
    setQueuedDrafts((d) => {
      let changed = false;
      const n = { ...d };
      for (const k of Object.keys(n)) {
        if (!ids.has(k)) {
          delete n[k];
          changed = true;
        }
      }
      return changed ? n : d;
    });
  }, [state?.waitSnapshot.pendingWaits]);

  /** 队首变更时填入预写回复 */
  useEffect(() => {
    const id = state?.waitSnapshot.front?.requestId;
    if (!id) {
      prevFrontRidRef.current = undefined;
      return;
    }
    const prev = prevFrontRidRef.current;
    if (prev !== undefined && prev !== id) {
      const pre = queuedDraftsRef.current[id];
      if (typeof pre === 'string' && pre.trim()) {
        setDraft(pre);
        setQueuedDrafts((d) => {
          const n = { ...d };
          delete n[id];
          return n;
        });
      }
    }
    prevFrontRidRef.current = id;
  }, [state?.waitSnapshot.front?.requestId]);

  /* ═══════════════════════════════ 派生值 ═══════════════════════════════ */

  const activeId = state?.activeSessionId ?? '';
  const active = state?.sessions.find((s) => s.id === activeId);
  const front = state?.waitSnapshot?.front;
  const pendingTail = (state?.waitSnapshot?.pendingWaits ?? []).filter((w) => w.index > 0);
  const sendQueue = outboxBySession[activeId] ?? [];
  const canPrimaryAction = Boolean(activeId.trim() && draft.trim().length > 0 && !submitting);

  /* ─── 历史分页 ─── */

  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    if (activeId && prevActiveIdRef.current && activeId !== prevActiveIdRef.current) {
      /* 保存旧会话的草稿 */
      const oldId = prevActiveIdRef.current;
      sessionDraftsRef.current[oldId] = { draft, refs: [...refs], images: [...images] };
      /* 恢复新会话的草稿（无则清空） */
      const saved = sessionDraftsRef.current[activeId];
      if (saved) {
        setDraft(saved.draft);
        setRefs(saved.refs);
        setImages(saved.images);
        delete sessionDraftsRef.current[activeId];
      } else {
        setDraft('');
        setRefs([]);
        setImages([]);
      }
      /* 重置历史展开 */
      setHistoryExpandedBySession((prev) => {
        const n = { ...prev };
        delete n[activeId];
        return n;
      });
    }
    prevActiveIdRef.current = activeId;
  }, [activeId]);

  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!activeId || !active) return;
    const curCount = active.messages.length;
    const prevCount = prevMsgCountRef.current[activeId] ?? 0;
    if (prevCount === 0) {
      prevMsgCountRef.current = { ...prevMsgCountRef.current, [activeId]: curCount };
      return;
    }
    if (curCount > prevCount) {
      setHistoryExpandedBySession((prev) => {
        const n = { ...prev };
        delete n[activeId];
        return n;
      });
    }
    prevMsgCountRef.current = { ...prevMsgCountRef.current, [activeId]: curCount };
  }, [activeId, active?.messages.length]);

  const visibleLimit = historyExpandedBySession[activeId] ?? historyLimit;
  const allMessages = active?.messages ?? [];
  const totalCount = allMessages.length;
  const hasMore = totalCount > visibleLimit;
  const visibleMessages = hasMore ? allMessages.slice(totalCount - visibleLimit) : allMessages;

  const loadMoreHistory = useCallback(() => {
    setHistoryExpandedBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? historyLimit) + LOAD_MORE_COUNT,
    }));
  }, [activeId, historyLimit]);

  const showAllHistory = useCallback(() => {
    setHistoryExpandedBySession((prev) => ({
      ...prev,
      [activeId]: totalCount,
    }));
  }, [activeId, totalCount]);

  const waitElapsed = useMemo(() => {
    if (!front) return '00:00';
    return formatElapsed(front.enqueuedAt, Date.now());
  }, [front, tick]);

  const sessionMeta = state?.waitSnapshot?.sessionMeta;
  const sessionRuntime = useMemo(() => {
    if (!sessionMeta?.createdAt) return '';
    const elapsed = Math.max(0, Date.now() - sessionMeta.createdAt);
    const totalMin = Math.floor(elapsed / 60_000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }, [sessionMeta?.createdAt, tick]);
  const renewCount = sessionMeta?.renewCount ?? 0;

  /* ═══════════════════════════════ 回调 ═══════════════════════════════ */

  const scheduleAtSuggest = useCallback(
    (query: string) => {
      if (atTimer.current) clearTimeout(atTimer.current);
      atTimer.current = setTimeout(() => {
        atSeqRef.current += 1;
        const seq = atSeqRef.current;
        vscode.postMessage({ type: 'at:suggest', query, seq });
      }, 100);
    },
    [vscode],
  );

  const removeAtQueryFromDraft = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const v = el.value;
    const left = v.slice(0, start);
    const m = left.match(AT_TAIL);
    if (!m || m.index === undefined) return;
    const cut = left.slice(0, m.index);
    const next = cut + v.slice(start);
    setDraft(next);
    requestAnimationFrame(() => {
      const pos = cut.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  }, []);

  const pickAtItem = useCallback(
    (it: AtItem) => {
      removeAtQueryFromDraft();
      vscode.postMessage({ type: 'ref:fsPath', fsPath: it.fsPath });
      setAtOpen(false);
      setAtItems([]);
    },
    [vscode, removeAtQueryFromDraft],
  );

  const onDraftInput = useCallback(
    (e: Event) => {
      const el = e.target as HTMLTextAreaElement;
      setDraft(el.value);
      const start = el.selectionStart;
      const left = el.value.slice(0, start);
      const m = left.match(AT_TAIL);
      if (m) {
        setAtOpen(true);
        scheduleAtSuggest(m[1] ?? '');
      } else {
        setAtOpen(false);
        setAtItems([]);
      }
    },
    [scheduleAtSuggest],
  );

  const onTriggerAtMenu = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const v = el.value;
    const next = v.substring(0, start) + '@' + v.substring(end);
    setDraft(next);
    setAtOpen(true);
    scheduleAtSuggest('');
    requestAnimationFrame(() => {
      el.value = next;
      el.setSelectionRange(start + 1, start + 1);
      el.focus();
    });
  }, [scheduleAtSuggest]);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setToast(`图片过大（>${MAX_IMAGE_BYTES >> 20}MB）：${file.name}`);
        setTimeout(() => setToast(''), 4000);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        if (!dataUrl.startsWith('data:')) return;
        setImages((imgs) => [
          ...imgs,
          { id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, dataUrl },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }, [vscode]);

  const onComposerDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onComposerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (!dt) return;
      const paths: string[] = [];
      const uriList = dt.getData('text/uri-list');
      if (uriList) {
        for (const line of uriList.split(/\r?\n/)) {
          if (!line.trim() || line.startsWith('#')) continue;
          if (line.startsWith('file://')) {
            try {
              let p = line.slice(7);
              p = decodeURIComponent(p.replace(/\+/g, ' '));
              paths.push(p);
            } catch { /* ignore */ }
          }
        }
      }
      const plain = dt.getData('text/plain')?.trim();
      if (plain && (plain.startsWith('/') || /^[A-Za-z]:[/\\]/.test(plain))) {
        paths.push(plain);
      }
      if (dt.files?.length) {
        const imgs: File[] = [];
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i] as File & { path?: string };
          if (f.path) {
            paths.push(f.path);
          } else if (f.type.startsWith('image/')) {
            imgs.push(f);
          }
        }
        if (imgs.length) addImageFiles(imgs);
      }
      for (const p of [...new Set(paths)]) {
        vscode.postMessage({ type: 'ref:fsPath', fsPath: p });
      }
    },
    [vscode, addImageFiles],
  );

  const onPasteImages = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addImageFiles(files);
      }
    },
    [addImageFiles],
  );

  const submit = useCallback(() => {
    if (!state || !state.activeSessionId.trim() || !draft.trim() || !front || submitting) return;
    const body = buildSubmitBody(draft, refs, images);
    pendingSubmit.current = { draft, refs: [...refs], images: [...images] };
    setSubmitting(true);
    vscode.postMessage({ type: 'submit', sessionId: state.activeSessionId, text: body });
  }, [vscode, state, draft, front, refs, images, submitting]);

  const enqueueToSendQueue = useCallback(() => {
    if (!state?.activeSessionId.trim() || !draft.trim() || submitting) return;
    const sid = state.activeSessionId.trim();
    const item: OutboxItem = {
      id: `ob-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      draft: draft.trim(),
      refs: [...refs],
      images: [...images],
    };
    setOutboxBySession((m) => ({
      ...m,
      [sid]: [...(m[sid] ?? []), item],
    }));
    setDraft('');
    setRefs([]);
    setImages([]);
  }, [state?.activeSessionId, draft, refs, images, submitting]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const n = !c;
      persistUi({ sidebarCollapsed: n });
      return n;
    });
  }, [persistUi]);

  // 广播相关弹窗与状态
  const [broadcastModalOpen, setBroadcastModalOpen] = useState(false);
  const [sessionPayloadModalOpen, setSessionPayloadModalOpen] = useState(false);
  const [broadcastSelectedIds, setBroadcastSelectedIds] = useState<Set<string>>(new Set());
  const [broadcastText, setBroadcastText] = useState('');

  const removeOutboxItem = useCallback((sid: string, itemId: string) => {
    setOutboxBySession((m) => ({
      ...m,
      [sid]: (m[sid] ?? []).filter((x) => x.id !== itemId),
    }));
  }, []);

  const moveOutboxItemToComposer = useCallback((sid: string, item: OutboxItem) => {
    setOutboxBySession((m) => ({
      ...m,
      [sid]: (m[sid] ?? []).filter((x) => x.id !== item.id),
    }));
    setDraft(item.draft);
    setRefs([...item.refs]);
    setImages([...item.images]);
  }, []);

  const onOpenBroadcast = useCallback(() => {
    if (!state) return;
    const waitingSessions = state.sessions.filter(s => (state.waitSnapshot?.sessionQueueCounts?.[s.id] ?? 0) > 0);
    setBroadcastSelectedIds(new Set(waitingSessions.map(s => s.id)));
    setBroadcastModalOpen(true);
  }, [state]);

  const sendBroadcast = useCallback(() => {
    if (!broadcastText.trim() || broadcastSelectedIds.size === 0) return;
    vscode.postMessage({ 
      type: 'submit:broadcast_selected', 
      sessionIds: Array.from(broadcastSelectedIds), 
      text: broadcastText 
    });
    setBroadcastModalOpen(false);
    setBroadcastText(''); 
  }, [broadcastSelectedIds, broadcastText, vscode]);

  const onPrimaryAction = useCallback(() => {
    if (front) {
      submit();
    } else {
      enqueueToSendQueue();
    }
  }, [front, submit, enqueueToSendQueue]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const items = atItemsRef.current;
      const hi = atHighlightRef.current;
      if (atOpen && items.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAtHighlight((i) => Math.min(items.length - 1, i + 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAtHighlight((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const it = items[hi];
          if (it) pickAtItem(it);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAtOpen(false);
          setAtItems([]);
          return;
        }
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onPrimaryAction();
      }
    },
    [atOpen, pickAtItem, onPrimaryAction],
  );

  /** outbox 自动消费 */
  useEffect(() => {
    const rid = front?.requestId;
    const sid = activeId.trim();
    if (!rid || !sid || submitting) return;
    const key = `${sid}:${rid}`;
    if (autoSentOutboxKeyRef.current === key) return;
    const queue = outboxBySessionRef.current[sid] ?? [];
    if (queue.length === 0) return;
    autoSentOutboxKeyRef.current = key;
    const [first, ...rest] = queue;
    setOutboxBySession((m) => ({ ...m, [sid]: rest }));
    const body = buildSubmitBody(first.draft, first.refs, first.images);
    pendingSubmit.current = {
      draft: first.draft,
      refs: first.refs,
      images: first.images,
      fromAutoOutbox: true,
      restoreOutbox: first,
      restoreSessionId: sid,
    };
    setSubmitting(true);
    vscode.postMessage({ type: 'submit', sessionId: sid, text: body });
  }, [front?.requestId, activeId, submitting, vscode]);

  const applyCustomCmd = useCallback((text: string) => {
    setDraft((d) => d ? d + '\n' + text : text);
    setTimeout(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(taRef.current.value.length, taRef.current.value.length);
    }, 10);
  }, []);

  const onQueuedDraftChange = useCallback((requestId: string, text: string) => {
    setQueuedDrafts((d) => ({ ...d, [requestId]: text }));
  }, []);

  /* ═══════════════════════════════ 渲染 ═══════════════════════════════ */

  if (!state) {
    return (
      <div class="pchat-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <i class="bx bx-loader-alt bx-spin" style={{ fontSize: '28px', color: 'var(--vscode-button-background)' }} />
        <span style={{ fontSize: '13px', opacity: 0.8 }}>加载中…</span>
      </div>
    );
  }

  return (
    <div class={`pchat-root${sidebarCollapsed ? ' pchat-root--sidebar-collapsed' : ''}${!state.bridgeConnected ? ' pchat-root--bridge-disconnected' : ''}`}>
      <Sidebar
        vscode={vscode}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        sessionQueueCounts={state.waitSnapshot?.sessionQueueCounts}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />

      <section class="pchat-main">
        <Header
          vscode={vscode}
          bridgeConnected={state.bridgeConnected}
          activeSessionId={state.activeSessionId}
          cursorInfo={state.cursorInfo}
          rulesStatus={state.rulesStatus}
          onRewriteRules={() => vscode.postMessage({ type: 'rules:rewrite' })}
          historyLimit={historyLimit}
          onHistoryLimitChange={setHistoryLimit}
          settings={state.settings}
          onSettingsChange={(partial) => vscode.postMessage({ type: 'settings', settings: partial })}
          onOpenBroadcast={onOpenBroadcast}
        />

        <MessageList
          activeSessionId={state.activeSessionId}
          bridgeConnected={state.bridgeConnected}
          active={active}
          visibleMessages={visibleMessages}
          totalCount={totalCount}
          visibleLimit={visibleLimit}
          hasMore={hasMore}
          msgsRef={msgsRef}
          onScroll={onMsgsScroll}
          onLoadMore={loadMoreHistory}
          onShowAll={showAllHistory}
          showScrollBtn={showScrollBtn}
          onScrollToBottom={scrollToBottom}
          onDragOver={onComposerDragOver}
          onDrop={onComposerDrop}
        />

        <Composer
          vscode={vscode}
          activeSessionId={state.activeSessionId}
          front={front}
          pendingTail={pendingTail}
          sendQueue={sendQueue}
          draft={draft}
          refs={refs}
          images={images}
          submitting={submitting}
          canPrimaryAction={canPrimaryAction}
          queuedDrafts={queuedDrafts}
          waitElapsed={waitElapsed}
          sessionRuntime={sessionRuntime}
          renewCount={renewCount}
          atOpen={atOpen}
          atItems={atItems}
          atHighlight={atHighlight}
          onDraftInput={onDraftInput}
          onKeyDown={onKeyDown}
          onPasteImages={onPasteImages}
          onComposerDragOver={onComposerDragOver}
          onComposerDrop={onComposerDrop}
          onTriggerAtMenu={onTriggerAtMenu}
          onPrimaryAction={onPrimaryAction}
          pickAtItem={pickAtItem}
          onSetImages={setImages}
          onSetRefs={setRefs}
          onQueuedDraftChange={onQueuedDraftChange}
          onRemoveOutboxItem={removeOutboxItem}
          onMoveOutboxToComposer={moveOutboxItemToComposer}
          addImageFiles={addImageFiles}
          applyCustomCmd={applyCustomCmd}
          sessionPayloadEnabled={active?.payload?.enabled ?? false}
          onOpenSessionPayload={() => setSessionPayloadModalOpen(true)}
          taRef={taRef}
          imgInputRef={imgInputRef}
        />

        {sessionPayloadModalOpen && active && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: 'var(--pchat-bg)', width: '90%', maxWidth: '380px', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)', border: '1px solid var(--pchat-border)' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', justifyContent: 'space-between', color: 'var(--pchat-text)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <i class="bx bx-tag" />
                  <span>本轮会话附加内容</span>
                  {(!active.payload?.enabled && state.settings?.globalPayload?.enabled) && (
                    <span style={{ marginLeft: '4px', color: 'var(--pchat-warning)', fontSize: '10px', fontWeight: 'normal' }}>[全域正在生效]</span>
                  )}
                </div>
                <i class="bx bx-x" style={{ cursor: 'pointer', fontSize: '20px', color: 'var(--pchat-muted)' }} onClick={() => setSessionPayloadModalOpen(false)} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--pchat-text)' }}>
                  <input 
                    type="checkbox" 
                    checked={active.payload?.enabled ?? false}
                    onChange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      vscode.postMessage({ type: 'session:payload', sessionId: state.activeSessionId, payload: { ...(active.payload || { position: 'tail', text: '' }), enabled: checked } });
                    }}
                  />
                  <span>启用附加内容</span>
                </label>
                <div style={{ display: 'flex', gap: '8px', color: 'var(--pchat-text)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                     <input type="radio" 
                       name="sp-pos"
                       checked={active.payload?.position === 'head'}
                       onChange={() => {
                         vscode.postMessage({ type: 'session:payload', sessionId: state.activeSessionId, payload: { ...(active.payload || { text: '' }), position: 'head' } });
                       }}
                     />
                     在头部
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                     <input type="radio" 
                       name="sp-pos"
                       checked={(active.payload?.position ?? 'tail') === 'tail'}
                       onChange={() => {
                         vscode.postMessage({ type: 'session:payload', sessionId: state.activeSessionId, payload: { ...(active.payload || { text: '' }), position: 'tail' } });
                       }}
                     />
                     在末尾
                  </label>
                </div>
              </div>
              <textarea 
                class="pchat-ta"
                style={{ minHeight: '80px', padding: '10px' }}
                placeholder="仅当前会话有效，每次提交新消息时自动附着在一起发给 AI（不在面板正文显示）..."
                value={active.payload?.text ?? ''}
                onInput={(e) => {
                  const v = (e.target as HTMLTextAreaElement).value;
                  vscode.postMessage({ type: 'session:payload', sessionId: state.activeSessionId, payload: { ...(active.payload || { enabled: false, position: 'tail' }), text: v } });
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
                <button type="button" class="pchat-btn-pri" onClick={() => setSessionPayloadModalOpen(false)} style={{ padding: '4px 16px' }}>完成</button>
              </div>
            </div>
          </div>
        )}

        {broadcastModalOpen && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: 'var(--pchat-bg)', width: '90%', maxWidth: '380px', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)', border: '1px solid var(--pchat-border)' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', justifyContent: 'space-between', color: 'var(--pchat-text)' }}>
                <span>群发消息</span>
                <i class="bx bx-x" style={{ cursor: 'pointer', fontSize: '20px', color: 'var(--pchat-muted)' }} onClick={() => setBroadcastModalOpen(false)} />
              </div>
              <textarea 
                class="pchat-ta"
                style={{ minHeight: '80px', padding: '10px' }}
                placeholder="在此输入需要群发的内容..."
                value={broadcastText}
                onInput={(e) => setBroadcastText((e.target as HTMLTextAreaElement).value)}
              />
              <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--pchat-text)' }}>
                <strong>选择接收的会话</strong>
                <div>
                  <button type="button" class="pchat-btn-sec" style={{ marginRight: '6px', fontSize: '11px', padding: '2px 8px' }} onClick={() => {
                    setBroadcastSelectedIds(new Set(state?.sessions.filter(s => s.id !== 'pchat-main').map(s => s.id) || []));
                  }}>全选 (全部)</button>
                  <button type="button" class="pchat-btn-sec" style={{ marginRight: '6px', fontSize: '11px', padding: '2px 8px' }} onClick={() => {
                    setBroadcastSelectedIds(new Set(state?.sessions.filter(s => (state.waitSnapshot?.sessionQueueCounts?.[s.id] ?? 0) > 0 && s.id !== 'pchat-main').map(s => s.id) || []));
                  }}>全选 (等待中)</button>
                  <button type="button" class="pchat-btn-sec" style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => setBroadcastSelectedIds(new Set())}>无</button>
                </div>
              </div>
              <div style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--pchat-surface-1)', padding: '10px', borderRadius: '6px', border: '1px solid var(--pchat-border)' }}>
                {state?.sessions.filter(s => s.id !== 'pchat-main').map(s => {
                  return (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        style={{ margin: 0, cursor: 'pointer' }}
                        checked={broadcastSelectedIds.has(s.id)}
                        onChange={(e) => {
                          const checked = (e.target as HTMLInputElement).checked;
                          const next = new Set(broadcastSelectedIds);
                          if (checked) next.add(s.id); else next.delete(s.id);
                          setBroadcastSelectedIds(next);
                        }}
                      />
                      <span style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--pchat-text)' }}>
                        {s.title}
                      </span>
                      <span style={{ fontSize: '10px', marginLeft: 'auto', color: 'var(--pchat-muted)' }}>({s.id})</span>
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button type="button" class="pchat-btn-sec" onClick={() => setBroadcastModalOpen(false)}>取消</button>
                <button type="button" class="pchat-btn-pri" disabled={!broadcastText.trim() || broadcastSelectedIds.size === 0} onClick={sendBroadcast} style={{ padding: '4px 16px' }}>发送 ({broadcastSelectedIds.size})</button>
              </div>
            </div>
          </div>
        )}
      </section>

      {toast ? <div class="pchat-toast">{toast}</div> : null}
    </div>
  );
}
