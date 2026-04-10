/**
 * @fileoverview Webview 入口：挂载 Preact、加载 Boxicons 与全局样式。
 */
import { render } from 'preact';
import 'boxicons/css/boxicons.min.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';

const vscode = acquireVsCodeApi();

render(<App vscode={vscode} />, document.getElementById('root')!);
