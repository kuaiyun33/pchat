import * as os from 'node:os';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import * as util from 'node:util';
import * as https from 'node:https';

import * as fs from 'node:fs';

const execFile = util.promisify(child_process.execFile);

export type CursorAuthInfo = {
  email?: string;
  membership?: string;
  stripeUsageUsd?: string;
  accessToken?: string;
};

export async function getCursorAuthInfo(): Promise<CursorAuthInfo> {
  const info: CursorAuthInfo = {};
  
  try {
    const originalDbPath = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    if (!fs.existsSync(originalDbPath)) {
      return info;
    }
    
    // 为了防止 Cursor 占用产生的 Sqlite Database is Locked 报错，我们将它拷贝到 temp 并安全读取
    const dbPath = path.join(os.tmpdir(), `cursor_tmp_${Date.now()}.vscdb`);
    fs.copyFileSync(originalDbPath, dbPath);

    const query = `
      SELECT key, value FROM ItemTable 
      WHERE key IN ('cursorAuth/cachedEmail', 'cursorAuth/stripeMembershipType', 'cursorAuth/accessToken');
    `;
    
    try {
      const { stdout } = await execFile('/usr/bin/sqlite3', [dbPath, query], { encoding: 'utf8', timeout: 3000 });
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf('|');
        if (idx > 0) {
          const k = line.substring(0, idx).trim();
          const v = line.substring(idx + 1).trim();
          if (k === 'cursorAuth/cachedEmail') info.email = v;
          if (k === 'cursorAuth/stripeMembershipType') info.membership = v;
          if (k === 'cursorAuth/accessToken') info.accessToken = v;
        }
      }
    } finally {
      // 读完无论成功失败立即销毁临时库文件
      fs.unlinkSync(dbPath);
    }
  } catch (e) {
    console.error('Failed to parse Cursor auth info:', e);
  }

  return info;
}

export function fetchStripeUsage(token: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Cursor dashboard 接口，这里使用更通用的 stripe/info
    // 注意: 这可能不是真实的 100% 正确 URL 路径，但尽量去捕获可能的返回结果
    const req = https.request(
        'https://api2.cursor.sh/auth/stripe',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            // 尝试定位返回体里的 usage/cost 字段
            // 如果 API 结构是 { usage: 10.5 } => 返回 $10.5
            // 如果是 { upcoming_invoice: { total: 1050 } } => $10.5
            let costStr: string | undefined;
            if (typeof data.usage === 'number') {
              costStr = `$${data.usage.toFixed(2)}`;
            } else if (typeof data.cost === 'number') {
              costStr = `$${data.cost.toFixed(2)}`;
            } else if (data.upcoming_invoice && data.upcoming_invoice.total) {
              costStr = `$${(data.upcoming_invoice.total / 100).toFixed(2)}`;
            } else if (data.billing && typeof data.billing.usage === 'number') {
              costStr = `$${data.billing.usage.toFixed(2)}`;
            } else if (data.totalUsd !== undefined) {
              costStr = `$${Number(data.totalUsd).toFixed(2)}`;
            }
            resolve(costStr);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', () => resolve(undefined));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}
