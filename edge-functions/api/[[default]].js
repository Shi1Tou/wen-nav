/**
 * NavBox 导航页 - EdgeOne Pages(Makers) Edge Functions API
 * 单文件自包含实现：路由分发 / 鉴权 / 书签与分组 / 设置 / 导入导出 / WebDAV 备份
 *
 * 平台约束（已按官方文档适配）：
 *  - KV 仅可在 Edge Functions 中使用，通过绑定的变量名访问
 *  - KV key 仅支持 数字/字母/下划线，长度 <= 512B
 *  - KV value <= 25MB；Edge Function 请求体 <= 1MB；单次 CPU <= 200ms
 *  - KV 为最终一致性，边缘缓存最长 60s
 */

const API_PREFIX = '/api/';
const COOKIE_NAME = 'navbox_token';
const SESSION_TTL = 7 * 24 * 3600; // 7 天
const PBKDF2_ITERATIONS = 60000;
const MAX_UPLOAD_BODY = 900 * 1024; // base64 背景图上限（受 1MB 请求体限制）
const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

/* ------------------------------------------------------------------ *
 * KV 命名空间解析
 * ------------------------------------------------------------------ */

/**
 * 兼容不同的绑定变量名：优先 NAV_KV，其次扫描 env 中任何具备 KV 接口的对象。
 * 这样无论用户在控制台把命名空间绑定成什么变量名都能工作。
 */
function resolveKV(env) {
  if (!env) return null;
  const preferred = ['NAV_KV', 'NAVBOX_KV', 'BOOKMARK_KV', 'my_kv', 'KV'];
  for (const name of preferred) {
    const ns = env[name];
    if (ns && typeof ns.get === 'function' && typeof ns.put === 'function') return ns;
  }
  for (const key of Object.keys(env)) {
    const ns = env[key];
    if (ns && typeof ns.get === 'function' && typeof ns.put === 'function'
        && typeof ns.delete === 'function' && typeof ns.list === 'function') {
      return ns;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * KV 键名（仅使用字母/数字/下划线）
 * ------------------------------------------------------------------ */

const K = {
  settings: 'navbox_settings',
  groups: 'navbox_groups',
  links: 'navbox_links',
  admin: 'navbox_admin',
  secret: 'navbox_secret',
  background: 'navbox_background',
  webdav: 'navbox_webdav',
  backupLog: 'navbox_backup_log',
  loginFail: 'navbox_login_fail',
  cronToken: 'navbox_cron_token',
  meta: 'navbox_meta'
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + randomHex(4);
}

/** 常数时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJSON(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object' && !(raw instanceof ArrayBuffer)) return raw;
    return JSON.parse(typeof raw === 'string' ? raw : dec.decode(raw));
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function err(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

function cookieHeader(value, maxAge, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  // 线上 https 加 Secure；本地 http 调试时省略，否则浏览器不会保存 Cookie
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 判断当前请求是否为安全上下文（https），用于决定是否给 Cookie 加 Secure */
function isSecureRequest(request) {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch (e) { /* 忽略解析失败 */ }
  const fwd = (request.headers.get('X-Forwarded-Proto') || '').toLowerCase();
  return fwd.split(',')[0].trim() === 'https';
}

/* ------------------------------------------------------------------ *
 * 加密：口令哈希 + 会话令牌
 * ------------------------------------------------------------------ */

async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    baseKey,
    256
  );
  return bytesToHex(bits);
}

async function getSecret(kv) {
  let secret = await kv.get(K.secret);
  if (typeof secret !== 'string' || secret.length < 32) {
    secret = randomHex(32);
    await kv.put(K.secret, secret);
  }
  return hexToBytes(secret);
}

async function signToken(payload, secretBytes) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, secretBytes) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
  } catch (e) {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(body)));
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 默认数据
 * ------------------------------------------------------------------ */

function defaultSettings() {
  return {
    siteTitle: 'NavBox 导航',
    siteSubtitle: '简洁、快速、可自定义的个人网址导航',
    background: {
      type: 'gradient',      // gradient | url | upload
      url: '',               // 图床直链
      blur: 0,               // px
      brightness: 100,       // %
      overlay: 30,           // 遮罩不透明度 %
      gradient: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)'
    },
    card: {
      opacity: 82,           // 卡片背景不透明度 %
      bgColor: '#ffffff',    // 卡片背景色
      blur: 12,              // 毛玻璃强度 px
      radius: 14,            // 圆角 px
      textColor: '#1f2430',
      hoverScale: true
    },
    layout: {
      minCardWidth: 168,     // 桌面端卡片最小宽度
      showDesc: true,
      showGroupIcon: true,
      denseMobile: false
    },
    favicon: {
      provider: 'favicon.im' // favicon.im | icon.horse | google | direct | custom
    },
    search: {
      enabled: true,
      placeholder: '搜索书签名称、网址或描述…',
      openInNewTab: true
    },
    footer: 'Powered by NavBox · Deployed on EdgeOne Pages',
    privateBadge: true,
    theme: 'auto',
    updatedAt: nowIso()
  };
}

function defaultGroups() {
  return [
    { id: 'grp_common', name: '常用', icon: '⭐', order: 1, collapsed: false },
    { id: 'grp_dev', name: '开发工具', icon: '🛠️', order: 2, collapsed: false },
    { id: 'grp_media', name: '影音娱乐', icon: '🎬', order: 3, collapsed: false }
  ];
}

function defaultLinks() {
  const seed = [
    ['常用', 'GitHub', 'https://github.com', '全球最大代码托管平台', 'public'],
    ['常用', 'EdgeOne Pages', 'https://pages.edgeone.ai', '边缘全栈部署平台', 'public'],
    ['常用', '腾讯云控制台', 'https://console.cloud.tencent.com', '云资源管理', 'public'],
    ['开发工具', 'MDN Web Docs', 'https://developer.mozilla.org', 'Web 技术权威文档', 'public'],
    ['开发工具', 'Can I use', 'https://caniuse.com', '浏览器兼容性查询', 'public'],
    ['开发工具', 'Regex101', 'https://regex101.com', '正则表达式调试', 'public'],
    ['影音娱乐', 'YouTube', 'https://www.youtube.com', '视频平台', 'public'],
    ['影音娱乐', '哔哩哔哩', 'https://www.bilibili.com', '国内视频社区', 'public'],
    ['影音娱乐', '内网监控面板', 'https://monitor.internal.example.com', '仅自己可见的示例私密书签', 'private']
  ];
  const groups = defaultGroups();
  const nameToId = {};
  groups.forEach(g => { nameToId[g.name] = g.id; });
  let order = 1;
  return seed.map(([gname, title, url, desc, visibility]) => ({
    id: uid('lnk'),
    groupId: nameToId[gname] || groups[0].id,
    title,
    url,
    desc,
    icon: '',
    iconType: 'auto', // auto | custom | text
    visibility,
    order: order++,
    clicks: 0,
    createdAt: nowIso()
  }));
}

