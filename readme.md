# PChat（自用）

Cursor / VS Code 扩展 + MCP：让 Agent 调用 `wait_for_user_input` 时在侧栏阻塞等待你的回复，支持自动续期 `__TIMEOUT_RENEW__`。

## 构建

```bash
cd pchat
npm install
npm run build
```

生成：

- `dist/extension.js` — 扩展宿主
- `dist/bridge.js` — MCP stdio 进程
- `dist/webview/` — 侧栏 UI 资源

## 安装扩展

打包成 `.vsix`：阅读 `PACKAGING.md`。**macOS** 可在 `pchat` 目录**双击 `一键打包VSIX.command`**；或运行 `scripts/package-vsix.sh`（macOS/Linux）、`scripts\package-vsix.cmd`（Windows）。

在 Cursor 中选择 **Install from VSIX**，或 `Developer: Install Extension from Location...` 指向本目录（开发模式）。

## 配置 MCP

### 本仓库（推荐在本项目开发时）

仓库根目录已有 **`.cursor/mcp.json`**，用启动脚本调用 `pchat/scripts/mcp-bridge-launcher.cjs`（会先检查是否已 `npm run build`）。请先 **`cd pchat && npm run build`**，再在 Cursor 中**刷新 MCP** 或**重启 Cursor**。扩展仍须加载，并**打开一次左侧 PChat 侧栏**（扩展会把监听端口写入 `~/.cursor/pchat-bridge.port`，与「仓库里的 bridge」路径是否一致无关）。

若你的 Cursor 版本**不展开** `${workspaceFolder}`，请改用手动配置里的**绝对路径**（见下），或依赖扩展自动写入 `~/.cursor/mcp.json`。

### 自动（推荐，Cursor）

扩展激活时会尝试把 **`mcpServers.pchat`** 合并进用户目录下的 **`~/.cursor/mcp.json`**（指向当前扩展内的 `dist/bridge.js`）。写入成功后请在 Cursor 里**刷新 MCP 列表**，并**先打开一次**左侧 **PChat** 侧栏（扩展会写端口文件，bridge 才能连上）。

若不想自动改配置文件，在设置里将 **`PChat: Disable Auto Mcp`**（`pchat.disableAutoMcp`）设为 **true**。

### 手动

1. 命令面板：**`PChat: 复制 MCP 配置（bridge.js）到剪贴板`**，再合并进你的 MCP 配置并保存。
2. 打开一次 **PChat** 侧栏。

> 说明：以前在 Cursor 里看到的 **`user-persistent-chat`** 等是 **Cursor 自带的 MCP 名称**，与从 VSIX 安装的扩展不是同一条链路；本扩展对应的是配置里的 **`pchat`** 服务器（本地 `bridge.js`）。

示例（路径请与剪贴板一致）：

```json
{
  "mcpServers": {
    "pchat": {
      "command": "node",
      "args": ["/绝对路径/到/扩展/dist/bridge.js"]
    }
  }
}
```

## 使用

1. 加载扩展并打开左侧 **PChat** 视图。
2. 启用上述 MCP。
3. 在 Chat 使用 **Agent**，模型在规则中于每轮末尾调用 `wait_for_user_input` 即可在侧栏等待输入。

### Cursor / Agent 规则（推荐复制到 `.cursor/rules` 或用户规则）

下面整段可原样粘贴到 Cursor 规则，让模型**优先走侧栏**而不是只在 Composer 里打字结束一轮。

