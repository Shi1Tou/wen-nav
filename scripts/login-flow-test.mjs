/**
 * 登录流程回归测试（jsdom 驱动真实前端代码）
 *
 * 目的：复现并验证「管理员登录后约 3 秒被自动踢回登录界面」缺陷。
 * 该缺陷是前端状态互踩导致的竞态，纯 API 测试覆盖不到，必须在 DOM 中跑真实脚本。
 *
 * 原理：
 *   登录成功后 admin.js 调用了 NavBox.refreshAdminEntry()，而该函数读取的是
 *   nav.js 中尚未更新的 state.isAdmin（仍为 false），于是通过 syncAuth(false)
 *   把刚置位的登录态打回；随后 loadAdminData() 异步返回 → syncFront() →
 *   patch(isAdmin:false) → 再次 syncAuth(false) → renderLogin()，界面被踢回登录页。
 *   被踢回的时机 = 一次网络往返耗时，线上约 3 秒。
 *
 * 用法：
 *   1. 先启动本地服务：npm run mock
 *   2. 安装可选依赖：  npm install jsdom --no-save
 *   3. 运行：          node scripts/login-flow-test.mjs
 *
 * 环境变量：
 *   BASE     默认 http://localhost:8787
 *   LATENCY  对 /api/admin/data 注入的人为延迟(ms)，默认 1200，用于放大竞态窗口
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASE = process.env.BASE || 'http://localhost:8787';
const LATENCY = Number(process.env.LATENCY || 1200);

/* ---------------- jsdom 为可选依赖，缺失时优雅跳过 ---------------- */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('\n⚠️  未安装 jsdom，跳过登录流程测试。');
  console.log('    安装：npm install jsdom --no-save');
  console.log('    运行：node scripts/login-flow-test.mjs\n');
  process.exit(0);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 轮询等待条件成立 */
async function waitFor(fn, timeout = 8000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return true; } catch (e) { /* 忽略 */ }
    await sleep(60);
  }
  if (label) console.log('     (等待超时: ' + label + ')');
  return false;
}

/* ---------------- 带 Cookie 记忆的 fetch（模拟浏览器会话） ---------------- */
function makeFetch() {
  const jar = new Map();
  return async function (input, init) {
    const url = typeof input === 'string' ? new URL(input, BASE).toString() : input.url;
    const o = init || {};
    const headers = new Headers(o.headers || {});
    const cookieStr = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) headers.set('Cookie', cookieStr);

    // 对管理数据接口注入延迟，模拟线上边缘节点往返，放大异步竞态窗口
    if (LATENCY > 0 && url.indexOf('/api/admin/data') > -1) await sleep(LATENCY);

    const res = await fetch(url, { ...o, headers });

    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    sc.forEach(c => {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 1) return;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    });
    return res;
  };
}

/* ---------------- 构造运行真实前端脚本的 DOM ---------------- */
function buildDom(adminJsSource) {
  let html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  // 移除外部 script/link，改为手动 eval，确保加载顺序可控
  html = html
    .replace(/<script[^>]*\ssrc=[^>]*>\s*<\/script>/g, '')
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '');

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.fetch = makeFetch();
  // jsdom 未实现 matchMedia
  window.matchMedia = () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.confirm = () => true;

  // 按 index.html 中的顺序加载：nav.js 先于 admin.js
  window.eval(readFileSync(join(ROOT, 'public', 'assets', 'nav.js'), 'utf8'));
  window.eval(adminJsSource);

  // JSDOM 构造时 DOMContentLoaded 已触发过，这里手动补发以启动应用
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return dom;
}

/** 当前后台界面处于什么状态 */
function uiState(doc) {
  return {
    maskOpen: !!doc.querySelector('#adminMask') && doc.querySelector('#adminMask').hidden === false,
    loginForm: !!doc.querySelector('#loginForm'),
    tabs: !!doc.querySelector('#adminTabs'),
    tabPanels: doc.querySelectorAll('.tab-panel').length,
    linkRows: doc.querySelectorAll('#lnkList .list-item').length,
    headText: (doc.querySelector('#adminHeadText') || {}).textContent || ''
  };
}

