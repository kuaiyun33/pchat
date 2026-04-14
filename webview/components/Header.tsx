/**
 * @fileoverview 顶部状态栏：Bridge 状态、清空按钮、设置面板。
 * 自管理设置面板的开关状态。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VsCodeApi } from '../vscode';

type HeaderProps = {
  vscode: VsCodeApi;
  bridgeConnected: boolean;
  activeSessionId: string;
  cursorInfo?: {
    email?: string;
    membership?: string;
  };
  historyLimit: number;
  onHistoryLimitChange: (n: number) => void;
  rulesStatus?: { status: 'ok' | 'error' | 'disabled'; message: string; timestamp: number };
  onRewriteRules: () => void;
  settings?: any;
  onSettingsChange?: (s: any) => void;
  onOpenBroadcast: () => void;
};

export function Header({
  vscode,
  bridgeConnected,
  activeSessionId,
  cursorInfo,
  historyLimit,
  onHistoryLimitChange,
  rulesStatus,
  onRewriteRules,
  settings,
  onSettingsChange,
  onOpenBroadcast,
}: HeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  /** 后端推送了新的 rulesStatus（timestamp 变更）时重置加载态 */
  useEffect(() => {
    if (rulesStatus?.timestamp) {
      setRulesLoading(false);
    }
  }, [rulesStatus?.timestamp]);

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

  const memberType = cursorInfo?.membership;
  const memberLabel = memberType ? memberType.charAt(0).toUpperCase() + memberType.slice(1) : '';
  const memberColor = memberType === 'pro' ? '#722ED1' : memberType === 'business' ? '#D46B08' : '#555';

  return (
    <header class="pchat-header">
      <span class={`pchat-dot ${bridgeConnected ? 'on' : 'off'}`} title="MCP Bridge" />
      <span class="pchat-status" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span>{bridgeConnected ? 'Bridge 已连接' : '等待 Bridge…'}</span>
        {cursorInfo && cursorInfo.email && (
          <span 
            class="pchat-cursor-info" 
            style={{ 
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', color: 'rgba(255,255,255,0.85)', overflow: 'hidden', 
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              padding: '2px 8px', borderRadius: '10px',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <i class="bx bx-user-circle" style={{ opacity: 0.7 }} />
            <span>{cursorInfo.email}</span>
            {memberLabel && (
              <span style={{ 
                padding: '0 5px', borderRadius: '8px', fontSize: '10px', fontWeight: 600,
                background: memberColor, color: '#fff', marginLeft: '2px', textTransform: 'uppercase',
                lineHeight: '16px',
              }}>
                {memberLabel}
              </span>
            )}
          </span>
        )}
      </span>
      {(!rulesStatus || rulesStatus.status !== 'disabled') && (
        <button
          type="button"
          class="pchat-icon-btn"
          title={
            rulesLoading
              ? '正在写入规则…'
              : rulesStatus
                ? `规则状态：${rulesStatus.message} (点击重新写入)`
                : '点击写入 PChat 规则到工作区'
          }
          onClick={() => {
            if (rulesLoading) return;
            setRulesLoading(true);
            onRewriteRules();
          }}
          disabled={rulesLoading}
          style={{
            color: rulesLoading
              ? 'var(--pchat-muted, #888)'
              : rulesStatus?.status === 'ok'
                ? '#10b981'
                : rulesStatus?.status === 'error'
                  ? '#ef4444'
                  : 'var(--pchat-muted, #888)',
          }}
        >
          <i class={
            rulesLoading
              ? 'bx bx-loader-alt bx-spin'
              : rulesStatus?.status === 'ok'
                ? 'bx bx-check-shield'
                : rulesStatus?.status === 'error'
                  ? 'bx bx-shield-x'
                  : 'bx bx-shield-quarter'
          } />
        </button>
      )}
      <button
        type="button"
        class="pchat-icon-btn"
        style={{ padding: '0 8px', width: 'auto', display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}
        title="给选定的多个会话发送群发消息"
        onClick={onOpenBroadcast}
      >
        <i class="bx bx-broadcast" />
        <span style={{ fontSize: '12px', fontWeight: 500 }}>群发消息</span>
      </button>
      <button
        type="button"
        class="pchat-icon-btn"
        title="清空记录并重新加载（此过程不影响持久化的排队）"
        disabled={!activeSessionId.trim()}
        onClick={() => {
          if (!activeSessionId.trim()) return;
          vscode.postMessage({ type: 'session:clear', sessionId: activeSessionId });
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
                <span>会话默认流式显示的条数</span>
                <div class="pchat-settings-stepper">
                  <button
                    type="button"
                    class="pchat-settings-step-btn"
                    disabled={historyLimit <= 1}
                    onClick={() => onHistoryLimitChange(Math.max(1, historyLimit - 1))}
                  >
                    −
                  </button>
                  <span class="pchat-settings-step-value">{historyLimit}</span>
                  <button
                    type="button"
                    class="pchat-settings-step-btn"
                    onClick={() => onHistoryLimitChange(Math.min(100, historyLimit + 1))}
                  >
                    +
                  </button>
                </div>
              </label>

              <hr style={{ margin: '12px 0', border: 'none', borderTop: '1px solid var(--pchat-border)' }} />

              <div class="pchat-settings-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <strong>全局附加内容</strong>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={settings?.globalPayload?.enabled ?? false}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        onSettingsChange?.({ globalPayload: { ...(settings?.globalPayload || { position: 'tail', text: '' }), enabled: checked } });
                      }}
                    />
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>启用</span>
                  </label>
                </div>

                {settings?.globalPayload?.enabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                         <input type="radio" 
                           name="gp-pos"
                           checked={settings?.globalPayload?.position === 'head'}
                           onChange={() => onSettingsChange?.({ globalPayload: { ...settings.globalPayload, position: 'head' } })}
                         />
                         在消息头部
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                         <input type="radio" 
                           name="gp-pos"
                           checked={settings?.globalPayload?.position !== 'head'}
                           onChange={() => onSettingsChange?.({ globalPayload: { ...settings.globalPayload, position: 'tail' } })}
                         />
                         在消息末尾
                      </label>
                    </div>
                    <textarea 
                      class="pchat-ta"
                      style={{ minHeight: '60px', padding: '6px' }}
                      placeholder="每次发消息时，所有对话自动且隐藏拼写这段内容..."
                      value={settings?.globalPayload?.text ?? ''}
                      onInput={(e) => {
                        const v = (e.target as HTMLTextAreaElement).value;
                        onSettingsChange?.({ globalPayload: { ...settings.globalPayload, text: v } });
                      }}
                    />
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </div>
    </header>
  );
}