- **何时调用**：每一轮助手回复后，只要**还需要用户在侧栏继续**（例如已列出选项 1/2/3、等待确认、任务未完结、或用户习惯用短答如「1」「3」承接上文），**应调用**当前已连接 MCP 上的 `wait_for_user_input`，用工具参数 `message` 承载**本轮完整可见正文**。仅在工具调用失败（MCP 未连接、报错）时，才改为在 Composer 里说明并请用户检查 MCP 与侧栏。
- **`sessionId`（必填）**：在本 Composer/Agent 对话中**第一次**需要调用 `wait_for_user_input` 时，生成**恰好 8 位**、仅含 `0-9` 与 `A-Z`/`a-z` 的字符串，并在**本对话内每次**调用传入**完全相同**的值。不要用完整 UUID，不要用 `mcp-chat-composer-` 等前缀（与下节「多开」规则一致）。
- **与 Persistent Chat 二选一**：若工作区或 Cursor 里启用的是 **Persistent Chat**（MCP 名常为 `user-persistent-chat`），工具名通常同为 `wait_for_user_input`，**以 Cursor「MCP → 该服务器 → 工具描述与参数」为准**；与 **PChat（本扩展，`mcp.json` 里的 `pchat`）** 不要混在同一流程里并用，建议只启用一个侧栏方案，避免串台。
- **调用前**：先扫一眼可用 MCP 列表，确认 `pchat`（或你选用的 persistent 服务器）**已连接**；扩展需加载，并**打开过一次**对应侧栏（PChat 见上文「配置 MCP」）。

**工具参数（与本仓库 `pchat/src/bridge/main.ts` 一致）**

| 参数 | 必填 | 说明 |
|------|------|------|
| `message` | 是 | 展示给用户的完整回复正文 |
| `sessionId` | 是 | 8 位字母数字，本对话内固定复用 |
| `prompt` | 否 | 输入框上方提示 |
| `title` | 否 | 侧栏会话标题 |

### 多开 Agent 对话与 `sessionId`（重要）

- **格式（必填）**：`sessionId` 必须是**恰好 8 位**的**英文字母或数字**（如 `k9m2x7p4`、`a7K2m9Qx`）。不要用完整 UUID，不要用 `mcp-chat-composer-日期` 这类可读串；Bridge 会校验，不符合则工具返回错误，便于模型改传正确格式。
- **同一 Composer**：在对话开头随机生成一次上述 8 位串，**每次** `wait_for_user_input` 传入**同一值**，侧栏才会留在同一会话。
- **不同 Composer**：各用不同的 8 位串，侧栏会话互不串台。

### 侧栏能力（相对原版的补齐）

- **会话栏可折叠**；无内置「默认」会话，**仅当 Agent 调用 `wait_for_user_input`（并携带 `sessionId` 规则见上）时自动建会话**；**双击会话名重命名**；删除与清空聊天记录均由编辑器弹出确认。
- **等待队列**：除队首外，排队项显示在**输入框上方**，可写**预备回复**（轮到队首时自动填入主输入框）或**移除**（向 Agent 返回 `__USER_DISMISSED_QUEUE__`）。
- **消息列表**：仅当滚动条距底部 ≤20px 时才自动滚到最新，便于回看历史。
- **拖放**：可将资源管理器中的文件**拖入底部输入区域**引用（工作区内路径，与文件夹按钮一致）。
- **等待区可折叠/展开**（标题显示剩余时间 `mm:ss`）；状态通过 `vscode.getState/setState` 持久化。
- **`@` 补全**带 **seq**，丢弃过期响应，避免快速输入时列表错乱；查询支持非 ASCII 路径片段。
- **图片**：工具栏插入、**粘贴剪贴板截图**；大于 3MB 会提示；随消息以 Markdown 图片（含 `data:`）发给模型。
- **用户消息**与助手一致走 **Markdown**，便于回看图片与代码块（自用场景；勿粘贴不可信 HTML 源码）。
- **发送中锁**：等待 `submit:ack` 前按钮显示 `…`，避免双击重复提交。
- **工作区**增删改名文件后会 **失效 @ 索引缓存**，下次 `@` 重新扫描。

### Bridge TCP

- 断线后 **`connecting` 单例重连**，不再用无限增长的 `Promise.then` 链，避免长期运行后内存与逻辑异常。

## 命令与快捷键

- **复制 MCP 配置**：命令面板 → `PChat: 复制 MCP 配置（bridge.js）到剪贴板`
- **引用当前文件**：`Cmd/Ctrl+Shift+A`
- **引用选中**：`Cmd/Ctrl+Shift+L`
- 资源管理器右键 **引用到 PChat**

## 许可

MIT
