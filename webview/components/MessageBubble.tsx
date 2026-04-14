/**
 * @fileoverview 单条聊天消息气泡（用户消息也走 Markdown，便于图片与格式；自用场景信任本地输入）。
 * 超过 MAX_COLLAPSED_HEIGHT 的消息自动折叠，可点击展开/收起。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../markdown';
import aiAvatarUrl from '../ai_avatar.svg';
import userAvatarUrl from '../user_avatar.svg';
import type { StoredChatMessage } from '../types';

/** 折叠阈值（像素），约 20 行文字高度 */
const MAX_COLLAPSED_HEIGHT = 300;

/**
 * 将时间戳格式化为相对时间（刚刚/N分钟前/N小时前/昨天 HH:mm/日期）。
 */
function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;

  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const timepart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${timepart}`;
  }
  // 同年只显示月/日 + 时间
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${timepart}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${timepart}`;
}

export function MessageBubble({ msg }: { msg: StoredChatMessage }) {
  const [copied, setCopied] = useState(false);
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [isLong, setIsLong] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(msg.body), [msg.body]);
  const isUser = msg.role === 'user';
  const roleName = isUser ? '你' : msg.role === 'assistant' ? '助手' : '系统';
  const avatar = isUser ? userAvatarUrl : aiAvatarUrl;
  const relativeTime = useMemo(() => formatRelativeTime(msg.ts), [msg.ts]);
  const fullTime = useMemo(() => new Date(msg.ts).toLocaleString(), [msg.ts]);

  /** 渲染后检测内容高度是否超过阈值 */
  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      setIsLong(el.scrollHeight > MAX_COLLAPSED_HEIGHT);
    }
  }, [html]);

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
          <span class="pchat-msg-time" title={fullTime}>{relativeTime}</span>
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
          <div
            ref={bodyRef}
            class={`pchat-bubble-body body${isLong && collapsed ? ' pchat-bubble-body--collapsed' : ''}`}
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={handleBodyClick}
          />
          {isLong && (
            <button
              type="button"
              class="pchat-bubble-toggle"
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? '展开更多 ▾' : '收起 ▴'}
            </button>
          )}
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
