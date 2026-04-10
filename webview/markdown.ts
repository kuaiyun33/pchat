/**
 * @fileoverview Markdown 渲染（marked + highlight.js），用于助手消息气泡。
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import { marked } from 'marked';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('bash', bash);

marked.use({
  renderer: {
    html(htmlStr: string) {
      return escapeHtml(htmlStr);
    },
    code(code: string, infostring: string | undefined) {
      const lang = infostring?.trim() || '';
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        const highlighted =
          language === 'plaintext'
            ? escapeHtml(code)
            : hljs.highlight(code, { language }).value;
        return `<pre class="hljs-wrap"><code class="hljs language-${language}">${highlighted}</code></pre>`;
      } catch {
        return `<pre class="hljs-wrap"><code>${escapeHtml(code)}</code></pre>`;
      }
    },
  },
});

/**
 * 将纯文本转义为可安全插入 HTML 的字符串。
 *
 * @param s - 原始文本
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 将 Markdown 转为 HTML 片段（同步）。
 *
 * @param md - Markdown 源码
 */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
