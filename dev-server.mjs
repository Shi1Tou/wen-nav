/**
 * NavBox 本地调试服务器
 * 用途：在不部署到 EdgeOne 的情况下，用内存/文件模拟 KV，本地验证完整功能。
 *
 * 运行：  node dev-server.mjs
 * 访问：  http://localhost:8787
 *
 * 说明：
 *  - 仅用于本地开发调试，不要用于生产环境
 *  - KV 数据持久化到 ./.navbox-local/kv.json（已在 .gitignore 中排除）
 *  - 生产部署时由 EdgeOne 平台注入真实 KV，无需本文件
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, 'public');
const DATA_DIR = join(__dirname, '.navbox-local');
const DATA_FILE = join(DATA_DIR, 'kv.json');
const PORT = Number(process.env.PORT) || 8787;

// Edge Function 运行时依赖 Web Crypto；Node 18+ 通过 webcrypto 提供
if (!globalThis.crypto) globalThis.crypto = crypto;
if (!globalThis.btoa) globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');

/* ---------------- 模拟 KV ---------------- */
let store = {};
let saveTimer = null;

async function loadStore() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(DATA_FILE)) {
    try { store = JSON.parse(await readFile(DATA_FILE, 'utf8')) || {}; }
    catch (e) { console.warn('[dev] KV 数据文件解析失败，使用空存储：', e.message); store = {}; }
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8')
      .catch(e => console.error('[dev] 保存 KV 失败：', e.message));
  }, 150);
}

const mockKV = {
  async get(key, opts) {
    const v = store[key];
    if (v === undefined) return null;
    if (opts && opts.type === 'json') {
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return null; }
    }
    return typeof v === 'string' ? v : JSON.stringify(v);
  },
  async put(key, value) {
    store[key] = typeof value === 'string' ? value : JSON.stringify(value);
    persist();
  },
  async delete(key) { delete store[key]; persist(); },
  async list(opts) {
    const prefix = (opts && opts.prefix) || '';
    const limit = (opts && opts.limit) || 256;
    const keys = Object.keys(store).filter(k => k.startsWith(prefix)).sort().map(key => ({ key }));
    return { complete: true, cursor: null, keys: keys.slice(0, limit) };
  }
};

/* ---------------- 加载 Edge Function ---------------- */
const fnModulePath = join(__dirname, 'edge-functions', 'api', '[[default]].js');
let handler = null;

async function loadHandler() {
  try {
    const mod = await import('file://' + fnModulePath.replace(/\\/g, '/'));
    handler = mod.onRequest;
    if (typeof handler !== 'function') {
      console.error('[dev] 未找到 onRequest 导出');
      process.exit(1);
    }
    console.log('[dev] Edge Function 已加载：', fnModulePath);
  } catch (e) {
    console.error('[dev] 加载 Edge Function 失败：', e);
    process.exit(1);
  }
}

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = join(ROOT, rel);
  // 防止目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  try {
    let target = filePath;
    if (!existsSync(target)) {
      if (existsSync(join(target, 'index.html'))) target = join(target, 'index.html');
      else target = join(ROOT, 'index.html'); // SPA 兜底
    }
    const buf = await readFile(target);
    const ext = extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------------- 服务器 ---------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 收集请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  const headers = new Headers();
  Object.entries(req.headers).forEach(([k, v]) => {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  });

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody
  });

  if (pathname.startsWith('/api/')) {
    const context = {
      request,
      params: {},
      env: { NAV_KV: mockKV },   // 模拟控制台绑定的命名空间变量名
      waitUntil: p => { Promise.resolve(p).catch(e => console.error('[dev] waitUntil 任务失败：', e.message)); }
    };
    try {
      const response = await handler(context);
      const outHeaders = {};
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'set-cookie') return;
        outHeaders[k] = v;
      });

      // Set-Cookie 需要保留多条，单独收集为数组
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
      if (cookies.length) outHeaders['Set-Cookie'] = cookies;

      res.writeHead(response.status, outHeaders);
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e) {
      console.error('[dev] 函数执行异常：', e);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'DEV_SERVER_ERROR: ' + e.message }));
    }
    return;
  }

  serveStatic(pathname, res);
});

(async () => {
  await loadStore();
  await loadHandler();
  server.listen(PORT, () => {
    console.log('');
    console.log('  NavBox 本地调试服务器已启动');
    console.log('  ------------------------------------------');
    console.log(`  前台首页：  http://localhost:${PORT}`);
    console.log(`  健康检查：  http://localhost:${PORT}/api/health`);
    console.log(`  KV 数据：   ${DATA_FILE}`);
    console.log('');
    console.log('  默认账号：admin / admin123（登录后请立即修改密码）');
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });
})();

process.on('SIGINT', () => {
  console.log('\n[dev] 正在停止…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
});
