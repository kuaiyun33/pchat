/**
 * VS Code Webview 注入的全局 API。
 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

export {};