/* ---------------- 执行一次完整登录流程 ---------------- */
async function runLoginScenario(adminJsSource, label) {
  console.log('\n--- 场景：' + label + ' ---');
  const dom = buildDom(adminJsSource);
  const { window } = dom;
  const doc = window.document;
  const trace = [];

  // 1) 等待前台 bootstrap 渲染完成
  const booted = await waitFor(
    () => doc.querySelector('#content .group') || doc.querySelector('#content .empty') || doc.querySelector('#content .err-banner'),
    10000, '前台数据加载'
  );
  ok(label + '：前台完成初始化', booted);
  if (!booted) { dom.window.close(); return null; }

  // 2) 打开管理后台
  doc.querySelector('#adminBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const loginShown = await waitFor(() => doc.querySelector('#loginForm'), 4000, '登录框出现');
  ok(label + '：点击 ⚙ 弹出登录框', loginShown);
  if (!loginShown) { dom.window.close(); return null; }

  // 3) 填写并提交登录
  doc.querySelector('#lgUser').value = 'admin';
  doc.querySelector('#lgPass').value = 'admin123';
  const t0 = Date.now();
  doc.querySelector('#loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // 4) 等待进入后台外壳（登录请求返回）
  const shellAppeared = await waitFor(() => doc.querySelector('#adminTabs'), 8000, '后台外壳出现');
  const tShell = Date.now() - t0;

  // 5) 关键观察点：等待超过 /api/admin/data 的往返延迟（竞态触发窗口）
  await sleep(LATENCY + 1500);
  const after = uiState(doc);
  const tAfter = Date.now() - t0;

  // 6) 再多等一会，确认不是更晚才掉线
  await sleep(2000);
  const later = uiState(doc);

  trace.push({ at: tShell, event: '后台外壳出现' });
  trace.push({ at: tAfter, event: '等待数据往返后：' + (after.loginForm ? '已回到登录页' : '仍在后台') });

  console.log('     时间线: ' + trace.map(t => t.at + 'ms ' + t.event).join(' | '));
  console.log('     最终界面: ' + (later.loginForm ? '登录表单' : later.tabs ? '后台标签页' : '未知') +
    '  标签面板数=' + later.tabPanels + '  书签行数=' + later.linkRows);

  dom.window.close();
  return { shellAppeared, after, later, tShell, tAfter };
}

/* ---------------- 构造「还原缺陷」的旧版 admin.js ---------------- */
function makeBuggyVariant(src) {
  const start = src.indexOf('S.isAdmin = true;');
  const endMark = "toast('登录成功', 'ok', 1600);";
  const end = src.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error('无法定位登录成功处理段，脚本结构可能已变化');
  // 还原为修复前的写法：未同步 nav.js 状态就调用 refreshAdminEntry
  const oldBlock =
    "S.isAdmin = true;\n" +
    "        S.username = res.username || $('#lgUser').value.trim();\n" +
    "        if (window.NavBox) window.NavBox.refreshAdminEntry();\n" +
    "        ";
  return src.slice(0, start) + oldBlock + src.slice(end);
}

/* ---------------- 主流程 ---------------- */
console.log('\n=== 登录流程回归测试（jsdom + 真实前端代码）===');
console.log('目标服务: ' + BASE + '    /api/admin/data 注入延迟: ' + LATENCY + 'ms');

// 服务可用性前置检查
try {
  const h = await fetch(BASE + '/api/health');
  if (!h.ok) throw new Error('HTTP ' + h.status);
} catch (e) {
  console.log('\n❌ 无法连接 ' + BASE + '：' + e.message);
  console.log('   请先在另一个终端执行  npm run mock  启动本地服务。\n');
  process.exit(1);
}

const currentSrc = readFileSync(join(ROOT, 'public', 'assets', 'admin.js'), 'utf8');
const buggySrc = makeBuggyVariant(currentSrc);
ok('成功构造修复前的对照版本', buggySrc !== currentSrc && buggySrc.indexOf('window.NavBox.state.isAdmin = true') === -1);

// A) 对照组：还原缺陷的旧代码，应当复现「被踢回登录页」
const buggy = await runLoginScenario(buggySrc, 'A 修复前（对照）');

// B) 实验组：当前代码，应当稳定停留在后台
const fixed = await runLoginScenario(currentSrc, 'B 修复后（当前代码）');

console.log('\n=== 结论 ===');
if (buggy) {
  ok('对照组确实复现了缺陷（登录成功后被踢回登录页）',
    buggy.shellAppeared === true && buggy.after.loginForm === true && buggy.after.tabs === false,
    '外壳出现=' + buggy.shellAppeared + ' 回到登录页=' + buggy.after.loginForm);
  ok('对照组掉线发生在数据往返之后（与"约3秒"吻合）',
    buggy.tAfter > buggy.tShell && buggy.tAfter >= LATENCY,
    '外壳=' + buggy.tShell + 'ms 掉线=' + buggy.tAfter + 'ms');
} else {
  ok('对照组运行完成', false, '对照组未能执行');
}

if (fixed) {
  ok('修复后登录成功进入后台', fixed.shellAppeared === true);
  ok('修复后等待数据往返仍停留在后台（未被踢回登录页）',
    fixed.after.loginForm === false && fixed.after.tabs === true,
    '登录页=' + fixed.after.loginForm + ' 标签页=' + fixed.after.tabs);
  ok('修复后再等 2 秒依然稳定', fixed.later.loginForm === false && fixed.later.tabs === true);
  ok('修复后后台数据已渲染（存在标签面板）', fixed.later.tabPanels > 0,
    '面板数=' + fixed.later.tabPanels);
  ok('修复后标题栏显示已登录账号', fixed.later.headText.indexOf('admin') > -1, fixed.later.headText);
} else {
  ok('修复组运行完成', false, '修复组未能执行');
}

console.log('\n' + '='.repeat(50));
console.log('  通过：' + pass + '    失败：' + fail + '    总计：' + (pass + fail));
console.log('='.repeat(50) + '\n');
process.exit(fail > 0 ? 1 : 0);
