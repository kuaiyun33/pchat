/**
 * @fileoverview 快捷指令面板：CRUD 管理 + localStorage 持久化。
 * 自管理 open/editing/commands 状态，对外仅暴露 onApply 回调。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CustomCmd } from '../types';
import { IconCommand } from './ToolbarIcons';

type CommandPaletteProps = {
  /** 用户选择一条指令时回调，由父级处理（如填入输入框） */
  onApply: (text: string) => void;
};

export function CommandPalette({ onApply }: CommandPaletteProps) {
  const menuRef = useRef<HTMLDivElement>(null);

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

  const [commands, setCommands] = useState<CustomCmd[]>(defaultCmds);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  /* 持久化 */
  useEffect(() => {
    localStorage.setItem('pchat_custom_commands_v1', JSON.stringify(commands));
  }, [commands]);

  /* 点击外部关闭 */
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleApply = useCallback(
    (text: string) => {
      onApply(text);
      setOpen(false);
    },
    [onApply],
  );

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        type="button"
        class={`pchat-icon-btn pchat-btn-sec ${open ? 'active' : ''}`}
        title="快捷指令"
        onClick={() => setOpen(!open)}
      >
        <IconCommand />
      </button>
      {open && (
        <div class="pchat-cmd-drawer">
          <div class="pchat-cmd-h">快捷指令</div>
          <div class="pchat-cmd-list">
            {commands.map(cmd => (
              <div 
                key={cmd.id} 
                class="pchat-cmd-item"
                onClick={() => {
                  if (editingId !== cmd.id) handleApply(cmd.text);
                }}
              >
                {editingId === cmd.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 4 }}>
                    <textarea
                      class="pchat-cmd-input"
                      value={editingText}
                      onInput={(e) => setEditingText((e.target as HTMLTextAreaElement).value)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      rows={2}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                      <button
                        class="pchat-cmd-btn pchat-cmd-btn-cancel"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(null);
                          if (!cmd.text) {
                            setCommands(cmds => cmds.filter(c => c.id !== cmd.id));
                          }
                        }}
                      >
                        取消
                      </button>
                      <button
                        class="pchat-cmd-btn pchat-cmd-btn-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!editingText.trim()) {
                            setCommands(cmds => cmds.filter(c => c.id !== cmd.id));
                          } else {
                            setCommands(cmds => cmds.map(c => c.id === cmd.id ? { ...c, text: editingText } : c));
                          }
                          setEditingId(null);
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
                        setEditingId(cmd.id);
                        setEditingText(cmd.text);
                      }}>
                        <i class="bx bx-edit" />
                      </button>
                      <button class="pchat-cmd-action-btn pchat-cmd-action-danger" title="删除" onClick={(e) => {
                        e.stopPropagation();
                        setCommands(cmds => cmds.filter(c => c.id !== cmd.id));
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
              setCommands(cmds => [{ id: newId, text: '' }, ...cmds]);
              setEditingId(newId);
              setEditingText('');
            }}>
              <i class="bx bx-plus" /> 添加指令
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
