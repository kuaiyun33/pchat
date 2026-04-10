/**
 * @fileoverview PChat 侧栏根组件：会话折叠、等待区展开、@ 补全（有序列号防竞态）、图片附件与 Markdown 渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VsCodeApi } from './vscode';
import { renderMarkdown } from './markdown';
import aiAvatarUrl from './ai_avatar.svg';
import userAvatarUrl from './user_avatar.svg';

/** 光标前 `@` 后允许非空白、非 `@` 的查询片段（支持中文路径等）。 */
const AT_TAIL = /@([^\s@]*)$/;

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

type PchatSettings = {
  autoRenew: boolean;
  agentTimeoutMin: number;
  renewBeforeMin: number;
  backendTimeoutMin: number;
};

type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  ts: number;
};

type StoredSession = {
  id: string;
  title: string;
  messages: readonly StoredChatMessage[];
};

type WaitFront = {
  requestId: string;
  message: string;
  prompt?: string;
  enqueuedAt: number;
  deadlineMs: number;
  progressTotalMs: number;
};

type CustomCmd = {
  id: string;
  text: string;
};

type WaitPendingRow = {
  requestId: string;
  message: string;
  prompt?: string;
  enqueuedAt: number;
  index: number;
};

type HostState = {
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
  };
  cursorInfo?: {
    email?: string;
    membership?: string;
    stripeUsageUsd?: string;
  };
};

type FileRef = { path: string; label: string; snippet: string };

type AtItem = { rel: string; fsPath: string };

type ImageAttach = { id: string; name: string; dataUrl: string };

/** 用户侧「发送队列」：无队首等待时可预写；新等待出现或轮到下一条时自动按序发出。 */
type OutboxItem = {
  id: string;
  draft: string;
  refs: FileRef[];
  images: ImageAttach[];
};

type PchatWebPersist = {
  sidebarCollapsed?: boolean;
  waitCollapsed?: boolean;
  outboxBySession?: Record<string, OutboxItem[]>;
  /** 每个会话默认显示的历史消息数量 */
  historyLimit?: number;
  /** 各会话已展开的历史消息数量（切换会话不丢失） */
  historyExpandedBySession?: Record<string, number>;
};

/** 每个对话框默认显示的历史消息数量 */
const DEFAULT_HISTORY_LIMIT = 3;
/** 每次「查看更多」加载的条数 */
const LOAD_MORE_COUNT = 5;

const SCROLL_BOTTOM_PX = 20;

