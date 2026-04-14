/**
 * @fileoverview 自定义 SVG 工具栏图标（替代 boxicons）。
 * 图标源文件保存在 media/ 目录下，此处以内联方式嵌入确保 Webview CSP 兼容。
 */

const svgStyle = { width: 16, height: 16, display: 'inline-block', verticalAlign: 'middle' };

/** 图片图标（media/icon-image.svg） */
export function IconImage() {
  return (
    <svg viewBox="0 0 1024 1024" style={svgStyle} xmlns="http://www.w3.org/2000/svg">
      <path d="M906.666667 160v704h-768v-704h768z m-167.061334 366.4l-216.405333 180.096-140.565333-110.890667L202.666667 741.141333V800h640v-188.117333l-103.061334-85.482667zM842.666667 224h-640v434.837333l179.477333-145.130666 139.968 110.421333 217.450667-180.906667 103.104 85.504V224z m-437.333334 42.666667a96 96 0 1 1 0 192 96 96 0 0 1 0-192z m0 64a32 32 0 1 0 0 64 32 32 0 0 0 0-64z" fill="currentColor" />
    </svg>
  );
}

/** 文件图标（media/icon-file.svg） */
export function IconFile() {
  return (
    <svg viewBox="0 0 1024 1024" style={svgStyle} xmlns="http://www.w3.org/2000/svg">
      <path d="M512 96c229.76 0 416 186.24 416 416S741.76 928 512 928 96 741.76 96 512 282.24 96 512 96z m0 64C317.589333 160 160 317.589333 160 512S317.589333 864 512 864 864 706.410667 864 512 706.410667 160 512 160z m10.666667 170.666667c51.882667 0 100.522667 20.736 136.234666 56.704l4.586667 4.778666-46.933333 43.52a128 128 0 1 0-4.096 178.24l4.096-4.245333 46.933333 43.52A192 192 0 1 1 522.666667 330.666667z" fill="currentColor" />
    </svg>
  );
}

/** 快捷指令图标（media/icon-command.svg） */
export function IconCommand() {
  return (
    <svg viewBox="0 0 1024 1024" style={svgStyle} xmlns="http://www.w3.org/2000/svg">
      <path d="M714.666667 117.333333v64h170.666666v704h-746.666666v-704h170.666666v-64h405.333334z m-405.333334 128h-106.666666v576h618.666666v-576h-106.666666v64h-405.333334v-64zM704 618.666667v64H320v-64h384z m0-192v64H320v-64h384zM650.666667 181.333333h-277.333334v64h277.333334v-64z" fill="currentColor" />
    </svg>
  );
}
