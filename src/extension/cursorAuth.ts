import * as os from 'node:os';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import * as util from 'node:util';
import * as fs from 'node:fs';

const execFile = util.promisify(child_process.execFile);

export type CursorAuthInfo = {
  email?: string;
  membership?: string;
  subscriptionStatus?: string;
};

/** 各平台 Cursor 的 state.vscdb 所在目录 */
function getCursorStateDbPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

/** 需要读取的 key 列表 */
const AUTH_KEYS = [
  'cursorAuth/cachedEmail',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/stripeSubscriptionStatus',
] as const;

/**
 * 尝试通过 sqlite3 命令行读取 KV 值。
 * macOS / Linux 通常自带 `/usr/bin/sqlite3`。
 */
async function readViaSqlite3Cli(dbPath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const sqlite3Bin = process.platform === 'win32' ? 'sqlite3' : '/usr/bin/sqlite3';

  const query = `
    SELECT key, value FROM ItemTable 
    WHERE key IN (${AUTH_KEYS.map((k) => `'${k}'`).join(', ')});
  `;

  const { stdout } = await execFile(sqlite3Bin, [dbPath, query], {
    encoding: 'utf8',
    timeout: 5000,
  });

  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('|');
    if (idx > 0) {
      const k = line.substring(0, idx).trim();
      const v = line.substring(idx + 1).trim();
      if (v) result[k] = v;
    }
  }

  return result;
}

/**
 * 当 sqlite3 命令行不可用时（Windows 最常见），
 * 直接在 SQLite 文件的二进制内容中搜索已知 key 并提取后面的 value。
 * 原理：SQLite 的 B-tree 叶子页中，KV 行的 key 和 value 字符串通常紧挨着存储，
 * 中间由 varint 长度头连接。对于简单的 TEXT key/value 查询足够可靠。
 */
function readViaBinarySearch(buf: Buffer): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of AUTH_KEYS) {
    const keyBuf = Buffer.from(key, 'utf8');
    let searchFrom = 0;

    while (searchFrom < buf.length) {
      const pos = buf.indexOf(keyBuf, searchFrom);
      if (pos < 0) break;

      // 从 key 末尾开始，查找紧跟的 value 字符串。
      // SQLite 内部格式：记录头（varint 列类型列表）+ 各列数据（key bytes, value bytes）。
      // key 后面的 value 通常紧跟在 key 之后，可能有 0~几个字节的分隔。
      const afterKey = pos + keyBuf.length;
      if (afterKey >= buf.length) break;

      // 策略：跳过 key 后的非 ASCII-printable 字节（最多 16 字节），
      // 然后提取连续的 printable 字符串作为 value。
      let valueStart = afterKey;
      const maxSkip = Math.min(afterKey + 16, buf.length);
      while (valueStart < maxSkip) {
        const b = buf[valueStart];
        // 可打印 ASCII 且不是控制字符
        if (b >= 0x20 && b <= 0x7e) break;
        valueStart++;
      }

      if (valueStart < buf.length) {
        let valueEnd = valueStart;
        // 提取可打印字符串（到不可打印字符或合理的最大长度）
        while (valueEnd < buf.length && valueEnd - valueStart < 512) {
          const b = buf[valueEnd];
          if (b < 0x20 || b > 0x7e) break;
          valueEnd++;
        }
        const value = buf.subarray(valueStart, valueEnd).toString('utf8').trim();
        if (value.length > 0 && !AUTH_KEYS.includes(value as any)) {
          // 基本验证：email 应包含 @，membership 是单词，subscription 也是
          if (key === 'cursorAuth/cachedEmail') {
            if (value.includes('@')) {
              result[key] = value;
              break;
            }
          } else {
            // membership / subscriptionStatus 通常是如 "pro", "business", "active" 等短字符串
            if (value.length < 100) {
              result[key] = value;
              break;
            }
          }
        }
      }

      searchFrom = pos + 1;
    }
  }

  return result;
}

/**
 * 从 Cursor 本地 state.vscdb 读取账号基础信息（email / membership / subscriptionStatus）。
 * 支持 macOS / Windows / Linux。
 */
export async function getCursorAuthInfo(): Promise<CursorAuthInfo> {
  const info: CursorAuthInfo = {};

  try {
    const originalDbPath = getCursorStateDbPath();
    if (!fs.existsSync(originalDbPath)) {
      return info;
    }

    // 拷贝到 tmp 避免 Cursor 运行时的 SQLite 锁
    const dbPath = path.join(os.tmpdir(), `cursor_tmp_${Date.now()}.vscdb`);
    fs.copyFileSync(originalDbPath, dbPath);

    let kvMap: Record<string, string> = {};

    try {
      // 优先尝试 sqlite3 命令行（macOS/Linux 通常可用）
      kvMap = await readViaSqlite3Cli(dbPath);
    } catch {
      // sqlite3 命令行不可用（Windows 常见），回退到二进制解析
      try {
        const buf = fs.readFileSync(dbPath);
        kvMap = readViaBinarySearch(buf);
      } catch (e2) {
        console.error('[pchat] Binary SQLite fallback failed:', e2);
      }
    }

    // 读完结果后删除临时文件
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }

    if (kvMap['cursorAuth/cachedEmail']) info.email = kvMap['cursorAuth/cachedEmail'];
    if (kvMap['cursorAuth/stripeMembershipType']) info.membership = kvMap['cursorAuth/stripeMembershipType'];
    if (kvMap['cursorAuth/stripeSubscriptionStatus']) info.subscriptionStatus = kvMap['cursorAuth/stripeSubscriptionStatus'];
  } catch (e) {
    console.error('[pchat] Failed to parse Cursor auth info:', e);
  }

  return info;
}