function buildSubmitBody(draftText: string, irefs: readonly FileRef[], iimgs: readonly ImageAttach[]): string {
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

function truncateOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function formatElapsed(enqueuedAt: number, now: number): string {
  const elapsed = Math.max(0, now - enqueuedAt);
  const s = Math.floor(elapsed / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * @param props.vscode - `acquireVsCodeApi()` 实例
 */
export function App({ vscode }: { vscode: VsCodeApi }) {
  const saved = (vscode.getState() as PchatWebPersist | undefined) ?? {};

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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [queuedDrafts, setQueuedDrafts] = useState<Record<string, string>>({});
  const [outboxBySession, setOutboxBySession] = useState<Record<string, OutboxItem[]>>(
    () => saved.outboxBySession ?? {},
  );
  /** 每个会话默认显示的历史消息条数（用户可自定义） */
  const [historyLimit, setHistoryLimit] = useState(() => saved.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  /** 各会话已展开的历史消息数量（不持久化，切换/重开均重置） */
  const [historyExpandedBySession, setHistoryExpandedBySession] = useState<Record<string, number>>(
    () => ({}),
  );
  /** 设置面板开关 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  /** 拖拽排序状态 */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverHalf, setDragOverHalf] = useState<'top' | 'bottom'>('bottom');

  const defaultCmds = useMemo(() => {
    try {
      const stored = localStorage.getItem('pchat_custom_commands_v1');
      if (stored) return JSON.parse(stored) as CustomCmd[];
    } catch { /* ignore */ }
    return [
      { id: 'c1', text: '语法优化：请帮忙优化当前代码的语法和可读性，确保符合现代最佳实践' },
      { id: 'c2', text: '代码审查：请对这段代码进行严谨的 Code Review，指出潜在问题和改进点' },
      { id: 'c3', text: '代码解释：请通俗易懂地解释这段代码的核心逻辑和作用' },
      { id: 'c4', text: '单元测试：请为这段代码编写完善的单元测试，覆盖主要边界场景' },
      { id: 'c5', text: 'Git 提交：请参考 conventional commits 规范，为这些改动生成标准的提交信息' }
    ];
  }, []);
  const [customCommands, setCustomCommands] = useState<CustomCmd[]>(defaultCmds);
  const [customCommandsOpen, setCustomCommandsOpen] = useState(false);
  const [editingCmdId, setEditingCmdId] = useState<string | null>(null);
  const [editingCmdText, setEditingCmdText] = useState('');

  const msgsRef = useRef<HTMLDivElement>(null);
  const cmdMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameEscapeRef = useRef(false);
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
  /** 避免对同一 MCP 队首 requestId 重复自动消费发送队列（含 StrictMode 双调用）。 */
  const autoSentOutboxKeyRef = useRef('');

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



  /** 点击外部关闭设置面板 */
  useEffect(() => {
    if (!settingsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [settingsOpen]);

  useEffect(() => {
    localStorage.setItem('pchat_custom_commands_v1', JSON.stringify(customCommands));
  }, [customCommands]);

  useEffect(() => {
    if (!customCommandsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (cmdMenuRef.current && !cmdMenuRef.current.contains(e.target as Node)) {
        setCustomCommandsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [customCommandsOpen]);

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

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, [vscode]);

  useEffect(() => {
    if (!renamingId || !state) {
      return;
    }
    if (!state.sessions.some((x) => x.id === renamingId)) {
      setRenamingId(null);
      setRenameDraft('');
    }
  }, [state, renamingId]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== 'object') {
        return;
      }
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
        if (seq !== atSeqRef.current) {
          return;
        }
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
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /** 宿主未回 `submit:ack` 时避免输入区永久卡在「发送中」。 */
  useEffect(() => {
    if (!submitting) {
      return;
    }
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
    if (!el) {
      return;
    }
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottomRef.current = gap <= SCROLL_BOTTOM_PX;
  }, []);

  useEffect(() => {
    const el = msgsRef.current;
    if (!el || !stickBottomRef.current) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state?.sessions, state?.activeSessionId]);

  useEffect(() => {
    const waits = state?.waitSnapshot.pendingWaits;
    if (!waits?.length) {
      return;
    }
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

  const activeId = state?.activeSessionId ?? '';
  const active = state?.sessions.find((s) => s.id === activeId);
  const front = state?.waitSnapshot?.front;
  const pendingTail = (state?.waitSnapshot?.pendingWaits ?? []).filter((w) => w.index > 0);
  const sendQueue = outboxBySession[activeId] ?? [];
  const canPrimaryAction = Boolean(activeId.trim() && draft.trim().length > 0 && !submitting);

  /** 切换会话时重置历史展开数量，回到默认条数 */
  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    if (activeId && prevActiveIdRef.current && activeId !== prevActiveIdRef.current) {
      setHistoryExpandedBySession((prev) => {
        const n = { ...prev };
        delete n[activeId];
        return n;
      });
    }
    prevActiveIdRef.current = activeId;
  }, [activeId]);

  /** 记录各会话上一次已知的消息数量，用于检测新消息到达 */
  const prevMsgCountRef = useRef<Record<string, number>>({});

  /** 活跃会话有新消息到达时，自动重置展开数量，将旧消息收入历史 */
  useEffect(() => {
    if (!activeId || !active) return;
    const curCount = active.messages.length;
    const prevCount = prevMsgCountRef.current[activeId] ?? 0;
    // 首次加载 or 切换会话时，仅同步计数，不做重置
    if (prevCount === 0) {
      prevMsgCountRef.current = { ...prevMsgCountRef.current, [activeId]: curCount };
      return;
    }
    // 消息数量增加 → 有新消息到达，重置展开
    if (curCount > prevCount) {
      setHistoryExpandedBySession((prev) => {
        const n = { ...prev };
        delete n[activeId];
        return n;
      });
    }
    prevMsgCountRef.current = { ...prevMsgCountRef.current, [activeId]: curCount };
  }, [activeId, active?.messages.length]);

  /** 当前会话可见的消息切片 */
  const visibleLimit = historyExpandedBySession[activeId] ?? historyLimit;
  const allMessages = active?.messages ?? [];
  const totalCount = allMessages.length;
  const hasMore = totalCount > visibleLimit;
  const visibleMessages = hasMore ? allMessages.slice(totalCount - visibleLimit) : allMessages;

  /** 加载更多历史 */
  const loadMoreHistory = useCallback(() => {
    setHistoryExpandedBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? historyLimit) + LOAD_MORE_COUNT,
    }));
  }, [activeId, historyLimit]);

  /** 展开全部历史 */
  const showAllHistory = useCallback(() => {
    setHistoryExpandedBySession((prev) => ({
      ...prev,
      [activeId]: totalCount,
    }));
  }, [activeId, totalCount]);

  const waitElapsed = useMemo(() => {
    if (!front) {
      return '00:00';
    }
    return formatElapsed(front.enqueuedAt, Date.now());
  }, [front, tick]);

  const pushSettings = useCallback(
    (partial: Partial<PchatSettings>) => {
      vscode.postMessage({ type: 'settings', settings: partial });
    },
    [vscode],
  );

  const scheduleAtSuggest = useCallback(
    (query: string) => {
      if (atTimer.current) {
        clearTimeout(atTimer.current);
      }
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
    if (!el) {
      return;
    }
    const start = el.selectionStart;
    const v = el.value;
    const left = v.slice(0, start);
    const m = left.match(AT_TAIL);
    if (!m || m.index === undefined) {
      return;
    }
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

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      if (!file.type.startsWith('image/')) {
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setToast(`图片过大（>${MAX_IMAGE_BYTES >> 20}MB）：${file.name}`);
        setTimeout(() => setToast(''), 4000);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        if (!dataUrl.startsWith('data:')) {
          return;
        }
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
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onComposerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (!dt) {
        return;
      }
      const paths: string[] = [];
      const uriList = dt.getData('text/uri-list');
      if (uriList) {
        for (const line of uriList.split(/\r?\n/)) {
          if (!line.trim() || line.startsWith('#')) {
            continue;
          }
          if (line.startsWith('file://')) {
            try {
              let p = line.slice(7);
              p = decodeURIComponent(p.replace(/\+/g, ' '));
              paths.push(p);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const plain = dt.getData('text/plain')?.trim();
      if (plain && (plain.startsWith('/') || /^[A-Za-z]:[\\/]/.test(plain))) {
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
        if (imgs.length) {
          addImageFiles(imgs);
        }
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
      if (!items?.length) {
        return;
      }
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            files.push(f);
          }
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
    if (!state || !state.activeSessionId.trim() || !draft.trim() || !front || submitting) {
      return;
    }
    const body = buildSubmitBody(draft, refs, images);
    pendingSubmit.current = { draft, refs: [...refs], images: [...images] };
    setSubmitting(true);
    vscode.postMessage({ type: 'submit', sessionId: state.activeSessionId, text: body });
  }, [vscode, state, draft, front, refs, images, submitting]);

  const enqueueToSendQueue = useCallback(() => {
    if (!state?.activeSessionId.trim() || !draft.trim() || submitting) {
      return;
    }
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

  const toggleWaitCollapsed = useCallback(() => {
    setWaitCollapsed((c) => {
      const n = !c;
      persistUi({ waitCollapsed: n });
      return n;
    });
  }, [persistUi]);

  /** --- 拖拽排序回调 --- */
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
      // 从 dataTransfer 和 DOM 直接读取，避免 state 闭包过期
      const fromId = e.dataTransfer?.getData('text/plain') ?? '';
      const targetEl = (e.currentTarget as HTMLElement).closest('[data-session-id]') as HTMLElement | null;
      const toId = targetEl?.dataset.sessionId ?? '';
      setDragId(null);
      setDragOverId(null);
      if (!state || !fromId || !toId || fromId === toId) {
        return;
      }
      const rect = targetEl!.getBoundingClientRect();
      const half: 'top' | 'bottom' = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
      const ids = state.sessions.map((s) => s.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) {
        return;
      }
      ids.splice(fromIdx, 1);
      let insertIdx = ids.indexOf(toId);
      if (half === 'bottom') {
        insertIdx += 1;
      }
      ids.splice(insertIdx, 0, fromId);
      vscode.postMessage({ type: 'session:reorder', sessionIds: ids });
    },
    [state, vscode],
  );

  const onSessionDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

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
          if (it) {
            pickAtItem(it);
          }
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

  useEffect(() => {
    const rid = front?.requestId;
    const sid = activeId.trim();
    if (!rid || !sid || submitting) {
      return;
    }
    const key = `${sid}:${rid}`;
    if (autoSentOutboxKeyRef.current === key) {
      return;
    }
    const queue = outboxBySessionRef.current[sid] ?? [];
    if (queue.length === 0) {
      return;
    }
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
    setCustomCommandsOpen(false);
    setTimeout(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(taRef.current.value.length, taRef.current.value.length);
    }, 10);
  }, []);

  if (!state) {
    return <div class="pchat-empty">加载中…</div>;
  }

  return (
    <div class={`pchat-root${sidebarCollapsed ? ' pchat-root--sidebar-collapsed' : ''}`}>
      <aside class="pchat-sidebar">
        <div class="pchat-sidebar-h">
          {!sidebarCollapsed ? <span>会话</span> : <span />}
          <div style={{ display: 'flex', gap: 2 }}>
            {!sidebarCollapsed && state.sessions.length > 0 && (
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
              title={sidebarCollapsed ? '展开会话栏' : '收起会话栏'}
              onClick={toggleSidebar}
            >
              <i class={`bx ${sidebarCollapsed ? 'bx-chevrons-right' : 'bx-chevrons-left'}`} />
            </button>
          </div>
        </div>
        {!sidebarCollapsed ? (
          <div class="pchat-sessions">
            {state.sessions.length === 0 ? (
              <div class="pchat-sessions-empty" style={{ padding: '24px 10px', textAlign: 'center', color: 'var(--pchat-muted)', fontSize: 12 }}>
                <i class="bx bx-archive" style={{ fontSize: 28, opacity: 0.4, display: 'block', marginBottom: 8 }}></i>
                暂无会话
                <span style={{ opacity: 0.6, fontSize: 10, marginTop: 6, display: 'block' }}>请让 Agent 调用 <code>wait</code></span>
              </div>
            ) : null}
            {state.sessions.map((s) => (
              <div
                key={s.id}
                class={[
                  'pchat-sess-row',
                  s.id === state.activeSessionId ? 'active' : '',
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
                      const cnt = state.waitSnapshot?.sessionQueueCounts?.[s.id] ?? 0;
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
                    /* 避免焦点在重命名 input 上时点删除先触发 blur 提交 */
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
            {state.sessions.map((s) => {
              const firstChar = s.title.trim().charAt(0) || '?';
              const isActive = s.id === state.activeSessionId;
              const cnt = state.waitSnapshot?.sessionQueueCounts?.[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  class={`pchat-mini-avatar${isActive ? ' active' : ''}`}
                  title={`${s.title}\n${s.id}`}
                  onClick={() => activateSession(s.id)}
                >
                  {firstChar}
                  {cnt > 0 && <span class="pchat-mini-badge">{cnt}</span>}
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <section class="pchat-main">
        <header class="pchat-header">
          <span class={`pchat-dot ${state.bridgeConnected ? 'on' : 'off'}`} title="MCP Bridge" />
          <span class="pchat-status" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{state.bridgeConnected ? 'Bridge 已连接' : '等待 Bridge 连接…'}</span>
            {state.cursorInfo && state.cursorInfo.email && (
              <span class="pchat-cursor-info" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px', fontSize: '11px', color: 'var(--pchat-text)', opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <i class="bx bx-user-circle" />
                <span title={state.cursorInfo.email}>{state.cursorInfo.email.split('@')[0]}</span>
                {state.cursorInfo.membership && (
                  <span style={{ 
                    color: state.cursorInfo.membership.toLowerCase().includes('pro') ? '#a855f7' : state.cursorInfo.membership.toLowerCase().includes('ultra') ? '#10b981' : 'var(--pchat-muted)', 
                    fontWeight: 600, 
                    marginLeft: '2px', 
                    textTransform: 'uppercase' 
                  }}>
                    {state.cursorInfo.membership}
                  </span>
                )}
              </span>
            )}
          </span>
          <button
            type="button"
            class="pchat-icon-btn"
            title="清空当前会话聊天记录（在编辑器中确认）"
            disabled={!state.activeSessionId.trim()}
            onClick={() => {
              if (!state.activeSessionId.trim()) {
                return;
              }
              vscode.postMessage({ type: 'session:clear', sessionId: state.activeSessionId });
            }}
          >
            <i class="bx bx-trash" />
          </button>
          <div style={{ position: 'relative' }} ref={settingsRef}>
            <button
              type="button"
              class={`pchat-icon-btn ${settingsOpen ? 'active' : ''}`}
              title="显示设置"
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <i class="bx bx-cog" />
            </button>
            {settingsOpen && (
              <div class="pchat-settings-drawer">
                <div class="pchat-settings-h">显示设置</div>
                <div class="pchat-settings-body">
                  <label class="pchat-settings-label">
                    <span>每个会话默认显示历史消息数</span>
                    <div class="pchat-settings-stepper">
                      <button
                        type="button"
                        class="pchat-settings-step-btn"
                        disabled={historyLimit <= 1}
                        onClick={() => setHistoryLimit((n) => Math.max(1, n - 1))}
                      >
                        −
                      </button>
                      <span class="pchat-settings-step-value">{historyLimit}</span>
                      <button
                        type="button"
                        class="pchat-settings-step-btn"
                        onClick={() => setHistoryLimit((n) => Math.min(100, n + 1))}
                      >
                        +
                      </button>
                    </div>
                  </label>
                  <div class="pchat-settings-hint">
                    减少默认条数可降低切换会话时的渲染负担，往上滚动可按需加载更多。
                  </div>
                </div>
              </div>
            )}
          </div>
        </header>

        <div class="pchat-msgs" ref={msgsRef} onScroll={onMsgsScroll}>
          {!state.activeSessionId.trim() ? (
            <div class="pchat-empty">
              <i class="bx bx-plug" style={{ fontSize: 36, opacity: 0.4, display: 'block', marginBottom: 12 }}></i>
              <strong style={{ fontSize: 14, color: 'var(--pchat-text)', display: 'block', marginBottom: 8 }}>等待接入</strong>
              <span style={{ opacity: 0.7 }}>请在 Agent 中触发 <code>wait_for_user_input</code></span>
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
                    onClick={loadMoreHistory}
                  >
                    <i class="bx bx-chevron-up" />
                    查看更多历史（还有 {totalCount - visibleLimit} 条）
                  </button>
                  <button
                    type="button"
                    class="pchat-load-all-btn"
                    onClick={showAllHistory}
                    title="展开全部历史">
                    全部
                  </button>
                </div>
              )}
              {visibleMessages.map((m) => <MessageBubble key={m.id} msg={m} />)}
            </>
          )}
        </div>

        <div
          class="pchat-composer"
          onDragOver={onComposerDragOver}
          onDrop={onComposerDrop}
        >
          {state.activeSessionId.trim() && sendQueue.length > 0 ? (
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
                      onClick={() => moveOutboxItemToComposer(state.activeSessionId, it)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      class="pchat-send-q-remove"
                      title="从发送队列移除"
                      onClick={() => removeOutboxItem(state.activeSessionId, it.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {state.activeSessionId.trim() && pendingTail.length > 0 ? (
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
                          sessionId: state.activeSessionId,
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
                      setQueuedDrafts((d) => ({ ...d, [w.requestId]: v }));
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div class="pchat-composer-tools" style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              class="pchat-icon-btn pchat-btn-sec"
              title="插入图片"
              onClick={() => imgInputRef.current?.click()}
            >
              <i class="bx bx-image" />
            </button>
            <button
              type="button"
              class="pchat-icon-btn pchat-btn-sec"
              title="附加工作区文件"
              onClick={() => vscode.postMessage({ type: 'file:pick' })}
            >
              <i class="bx bx-folder-open" />
            </button>
            <div style={{ position: 'relative' }} ref={cmdMenuRef}>
              <button
                type="button"
                class={`pchat-icon-btn pchat-btn-sec ${customCommandsOpen ? 'active' : ''}`}
                title="快捷指令"
                onClick={() => setCustomCommandsOpen(!customCommandsOpen)}
              >
                <i class="bx bx-command" />
              </button>
              {customCommandsOpen && (
                <div class="pchat-cmd-drawer">
                  <div class="pchat-cmd-h">快捷指令</div>
                  <div class="pchat-cmd-list">
                    {customCommands.map(cmd => (
                      <div key={cmd.id} class="pchat-cmd-item" onClick={() => {
                        if (editingCmdId !== cmd.id) applyCustomCmd(cmd.text);
                      }}>
                        {editingCmdId === cmd.id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 4 }}>
                            <textarea
                              class="pchat-cmd-input"
                              value={editingCmdText}
                              onInput={(e) => setEditingCmdText((e.target as HTMLTextAreaElement).value)}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                              rows={2}
                            />
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                              <button
                                class="pchat-cmd-btn pchat-cmd-btn-cancel"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingCmdId(null);
                                  if (!cmd.text) {
                                    setCustomCommands(cmds => cmds.filter(c => c.id !== cmd.id));
                                  }
                                }}
                              >
                                取消
                              </button>
                              <button
                                class="pchat-cmd-btn pchat-cmd-btn-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!editingCmdText.trim()) {
                                    setCustomCommands(cmds => cmds.filter(c => c.id !== cmd.id));
                                  } else {
                                    setCustomCommands(cmds => cmds.map(c => c.id === cmd.id ? { ...c, text: editingCmdText } : c));
                                  }
                                  setEditingCmdId(null);
                                }}
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div class="pchat-cmd-text">{cmd.text}</div>
                            <div class="pchat-cmd-actions">
                              <button class="pchat-cmd-action-btn" title="编辑" onClick={(e) => {
                                e.stopPropagation();
                                setEditingCmdId(cmd.id);
                                setEditingCmdText(cmd.text);
                              }}>
                                <i class="bx bx-edit" />
                              </button>
                              <button class="pchat-cmd-action-btn pchat-cmd-action-danger" title="删除" onClick={(e) => {
                                e.stopPropagation();
                                setCustomCommands(cmds => cmds.filter(c => c.id !== cmd.id));
                              }}>
                                <i class="bx bx-trash" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  <div class="pchat-cmd-add">
                    <button class="pchat-cmd-add-btn" onClick={() => {
                      const newId = `c_${Date.now()}`;
                      setCustomCommands(cmds => [...cmds, { id: newId, text: '' }]);
                      setEditingCmdId(newId);
                      setEditingCmdText('');
                    }}>
                      <i class="bx bx-plus" /> 添加指令
                    </button>
                  </div>
                </div>
              )}
            </div>
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
              </div>
            ) : null}
          </div>
          {images.length > 0 || refs.length > 0 ? (
            <div class="pchat-chips-scroll" role="list">
              {images.map((im) => (
                <span key={im.id} class="pchat-chip pchat-chip-img" title={im.name}>
                  <i class="bx bx-image" />
                  {im.name}
                  <button
                    type="button"
                    aria-label="移除"
                    onClick={() => setImages((x) => x.filter((y) => y.id !== im.id))}
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
                    onClick={() => setRefs((x) => x.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
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
              disabled={!state.activeSessionId.trim()}
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
      </section>

      {toast ? <div class="pchat-toast">{toast}</div> : null}
    </div>
  );
}

/**
 * 单条聊天消息气泡（用户消息也走 Markdown，便于图片与格式；自用场景信任本地输入）。
 */
function MessageBubble({ msg }: { msg: StoredChatMessage }) {
  const [copied, setCopied] = useState(false);
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);
  const html = useMemo(() => renderMarkdown(msg.body), [msg.body]);
  const isUser = msg.role === 'user';
  const roleName = isUser ? '你' : msg.role === 'assistant' ? '助手' : '系统';
  const avatar = isUser ? userAvatarUrl : aiAvatarUrl;
  const timeStr = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.body).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [msg.body]);

  const handleBodyClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG' && target.hasAttribute('src')) {
      const src = target.getAttribute('src');
      if (src) setZoomedImg(src);
    }
  }, []);

  return (
    <>
      <div class={`pchat-msg-row ${msg.role}`}>
      <img class="pchat-avatar" src={avatar} alt="avatar" />
      <div class="pchat-msg-content">
        <div class="pchat-msg-meta">
          <span class="pchat-msg-name">{roleName}</span>
          <span class="pchat-msg-time">{timeStr}</span>
        </div>
        <div 
          class="pchat-bubble-wrap" 
          onDblClick={isUser ? handleCopy : undefined} 
          title={isUser ? "双击复制内容" : ""}
        >
          {copied && (
            <div style={{ position: 'absolute', top: -20, right: 0, background: 'var(--pchat-surface-elevated)', border: '1px solid var(--pchat-border)', borderRadius: 4, padding: '2px 6px', fontSize: 10, color: 'var(--pchat-success)', pointerEvents: 'none', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', zIndex: 10 }}>已复制</div>
          )}
          <div class="pchat-bubble-caret" />
          <div class="pchat-bubble-body body" dangerouslySetInnerHTML={{ __html: html }} onClick={handleBodyClick} />
        </div>
      </div>
    </div>
    {zoomedImg && (
      <div class="pchat-image-lightbox" onClick={() => setZoomedImg(null)} title="点击关闭">
        <img src={zoomedImg} alt="zoomed" />
      </div>
    )}
    </>
  );
}

