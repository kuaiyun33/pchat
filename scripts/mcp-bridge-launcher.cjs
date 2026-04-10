'use strict';

/**
 * Cursor 项目级 MCP 入口：始终存在于仓库中（不依赖已提交的 dist），未构建时给出明确提示。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const bridge = path.join(__dirname, '..', 'dist', 'bridge.js');
if (!fs.existsSync(bridge)) {
  console.error(
    '[pchat] 未找到 dist/bridge.js。请在 pchat 目录执行：npm install && npm run build',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [bridge], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