async function ensureAdmin(kv) {
  let admin = await readJSON(kv, K.admin, null);
  if (admin && admin.salt && admin.hash) return admin;
  const salt = randomHex(16);
  admin = {
    username: DEFAULT_ADMIN.username,
    salt,
    hash: await hashPassword(DEFAULT_ADMIN.password, salt),
    tokenVersion: 1,
    isDefault: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await writeJSON(kv, K.admin, admin);
  return admin;
}

async function ensureSeed(kv) {
  const meta = await readJSON(kv, K.meta, null);
  if (meta && meta.seeded) return;
  const [settings, groups, links] = await Promise.all([
    readJSON(kv, K.settings, null),
    readJSON(kv, K.groups, null),
    readJSON(kv, K.links, null)
  ]);
  if (!settings) await writeJSON(kv, K.settings, defaultSettings());
  if (!groups || !Array.isArray(groups) || groups.length === 0) await writeJSON(kv, K.groups, defaultGroups());
  if (!links || !Array.isArray(links) || links.length === 0) await writeJSON(kv, K.links, defaultLinks());
  await writeJSON(kv, K.meta, { seeded: true, seededAt: nowIso() });
}

/* ------------------------------------------------------------------ *
 * 数据访问
 * ------------------------------------------------------------------ */

function sortGroups(groups) {
  return (groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

function sortLinks(links) {
  return (links || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

function publicView(link) {
  return {
    id: link.id,
    groupId: link.groupId,
    title: link.title,
    url: link.url,
    desc: link.desc || '',
    icon: link.icon || '',
    iconType: link.iconType || 'auto',
    visibility: link.visibility === 'private' ? 'private' : 'public',
    order: link.order || 0,
    clicks: link.clicks || 0
  };
}

function normalizeLink(input, fallback = {}) {
  const url = String(input.url || fallback.url || '').trim();
  let finalUrl = url;
  if (finalUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl;
  }
  return {
    id: input.id || fallback.id || uid('lnk'),
    groupId: input.groupId || fallback.groupId || '',
    title: String(input.title || fallback.title || finalUrl || '未命名').slice(0, 80),
    url: finalUrl.slice(0, 2000),
    desc: String(input.desc !== undefined ? input.desc : (fallback.desc || '')).slice(0, 300),
    icon: String(input.icon !== undefined ? input.icon : (fallback.icon || '')).slice(0, 5000),
    iconType: ['auto', 'custom', 'text'].includes(input.iconType) ? input.iconType : (fallback.iconType || 'auto'),
    visibility: input.visibility === 'private' ? 'private' : 'public',
    order: Number.isFinite(+input.order) ? +input.order : (fallback.order || 0),
    clicks: Number.isFinite(+fallback.clicks) ? +fallback.clicks : 0,
    createdAt: fallback.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function normalizeGroup(input, fallback = {}) {
  return {
    id: input.id || fallback.id || uid('grp'),
    name: String(input.name || fallback.name || '新分组').slice(0, 40),
    icon: String(input.icon !== undefined ? input.icon : (fallback.icon || '')).slice(0, 16),
    order: Number.isFinite(+input.order) ? +input.order : (fallback.order || 0),
    collapsed: !!(input.collapsed !== undefined ? input.collapsed : fallback.collapsed)
  };
}

/* ------------------------------------------------------------------ *
 * 鉴权中间逻辑
 * ------------------------------------------------------------------ */

async function getAuth(request, kv) {
  const admin = await readJSON(kv, K.admin, null);
  if (!admin) return { admin: false };
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return { admin: false };
  const secretBytes = await getSecret(kv);
  const payload = await verifyToken(token, secretBytes);
  if (!payload) return { admin: false };
  if (payload.v !== admin.tokenVersion) return { admin: false };
  return { admin: true, username: admin.username };
}

/** 登录失败限流：5 次失败锁定 10 分钟 */
async function checkLoginThrottle(kv, ip) {
  const all = await readJSON(kv, K.loginFail, {}) || {};
  const rec = all[ip];
  if (!rec) return { blocked: false };
  if (rec.lockUntil && rec.lockUntil > Date.now()) {
    return { blocked: true, retryAfter: Math.ceil((rec.lockUntil - Date.now()) / 1000) };
  }
  return { blocked: false };
}

async function recordLoginFail(kv, ip, success) {
  const all = (await readJSON(kv, K.loginFail, {})) || {};
  if (success) {
    delete all[ip];
  } else {
    const rec = all[ip] || { count: 0, lockUntil: 0 };
    rec.count += 1;
    rec.at = Date.now();
    if (rec.count >= 5) {
      rec.lockUntil = Date.now() + 10 * 60 * 1000;
      rec.count = 0;
    }
    all[ip] = rec;
  }
  // 清理过期条目，避免无限增长
  for (const key of Object.keys(all)) {
    const r = all[key];
    if (r && r.at && Date.now() - r.at > 3600 * 1000 && !(r.lockUntil > Date.now())) delete all[key];
  }
  await writeJSON(kv, K.loginFail, all);
}

/* ------------------------------------------------------------------ *
 * WebDAV
 * ------------------------------------------------------------------ */

function webdavAuthHeader(cfg) {
  const user = cfg.username || '';
  const pass = cfg.password || '';
  return 'Basic ' + btoa(`${user}:${pass}`);
}

function joinWebdavPath(base, name) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  return `${cleanBase}/${name}`;
}

async function webdavRequest(cfg, method, fullPath, body, headers = {}) {
  const res = await fetch(fullPath, {
    method,
    headers: {
      Authorization: webdavAuthHeader(cfg),
      ...headers
    },
    body
  });
  return res;
}

async function buildBackupPayload(kv) {
  const [settings, groups, links, background, webdav] = await Promise.all([
    readJSON(kv, K.settings, defaultSettings()),
    readJSON(kv, K.groups, []),
    readJSON(kv, K.links, []),
    readJSON(kv, K.background, null),
    readJSON(kv, K.webdav, null)
  ]);
  return {
    app: 'NavBox',
    version: 1,
    exportedAt: nowIso(),
    settings,
    groups,
    links,
    background: background || null,
    // 备份中包含 WebDAV 地址但不含密码，避免备份文件泄露凭据
    webdav: webdav ? {
      url: webdav.url, path: webdav.path, username: webdav.username,
      autoBackup: webdav.autoBackup, intervalHours: webdav.intervalHours, keep: webdav.keep
    } : null
  };
}

async function pushBackupLog(kv, entry) {
  const log = (await readJSON(kv, K.backupLog, [])) || [];
  log.unshift(entry);
  await writeJSON(kv, K.backupLog, log.slice(0, 30));
}

async function runBackup(kv, trigger) {
  const cfg = await readJSON(kv, K.webdav, null);
  if (!cfg || !cfg.url) {
    const entry = { at: nowIso(), trigger, ok: false, error: '未配置 WebDAV 服务器地址' };
    await pushBackupLog(kv, entry);
    return entry;
  }
  try {
    const payload = await buildBackupPayload(kv);
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = cfg.path || '/navbox-backup';

    // 确保目录存在（失败不阻断，部分服务器已存在会返回 405）
    try {
      await webdavRequest(cfg, 'MKCOL', joinWebdavPath(cfg.url, dir.replace(/\/+$/, '')));
    } catch (e) { /* 忽略 */ }

    const target = joinWebdavPath(cfg.url, `${dir.replace(/\/+$/, '')}/navbox-${stamp}.json`);
    const latest = joinWebdavPath(cfg.url, `${dir.replace(/\/+$/, '')}/navbox-latest.json`);

    const putHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
    const r1 = await webdavRequest(cfg, 'PUT', target, text, putHeaders);
    if (!r1.ok && r1.status !== 201 && r1.status !== 204) {
      const body = await r1.text().catch(() => '');
      const entry = {
        at: nowIso(), trigger, ok: false,
        error: `上传失败 HTTP ${r1.status}`, detail: body.slice(0, 300), target
      };
      await pushBackupLog(kv, entry);
      return entry;
    }
    await webdavRequest(cfg, 'PUT', latest, text, putHeaders).catch(() => null);

    const entry = {
      at: nowIso(), trigger, ok: true, target,
      bytes: text.length,
      groups: (payload.groups || []).length,
      links: (payload.links || []).length
    };

    // 更新最近备份时间
    await writeJSON(kv, K.webdav, { ...cfg, lastBackupAt: entry.at, lastBackupTarget: target });
    await pushBackupLog(kv, entry);

    // 按保留份数清理（等待完成，避免函数返回后任务被终止；失败不影响备份结果）
    const keep = Number(cfg.keep) > 0 ? Number(cfg.keep) : 10;
    try {
      await cleanupOldBackups(kv, cfg, dir, keep);
    } catch (e) { /* 清理失败不影响备份成功状态 */ }

    return entry;
  } catch (e) {
    const entry = { at: nowIso(), trigger, ok: false, error: String(e && e.message || e).slice(0, 300) };
    await pushBackupLog(kv, entry);
    return entry;
  }
}

async function cleanupOldBackups(kv, cfg, dir, keep) {
  try {
    const url = joinWebdavPath(cfg.url, dir.replace(/\/+$/, ''));
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: webdavAuthHeader(cfg),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>'
    });
    if (!res.ok) return;
    const xml = await res.text();
    const hrefs = [];
    const re = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) hrefs.push(m[1].trim());
    const files = hrefs
      .filter(h => /navbox-[\d\-T]+\.json$/i.test(h) && !/navbox-latest\.json$/i.test(h))
      .sort();
    if (files.length <= keep) return;
    const victims = files.slice(0, files.length - keep);
    for (const v of victims.slice(0, 5)) {
      const full = /^https?:\/\//i.test(v) ? v : joinWebdavPath(cfg.url, v);
      await webdavRequest(cfg, 'DELETE', full).catch(() => null);
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
}

async function restoreFromWebdav(kv, targetHref) {
  const cfg = await readJSON(kv, K.webdav, null);
  if (!cfg || !cfg.url) throw new Error('未配置 WebDAV');
  const url = targetHref
    ? (/^https?:\/\//i.test(targetHref) ? targetHref : joinWebdavPath(cfg.url, targetHref))
    : joinWebdavPath(cfg.url, `${(cfg.path || '/navbox-backup').replace(/\/+$/, '')}/navbox-latest.json`);
  const res = await fetch(url, { headers: { Authorization: webdavAuthHeader(cfg) } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text);
  return applyImport(kv, data, 'replace');
}

async function listWebdavBackups(kv) {
  const cfg = await readJSON(kv, K.webdav, null);
  if (!cfg || !cfg.url) return [];
  const dir = (cfg.path || '/navbox-backup').replace(/\/+$/, '');
  const res = await fetch(joinWebdavPath(cfg.url, dir), {
    method: 'PROPFIND',
    headers: {
      Authorization: webdavAuthHeader(cfg),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/><D:getcontentlength/></D:prop></D:propfind>'
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const xml = await res.text();
  const out = [];
  const resRe = /<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let rm;
  while ((rm = resRe.exec(xml)) !== null) {
    const block = rm[1];
    const hm = block.match(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/i);
    if (!hm) continue;
    const href = hm[1].trim();
    if (!/\.json$/i.test(href)) continue;
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || href);
    const lm = block.match(/<(?:\w+:)?getlastmodified[^>]*>([^<]+)</i);
    const sm = block.match(/<(?:\w+:)?getcontentlength[^>]*>([^<]+)</i);
    out.push({
      href,
      name,
      isLatest: /navbox-latest\.json$/i.test(name),
      modified: lm ? lm[1].trim() : '',
      size: sm ? Number(sm[1]) : 0
    });
  }
  return out.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
}

/** 流量驱动的自动备份：无请求时不触发，最小间隔受 intervalHours 控制 */
async function maybeAutoBackup(kv, waitUntil) {
  try {
    const cfg = await readJSON(kv, K.webdav, null);
    if (!cfg || !cfg.url || !cfg.autoBackup) return;
    const intervalMs = Math.max(1, Number(cfg.intervalHours) || 24) * 3600 * 1000;
    const last = cfg.lastBackupAt ? Date.parse(cfg.lastBackupAt) : 0;
    if (last && Date.now() - last < intervalMs) return;
    const task = runBackup(kv, 'auto');
    if (typeof waitUntil === 'function') waitUntil(task);
    else await task;
  } catch (e) { /* 静默失败，不影响主请求 */ }
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

/** 解析 Netscape Bookmark HTML */
function parseBookmarkHtml(html) {
  const groups = [];
  const links = [];
  const groupNameSet = new Set();
  // <H3 ...>分组名</H3> 之后紧跟的 <DL><p> 内的 A 标签属于该分组
  const h3Re = /<H3[^>]*>([\s\S]*?)<\/H3>|<A\s+([^>]*)>([\s\S]*?)<\/A>/gi;
  let currentGroup = '导入分组';
  let m;
  const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
  const attr = (attrs, name) => {
    const r = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
    return r ? r[1] : '';
  };
  while ((m = h3Re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const name = stripTags(m[1]) || '导入分组';
      currentGroup = name;
      if (!groupNameSet.has(name)) {
        groupNameSet.add(name);
        groups.push({ id: uid('grp'), name: name.slice(0, 40), icon: '', order: groups.length + 1, collapsed: false });
      }
    } else if (m[2] !== undefined) {
      const attrs = m[2];
      const href = attr(attrs, 'HREF');
      if (!href || /^(javascript|data|file):/i.test(href)) continue;
      const title = stripTags(m[3] || '') || href;
      const icon = attr(attrs, 'ICON');
      const privateFlag = attr(attrs, 'PRIVATE');
      const g = groups.find(x => x.name === currentGroup) || groups[0];
      links.push({
        id: uid('lnk'),
        groupId: g ? g.id : '',
        title: title.slice(0, 80),
        url: href.slice(0, 2000),
        desc: '',
        icon: icon ? icon.slice(0, 5000) : '',
        iconType: icon ? 'custom' : 'auto',
        visibility: privateFlag === '1' ? 'private' : 'public',
        order: links.length + 1,
        clicks: 0,
        createdAt: nowIso()
      });
    }
  }
  if (groups.length === 0) {
    groups.push({ id: uid('grp'), name: '导入分组', icon: '', order: 1, collapsed: false });
  }
  return { groups, links };
}

async function applyImport(kv, data, mode) {
  if (!data || typeof data !== 'object') throw new Error('导入数据格式不正确');

  // JSON 备份格式
  if (Array.isArray(data.links) || Array.isArray(data.groups)) {
    const inGroups = Array.isArray(data.groups) ? data.groups : [];
    const inLinks = Array.isArray(data.links) ? data.links : [];

    if (mode === 'replace') {
      const groups = inGroups.map((g, i) => normalizeGroup({ ...g, order: i + 1 }));
      const links = inLinks.map((l, i) => normalizeLink({ ...l, order: i + 1 }, {}));
      await writeJSON(kv, K.groups, groups);
      await writeJSON(kv, K.links, links);
      if (data.settings && typeof data.settings === 'object') {
        const merged = { ...defaultSettings(), ...data.settings };
        merged.updatedAt = nowIso();
        await writeJSON(kv, K.settings, merged);
      }
      if (data.background !== undefined) {
        if (data.background) await kv.put(K.background, JSON.stringify(data.background));
        else await kv.delete(K.background).catch(() => null);
      }
      return { mode: 'replace', groups: groups.length, links: links.length };
    }

    // merge：按 URL 去重追加
    const curGroups = (await readJSON(kv, K.groups, [])) || [];
    const curLinks = (await readJSON(kv, K.links, [])) || [];
    const idMap = {};
    let gOrder = curGroups.reduce((mx, g) => Math.max(mx, g.order || 0), 0);
    inGroups.forEach(g => {
      const exist = curGroups.find(x => x.name === g.name);
      if (exist) { idMap[g.id] = exist.id; return; }
      const ng = normalizeGroup({ ...g, order: ++gOrder });
      curGroups.push(ng);
      idMap[g.id] = ng.id;
    });
    const urlSet = new Set(curLinks.map(l => l.url));
    let lOrder = curLinks.reduce((mx, l) => Math.max(mx, l.order || 0), 0);
    let added = 0, skipped = 0;
    inLinks.forEach(l => {
      const nl = normalizeLink({ ...l, groupId: idMap[l.groupId] || l.groupId, order: ++lOrder }, {});
      if (!nl.groupId && curGroups[0]) nl.groupId = curGroups[0].id;
      if (urlSet.has(nl.url)) { skipped++; return; }
      urlSet.add(nl.url);
      curLinks.push(nl);
      added++;
    });
    await writeJSON(kv, K.groups, curGroups);
    await writeJSON(kv, K.links, curLinks);
    return { mode: 'merge', added, skipped, groups: curGroups.length, links: curLinks.length };
  }

  // HTML 书签格式
  if (typeof data.html === 'string') {
    const parsed = parseBookmarkHtml(data.html);
    if (parsed.links.length === 0) {
      throw new Error('未在导入内容中识别到任何书签条目。请确认内容为浏览器书签 HTML（含 <A HREF="..."> 条目）或本项目导出的 JSON');
    }
    return applyImport(kv, { groups: parsed.groups, links: parsed.links }, mode);
  }

  throw new Error('无法识别的导入内容，请使用本项目导出的 JSON 或浏览器书签 HTML');
}

function buildBookmarkHtml(groups, links, settings) {
  const sortedGroups = sortGroups(groups);
  const sortedLinks = sortLinks(links);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let body = '';
  sortedGroups.forEach(g => {
    const items = sortedLinks.filter(l => l.groupId === g.id);
    if (items.length === 0) return;
    body += `    <DT><H3>${esc(g.name)}</H3>\n    <DL><p>\n`;
    items.forEach(l => {
      const attrs = [`HREF="${esc(l.url)}"`];
      if (l.icon) attrs.push(`ICON="${esc(l.icon)}"`);
      if (l.visibility === 'private') attrs.push('PRIVATE="1"');
      if (l.desc) attrs.push(`DESCRIPTION="${esc(l.desc)}"`);
      body += `        <DT><A ${attrs.join(' ')}>${esc(l.title)}</A>\n`;
    });
    body += `    </DL><p>\n`;
  });
  const orphan = sortedLinks.filter(l => !sortedGroups.some(g => g.id === l.groupId));
  if (orphan.length) {
    body += `    <DT><H3>未分组</H3>\n    <DL><p>\n`;
    orphan.forEach(l => {
      body += `        <DT><A HREF="${esc(l.url)}"${l.visibility === 'private' ? ' PRIVATE="1"' : ''}>${esc(l.title)}</A>\n`;
    });
    body += `    </DL><p>\n`;
  }
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- NavBox 导出 - ${esc(settings && settings.siteTitle || 'NavBox')} - ${new Date().toISOString()} -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}</DL><p>
`;
}

/* ------------------------------------------------------------------ *
 * 请求体解析（受平台 1MB 限制，显式给出友好错误）
 * ------------------------------------------------------------------ */

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 1024 * 1024) {
    throw new Error('BODY_TOO_LARGE');
  }
  const text = await request.text();
  if (text.length > 1024 * 1024 + 1024) {
    throw new Error('BODY_TOO_LARGE');
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('INVALID_JSON');
  }
}

/* ------------------------------------------------------------------ *
 * 导出为 HTML 下载
 * ------------------------------------------------------------------ */

function htmlResponse(text, filename) {
  return new Response(text, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

/* ------------------------------------------------------------------ *
 * 路由处理
 * ------------------------------------------------------------------ */

async function handle(path, method, request, context) {
  const { env, waitUntil } = context;
  const kv = resolveKV(env);

  const corsOrigin = request.headers.get('Origin');
  const corsHeaders = {};
  if (corsOrigin) {
    corsHeaders['Access-Control-Allow-Origin'] = corsOrigin;
    corsHeaders['Access-Control-Allow-Credentials'] = 'true';
    corsHeaders['Vary'] = 'Origin';
  }

  if (!kv) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'KV_NOT_BOUND',
      message: '未检测到已绑定的 KV 命名空间。请在 EdgeOne(Makers) 控制台 → 项目 → KV 存储 → 绑定命名空间，变量名建议填写 NAV_KV。'
    }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders } });
  }

  // 预检
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Cron-Token',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const route = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const withCors = res => {
    Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  try {
    switch (route) {

      /* ---------------- 健康检查 ---------------- */
      case 'api/health': {
        await ensureSeed(kv);
        const admin = await readJSON(kv, K.admin, null);
        return withCors(json({
          ok: true, kv: true, time: nowIso(),
          adminInitialized: !!(admin && admin.hash),
          usingDefaultPassword: !!(admin && admin.isDefault)
        }));
      }

      /* ---------------- 前台初始化数据 ---------------- */
      case 'api/bootstrap': {
        await ensureSeed(kv);
        await ensureAdmin(kv);
        const auth = await getAuth(request, kv);
        const [settings, groups, links, background] = await Promise.all([
          readJSON(kv, K.settings, defaultSettings()),
          readJSON(kv, K.groups, []),
          readJSON(kv, K.links, []),
          readJSON(kv, K.background, null)
        ]);
        const visible = auth.admin ? links : links.filter(l => l.visibility !== 'private');
        if (typeof waitUntil === 'function') waitUntil(maybeAutoBackup(kv, waitUntil));
        return withCors(json({
          ok: true,
          isAdmin: auth.admin,
          username: auth.username || null,
          settings: { ...defaultSettings(), ...settings },
          groups: sortGroups(groups),
          links: sortLinks(visible).map(publicView),
          background: background || null,
          totalLinks: links.length,
          serverTime: nowIso()
        }));
      }

      /* ---------------- 登录 / 登出 / 状态 ---------------- */
      case 'api/auth/login': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const ip = (request.headers.get('CF-Connecting-IP')
          || request.headers.get('X-Forwarded-For') || 'unknown').split(',')[0].trim();
        const throttle = await checkLoginThrottle(kv, ip);
        if (throttle.blocked) {
          return withCors(err(`登录失败次数过多，请在 ${throttle.retryAfter} 秒后重试`, 429,
            { retryAfter: throttle.retryAfter }));
        }
        const body = await readBody(request);
        const admin = await ensureAdmin(kv);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const candidate = await hashPassword(password, admin.salt);
        const okUser = safeEqual(username, admin.username);
        const okPass = safeEqual(candidate, admin.hash);
        if (!okUser || !okPass) {
          await recordLoginFail(kv, ip, false);
          return withCors(err('用户名或密码错误', 401));
        }
        await recordLoginFail(kv, ip, true);
        const secretBytes = await getSecret(kv);
        const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
        const token = await signToken({ u: admin.username, v: admin.tokenVersion, exp }, secretBytes);
        const res = json({ ok: true, username: admin.username, expiresAt: new Date(exp * 1000).toISOString() });
        res.headers.append('Set-Cookie', cookieHeader(token, SESSION_TTL, isSecureRequest(request)));
        return withCors(res);
      }

      case 'api/auth/logout': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const res = json({ ok: true });
        res.headers.append('Set-Cookie', cookieHeader('', 0, isSecureRequest(request)));
        return withCors(res);
      }

      case 'api/auth/check': {
        const admin = await ensureAdmin(kv);
        const auth = await getAuth(request, kv);
        return withCors(json({
          ok: true, isAdmin: auth.admin, username: auth.username || null,
          isDefault: !!admin.isDefault
        }));
      }

      /* ---------------- 修改管理员名称与密码 ---------------- */
      case 'api/auth/account': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        const admin = await ensureAdmin(kv);

        // 校验当前密码
        const curHash = await hashPassword(String(body.currentPassword || ''), admin.salt);
        if (!safeEqual(curHash, admin.hash)) return withCors(err('当前密码不正确', 403));

        const next = { ...admin };
        const newUsername = String(body.newUsername || '').trim();
        if (newUsername) {
          if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(newUsername)) {
            return withCors(err('用户名仅支持 2-32 位字母、数字及 _ . @ - 字符', 400));
          }
          next.username = newUsername;
        }
        const newPassword = String(body.newPassword || '');
        if (newPassword) {
          if (newPassword.length < 8) return withCors(err('新密码至少 8 位', 400));
          if (newPassword.length > 128) return withCors(err('新密码最长 128 位', 400));
          next.salt = randomHex(16);
          next.hash = await hashPassword(newPassword, next.salt);
          next.isDefault = false;
          next.tokenVersion = (admin.tokenVersion || 1) + 1; // 使所有旧会话失效
        }
        next.updatedAt = nowIso();
        await writeJSON(kv, K.admin, next);

        // 如果密码变更，重新签发当前会话
        const res = json({ ok: true, username: next.username, passwordChanged: !!newPassword });
        if (newPassword) {
          const secretBytes = await getSecret(kv);
          const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
          const token = await signToken({ u: next.username, v: next.tokenVersion, exp }, secretBytes);
          res.headers.append('Set-Cookie', cookieHeader(token, SESSION_TTL, isSecureRequest(request)));
        }
        return withCors(res);
      }

      /* ---------------- 管理端：完整数据 ---------------- */
      case 'api/admin/data': {
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        await ensureSeed(kv);
        const [settings, groups, links, background, webdav, log, admin] = await Promise.all([
          readJSON(kv, K.settings, defaultSettings()),
          readJSON(kv, K.groups, []),
          readJSON(kv, K.links, []),
          readJSON(kv, K.background, null),
          readJSON(kv, K.webdav, null),
          readJSON(kv, K.backupLog, []),
          ensureAdmin(kv)
        ]);
        return withCors(json({
          ok: true,
          settings: { ...defaultSettings(), ...settings },
          groups: sortGroups(groups),
          links: sortLinks(links),
          background: background || null,
          webdav: webdav ? {
            url: webdav.url, path: webdav.path, username: webdav.username,
            passwordSet: !!webdav.password, autoBackup: !!webdav.autoBackup,
            intervalHours: webdav.intervalHours || 24, keep: webdav.keep || 10,
            lastBackupAt: webdav.lastBackupAt || null, lastBackupTarget: webdav.lastBackupTarget || null
          } : null,
          backupLog: log || [],
          account: { username: admin.username, isDefault: !!admin.isDefault, updatedAt: admin.updatedAt || null }
        }));
      }

      /* ---------------- 管理端：书签增删改 ---------------- */
      case 'api/admin/link': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        const action = body.action;
        let links = (await readJSON(kv, K.links, [])) || [];

        if (action === 'create') {
          if (!body.link || !body.link.url) return withCors(err('缺少链接地址', 400));
          const maxOrder = links.reduce((mx, l) => Math.max(mx, l.order || 0), 0);
          const nl = normalizeLink({ ...body.link, order: maxOrder + 1 });
          links.push(nl);
          await writeJSON(kv, K.links, links);
          return withCors(json({ ok: true, link: nl }));
        }
        if (action === 'update') {
          const idx = links.findIndex(l => l.id === body.id);
          if (idx < 0) return withCors(err('书签不存在', 404));
          links[idx] = normalizeLink(body.link || {}, links[idx]);
          await writeJSON(kv, K.links, links);
          return withCors(json({ ok: true, link: links[idx] }));
        }
        if (action === 'delete') {
          const ids = Array.isArray(body.ids) ? body.ids : [body.id];
          const before = links.length;
          links = links.filter(l => !ids.includes(l.id));
          await writeJSON(kv, K.links, links);
          return withCors(json({ ok: true, deleted: before - links.length }));
        }
        if (action === 'reorder') {
          // body.orders: [{id, order, groupId}]
          const orders = Array.isArray(body.orders) ? body.orders : [];
          const map = {};
          orders.forEach(o => { map[o.id] = o; });
          links = links.map(l => map[l.id]
            ? { ...l, order: Number(map[l.id].order) || 0, groupId: map[l.id].groupId || l.groupId }
            : l);
          await writeJSON(kv, K.links, links);
          return withCors(json({ ok: true, links: sortLinks(links) }));
        }
        return withCors(err('未知操作', 400));
      }

      /* ---------------- 管理端：分组增删改与排序 ---------------- */
      case 'api/admin/group': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        const action = body.action;
        let groups = (await readJSON(kv, K.groups, [])) || [];

        if (action === 'create') {
          const maxOrder = groups.reduce((mx, g) => Math.max(mx, g.order || 0), 0);
          const ng = normalizeGroup({ ...body.group, order: maxOrder + 1 });
          groups.push(ng);
          await writeJSON(kv, K.groups, groups);
          return withCors(json({ ok: true, group: ng }));
        }
        if (action === 'update') {
          const idx = groups.findIndex(g => g.id === body.id);
          if (idx < 0) return withCors(err('分组不存在', 404));
          groups[idx] = normalizeGroup(body.group || {}, groups[idx]);
          await writeJSON(kv, K.groups, groups);
          return withCors(json({ ok: true, group: groups[idx] }));
        }
        if (action === 'delete') {
          const gid = body.id;
          const links = (await readJSON(kv, K.links, [])) || [];
          const affected = links.filter(l => l.groupId === gid).length;
          if (affected > 0 && !body.force) {
            return withCors(err(`该分组下还有 ${affected} 个书签，请确认是否一并删除`, 409, { affected }));
          }
          groups = groups.filter(g => g.id !== gid);
          await writeJSON(kv, K.groups, groups);
          if (body.force) {
            await writeJSON(kv, K.links, links.filter(l => l.groupId !== gid));
          }
          return withCors(json({ ok: true, deletedLinks: body.force ? affected : 0 }));
        }
        if (action === 'reorder') {
          const orders = Array.isArray(body.orders) ? body.orders : [];
          const map = {};
          orders.forEach(o => { map[o.id] = o.order; });
          groups = groups.map(g => map[g.id] !== undefined ? { ...g, order: Number(map[g.id]) || 0 } : g);
          await writeJSON(kv, K.groups, groups);
          return withCors(json({ ok: true, groups: sortGroups(groups) }));
        }
        return withCors(err('未知操作', 400));
      }

      /* ---------------- 管理端：站点设置 ---------------- */
      case 'api/admin/settings': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        const cur = await readJSON(kv, K.settings, defaultSettings());
        const merged = { ...defaultSettings(), ...cur };
        const s = body.settings || {};

        if (s.siteTitle !== undefined) merged.siteTitle = String(s.siteTitle).slice(0, 60);
        if (s.siteSubtitle !== undefined) merged.siteSubtitle = String(s.siteSubtitle).slice(0, 160);
        if (s.footer !== undefined) merged.footer = String(s.footer).slice(0, 200);
        if (s.theme !== undefined) merged.theme = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
        if (s.privateBadge !== undefined) merged.privateBadge = !!s.privateBadge;

        const num = (v, min, max, dflt) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return dflt;
          return Math.min(max, Math.max(min, n));
        };
        if (s.background) {
          merged.background = {
            ...merged.background,
            type: ['gradient', 'url', 'upload'].includes(s.background.type) ? s.background.type : merged.background.type,
            url: String(s.background.url || '').slice(0, 2000),
            blur: num(s.background.blur, 0, 40, merged.background.blur),
            brightness: num(s.background.brightness, 20, 200, merged.background.brightness),
            overlay: num(s.background.overlay, 0, 95, merged.background.overlay),
            gradient: String(s.background.gradient || merged.background.gradient).slice(0, 300)
          };
        }
        if (s.card) {
          merged.card = {
            ...merged.card,
            opacity: num(s.card.opacity, 0, 100, merged.card.opacity),
            bgColor: String(s.card.bgColor || merged.card.bgColor).slice(0, 32),
            blur: num(s.card.blur, 0, 40, merged.card.blur),
            radius: num(s.card.radius, 0, 40, merged.card.radius),
            textColor: String(s.card.textColor || merged.card.textColor).slice(0, 32),
            hoverScale: s.card.hoverScale !== undefined ? !!s.card.hoverScale : merged.card.hoverScale
          };
        }
        if (s.layout) {
          merged.layout = {
            ...merged.layout,
            minCardWidth: num(s.layout.minCardWidth, 110, 420, merged.layout.minCardWidth),
            showDesc: s.layout.showDesc !== undefined ? !!s.layout.showDesc : merged.layout.showDesc,
            showGroupIcon: s.layout.showGroupIcon !== undefined ? !!s.layout.showGroupIcon : merged.layout.showGroupIcon,
            denseMobile: s.layout.denseMobile !== undefined ? !!s.layout.denseMobile : merged.layout.denseMobile
          };
        }
        if (s.favicon && s.favicon.provider) {
          const allow = ['favicon.im', 'icon.horse', 'google', 'direct', 'custom'];
          if (allow.includes(s.favicon.provider)) merged.favicon = { provider: s.favicon.provider };
        }
        if (s.search) {
          merged.search = {
            ...merged.search,
            enabled: s.search.enabled !== undefined ? !!s.search.enabled : merged.search.enabled,
            placeholder: String(s.search.placeholder || merged.search.placeholder).slice(0, 60),
            openInNewTab: s.search.openInNewTab !== undefined ? !!s.search.openInNewTab : merged.search.openInNewTab
          };
        }
        merged.updatedAt = nowIso();
        await writeJSON(kv, K.settings, merged);
        return withCors(json({ ok: true, settings: merged }));
      }

      /* ---------------- 管理端：上传背景图（base64，存 KV） ---------------- */
      case 'api/admin/background': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        if (body.action === 'delete') {
          await kv.delete(K.background).catch(() => null);
          return withCors(json({ ok: true, deleted: true }));
        }
        const dataUrl = String(body.dataUrl || '');
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
          return withCors(err('仅支持 png / jpg / webp / gif 格式的 base64 图片', 400));
        }
        if (dataUrl.length > MAX_UPLOAD_BODY) {
          return withCors(err('图片过大。受平台单次请求体 1MB 限制，请压缩到约 600KB 以内，或改用图床直链方式', 413,
            { maxBytes: MAX_UPLOAD_BODY }));
        }
        await kv.put(K.background, JSON.stringify({ dataUrl, updatedAt: nowIso() }));
        return withCors(json({ ok: true, bytes: dataUrl.length }));
      }

      /* ---------------- 导出 ---------------- */
      case 'api/export': {
        const url = new URL(request.url);
        const format = (url.searchParams.get('format') || 'json').toLowerCase();
        const scope = url.searchParams.get('scope') || 'public'; // public | all
        const auth = await getAuth(request, kv);
        if (scope === 'all' && !auth.admin) return withCors(err('导出私密书签需要管理员登录', 401));

        const [settings, groups, links] = await Promise.all([
          readJSON(kv, K.settings, defaultSettings()),
          readJSON(kv, K.groups, []),
          readJSON(kv, K.links, [])
        ]);
        const outLinks = scope === 'all' ? links : links.filter(l => l.visibility !== 'private');

        if (format === 'html') {
          const stamp = new Date().toISOString().slice(0, 10);
          return withCors(htmlResponse(
            buildBookmarkHtml(sortGroups(groups), sortLinks(outLinks), settings),
            `navbox-bookmarks-${stamp}.html`
          ));
        }
        const background = scope === 'all' ? await readJSON(kv, K.background, null) : null;
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
        const payload = {
          app: 'NavBox', version: 1, exportedAt: nowIso(), scope,
          settings, groups: sortGroups(groups), links: sortLinks(outLinks), background
        };
        const res = json(payload);
        res.headers.set('Content-Disposition', `attachment; filename="navbox-export-${stamp}.json"`);
        return withCors(res);
      }

      /* ---------------- 导入 ---------------- */
      case 'api/admin/import': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));
        const body = await readBody(request);
        const mode = body.mode === 'merge' ? 'merge' : 'replace';
        let data = body.data;
        if (typeof data === 'string') {
          const trimmed = data.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { data = JSON.parse(trimmed); } catch (e) { return withCors(err('JSON 解析失败：' + e.message, 400)); }
          } else {
            data = { html: data };
          }
        }
        let result;
        try {
          result = await applyImport(kv, data, mode);
        } catch (e) {
          return withCors(err('导入失败：' + String(e && e.message || e).slice(0, 240), 400));
        }
        return withCors(json({ ok: true, ...result }));
      }

      /* ---------------- WebDAV 配置 ---------------- */
      case 'api/admin/webdav': {
        const auth = await getAuth(request, kv);
        if (!auth.admin) return withCors(err('未登录或会话已过期', 401));

        if (method === 'GET') {
          const cfg = await readJSON(kv, K.webdav, null);
          const log = await readJSON(kv, K.backupLog, []);
          return withCors(json({
            ok: true,
            config: cfg ? {
              url: cfg.url, path: cfg.path, username: cfg.username,
              passwordSet: !!cfg.password, autoBackup: !!cfg.autoBackup,
              intervalHours: cfg.intervalHours || 24, keep: cfg.keep || 10,
              lastBackupAt: cfg.lastBackupAt || null, lastBackupTarget: cfg.lastBackupTarget || null
            } : null,
            log: log || []
          }));
        }
        if (method !== 'POST') return withCors(err('仅支持 GET / POST', 405));

        const body = await readBody(request);
        const action = body.action || 'save';

        if (action === 'delete') {
          await kv.delete(K.webdav).catch(() => null);
          return withCors(json({ ok: true, deleted: true }));
        }

        const cur = (await readJSON(kv, K.webdav, null)) || {};
        if (action === 'save') {
          const urlStr = String(body.url || '').trim();
          if (urlStr && !/^https?:\/\//i.test(urlStr)) {
            return withCors(err('WebDAV 地址需以 http:// 或 https:// 开头', 400));
          }
          const next = {
            url: urlStr,
            path: String(body.path || '/navbox-backup').trim() || '/navbox-backup',
            username: String(body.username || ''),
            // 留空表示保持原密码不变
            password: body.password ? String(body.password) : (cur.password || ''),
            autoBackup: !!body.autoBackup,
            intervalHours: Math.min(720, Math.max(1, Number(body.intervalHours) || 24)),
            keep: Math.min(100, Math.max(1, Number(body.keep) || 10)),
            lastBackupAt: cur.lastBackupAt || null,
            lastBackupTarget: cur.lastBackupTarget || null,
            updatedAt: nowIso()
          };
          await writeJSON(kv, K.webdav, next);

          // 生成 cron 令牌，供控制台定时任务使用
          let cronToken = await kv.get(K.cronToken);
          if (typeof cronToken !== 'string' || !cronToken) {
            cronToken = randomHex(24);
            await kv.put(K.cronToken, cronToken);
          }
          return withCors(json({
            ok: true,
            config: {
              url: next.url, path: next.path, username: next.username,
              passwordSet: !!next.password, autoBackup: next.autoBackup,
              intervalHours: next.intervalHours, keep: next.keep
            },
            cronToken,
            cronHint: '将 edgeone.json 的 schedules.path 指向 /api/cron/backup，并在 payload 中填入 {"token":"<cronToken>"}；也可在控制台配置。平台定时任务最小间隔为一天。'
          }));
        }

        if (action === 'test') {
          const cfg = await readJSON(kv, K.webdav, null);
          if (!cfg || !cfg.url) return withCors(err('请先保存 WebDAV 配置', 400));
          const target = joinWebdavPath(cfg.url, (cfg.path || '/navbox-backup').replace(/\/+$/, ''));
          try {
            const res = await fetch(target, {
              method: 'PROPFIND',
              headers: {
                Authorization: webdavAuthHeader(cfg),
                Depth: '0',
                'Content-Type': 'application/xml; charset=utf-8'
              },
              body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
            });
            const okConn = res.ok || res.status === 207 || res.status === 404 || res.status === 405;
            if (res.status === 401 || res.status === 403) {
              return withCors(json({ ok: false, error: `认证失败 HTTP ${res.status}，请检查用户名/密码（或应用专用密码）` }));
            }
            return withCors(json({
              ok: okConn, status: res.status, target,
              message: okConn ? '连接成功' : `服务器返回 HTTP ${res.status}`
            }));
          } catch (e) {
            return withCors(json({
              ok: false,
              error: '网络请求失败：' + String(e && e.message || e).slice(0, 200),
              hint: '请确认 WebDAV 服务可从公网访问；部分服务商需使用应用专用密码而非账号密码。'
            }));
          }
        }

        if (action === 'backup') {
          const result = await runBackup(kv, 'manual');
          return withCors(json({ ok: result.ok, result }));
        }

        if (action === 'list') {
          const files = await listWebdavBackups(kv);
          return withCors(json({ ok: true, files }));
        }

        if (action === 'restore') {
          try {
            const result = await restoreFromWebdav(kv, body.href || null);
            return withCors(json({ ok: true, ...result }));
          } catch (e) {
            return withCors(err('恢复失败：' + String(e && e.message || e).slice(0, 240), 502));
          }
        }

        if (action === 'cronToken') {
          let token = await kv.get(K.cronToken);
          if (typeof token !== 'string' || !token) {
            token = randomHex(24);
            await kv.put(K.cronToken, token);
          }
          return withCors(json({ ok: true, cronToken: token }));
        }

        return withCors(err('未知操作', 400));
      }

      /* ---------------- 定时任务入口 ---------------- */
      case 'api/cron/backup': {
        const expected = await kv.get(K.cronToken);
        let provided = request.headers.get('X-Cron-Token') || new URL(request.url).searchParams.get('token') || '';
        if (!provided && method === 'POST') {
          try { provided = String((await readBody(request)).token || ''); } catch (e) { provided = ''; }
        }
        if (typeof expected !== 'string' || !expected || !safeEqual(provided, expected)) {
          return withCors(err('定时任务令牌无效。请先在后台保存 WebDAV 配置以生成令牌。', 403));
        }
        const result = await runBackup(kv, 'cron');
        return withCors(json({ ok: result.ok, result }));
      }

      /* ---------------- 点击计数（可选，弱一致） ---------------- */
      case 'api/track': {
        if (method !== 'POST') return withCors(err('仅支持 POST', 405));
        const body = await readBody(request);
        const id = String(body.id || '');
        if (!id) return withCors(json({ ok: false }));
        // 用 waitUntil 异步写入，不阻塞响应；KV 最终一致，计数为近似值
        const task = (async () => {
          try {
            const links = (await readJSON(kv, K.links, [])) || [];
            const idx = links.findIndex(l => l.id === id);
            if (idx < 0) return;
            links[idx].clicks = (links[idx].clicks || 0) + 1;
            await writeJSON(kv, K.links, links);
          } catch (e) { /* 忽略 */ }
        })();
        if (typeof waitUntil === 'function') waitUntil(task);
        return withCors(json({ ok: true }));
      }

      default:
        return withCors(err('接口不存在: /' + route, 404));
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === 'BODY_TOO_LARGE') {
      return withCors(err('请求内容超过平台 1MB 限制。背景图请先在浏览器端压缩，导入文件请拆分或改用图床链接。', 413));
    }
    if (msg === 'INVALID_JSON') {
      return withCors(err('请求体不是合法的 JSON', 400));
    }
    return withCors(err('服务器内部错误：' + msg.slice(0, 300), 500));
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname || '/');

  // 平台上静态资源路由优先于函数路由，因此这里正常情况下只会收到 /api/ 请求。
  // 非 /api/ 请求直接返回 404，不调用可能不存在的 context.next()。
  if (!pathname.startsWith(API_PREFIX)) {
    return new Response(JSON.stringify({ ok: false, error: '此接口仅处理 /api/ 前缀的请求' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  return handle(pathname, request.method.toUpperCase(), request, context);
}

// 说明：只导出 onRequest，它匹配全部 HTTP 方法（GET/POST/PUT/DELETE/OPTIONS）。
// 若同时导出 onRequestGet / onRequestPost 等，会与 onRequest 产生方法匹配冲突。
