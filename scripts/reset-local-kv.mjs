/**
 * 重置本地调试数据
 * 把 .navbox-local/kv.json 恢复为空对象，下次启动 dev-server 时会重新注入默认数据，
 * 管理员账号也随之回到默认的 admin / admin123。
 *
 * 用法：node scripts/reset-local-kv.mjs   或   npm run mock:reset
 *
 * 说明：采用「写入空对象」而非删除文件的方式，避免误删；该文件已被 .gitignore 排除。
 * 线上数据不受影响——如需重置线上管理员密码，请到 EdgeOne 控制台 KV 数据管理中
 * 删除键 navbox_admin，系统会在下次请求时自动重建默认账号（书签数据不受影响）。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.navbox-local');
const DATA_FILE = join(DATA_DIR, 'kv.json');

if (!existsSync(DATA_DIR)) {
  await mkdir(DATA_DIR, { recursive: true });
}

await writeFile(DATA_FILE, '{}\n', 'utf8');

console.log('已重置本地调试数据：' + DATA_FILE);
console.log('下次启动 `npm run mock` 时会重新注入默认分组与示例书签。');
console.log('管理员账号恢复为：admin / admin123');
