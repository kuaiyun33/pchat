/**
 * 使用 esbuild 打包扩展宿主与 MCP bridge（CommonJS，Node 18+）。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const extOpts = {
  entryPoints: [path.join(root, 'src/extension/extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(root, 'dist/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  sourcemap: true,
};

const bridgeOpts = {
  entryPoints: [path.join(root, 'src/bridge/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(root, 'dist/bridge.js'),
  format: 'cjs',
  sourcemap: true,
};

if (watch) {
  const ctx1 = await esbuild.context(extOpts);
  const ctx2 = await esbuild.context(bridgeOpts);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log('[pchat] watching extension + bridge');
} else {
  await esbuild.build(extOpts);
  await esbuild.build(bridgeOpts);
  console.log('[pchat] built dist/extension.js + dist/bridge.js');
}
