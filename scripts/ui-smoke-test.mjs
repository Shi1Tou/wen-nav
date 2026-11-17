/**
 * NavBox 后台 UI 回归测试（jsdom 驱动真实前端代码）
 *
 * 覆盖：
 *   - 「私密设置」标签页：批量公开 / 私密设置
 *   - 「外观 → 书签卡片样式」：书签大小预设与实时 CSS 变量
 *   - 背景设置回归：外链图片 / 上传图片（存 KV）能实时显示并持久化
 *
 * 用法：
 *   1. 先启动本地服务：npm run mock
 *   2. 安装可选依赖：  npm install jsdom --no-save
 *   3. 运行：          npm run test:ui   （或 node scripts/ui-smoke-test.mjs）
 *
 * 环境变量：BASE 默认 http://localhost:8787
 * 说明：脚本会自动创建并删除一条「UI测试书签」，测试结束后恢复背景与书签尺寸，不影响其他数据。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASE = process.env.BASE || 'http://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* jsdom 为可选依赖，缺失时优雅跳过 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('\n⚠️  未安装 jsdom，跳过后台 UI 测试。');
  console.log('    安装：npm install jsdom --no-save\n');
  process.exit(0);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}
async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return true; } catch (e) { /* 忽略 */ }
    await sleep(60);
  }
  return false;
}
/** 轮询 /api/bootstrap，直到匿名视图符合条件 */
async function waitBootstrap(predicate, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const j = await (await fetch(BASE + '/api/bootstrap')).json();
      if (predicate(j)) return j;
    } catch (e) { /* 忽略 */ }
    await sleep(150);
  }
  return null;
}

/** 带 Cookie 记忆的 fetch（模拟浏览器会话） */
function makeFetch() {
  const jar = new Map();
  return async function (input, init) {
    const url = typeof input === 'string' ? new URL(input, BASE).toString() : input.url;
    const o = init || {};
    const headers = new Headers(o.headers || {});
    const cookieStr = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) headers.set('Cookie', cookieStr);
    const res = await fetch(url, { ...o, headers });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    sc.forEach(c => {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 1) return;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v);
    });
    return res;
  };
}

console.log('\n=== NavBox 后台 UI 测试 ===\n目标服务: ' + BASE + '\n');

// 构造运行真实前端脚本的 DOM（与 index.html 的加载顺序一致）
let html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
html = html
  .replace(/<script[^>]*\ssrc=[^>]*>\s*<\/script>/g, '')
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '');
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
window.fetch = makeFetch();
window.matchMedia = () => ({
  matches: false, media: '', onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
});
window.confirm = () => true;
window.eval(readFileSync(join(ROOT, 'public', 'assets', 'nav.js'), 'utf8'));
window.eval(readFileSync(join(ROOT, 'public', 'assets', 'admin.js'), 'utf8'));
doc.dispatchEvent(new window.Event('DOMContentLoaded'));

let testId = '';
try {
  const booted = await waitFor(
    () => doc.querySelector('#content .group') || doc.querySelector('#content .empty') || doc.querySelector('#content .err-banner'),
    10000
  );
  ok('前台初始化完成', booted);

  doc.querySelector('#adminBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok('登录框出现', await waitFor(() => doc.querySelector('#loginForm'), 4000));

  doc.querySelector('#lgUser').value = 'admin';
  doc.querySelector('#lgPass').value = 'admin123';
  doc.querySelector('#loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  ok('进入后台外壳', await waitFor(() => doc.querySelector('#adminTabs'), 8000));
  ok('管理数据渲染完成', await waitFor(() => doc.querySelector('#tabHost .tab-panel'), 8000));

  // 新建一条测试书签，避免操作真实数据
  const created = await window.fetch(BASE + '/api/admin/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', link: { title: 'UI测试书签', url: 'https://ui-test.invalid/', visibility: 'public' } })
  });
  const createdJson = await created.json();
  testId = createdJson.link && createdJson.link.id;
  ok('创建 UI 测试书签', created.status === 200 && !!testId);
  await window.NavBoxAdmin.reload();
  await sleep(400);

  // ---------------- 外观：书签大小 + 背景 ----------------
  doc.querySelector('#adminTabs [data-tab="style"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok('外观标签页已渲染', await waitFor(() => doc.querySelector('#sizePrev') && doc.querySelector('#bgType'), 6000));
  ok('主页书签描述已渲染',
    doc.querySelectorAll('#content .c-desc').length > 0 && !doc.body.classList.contains('no-desc'),
    'desc=' + doc.querySelectorAll('#content .c-desc').length + ' class=' + doc.body.className);
  ok('自定义布局控件齐全',
    ['#lIconPos', '#lTextOrder', '#lTextAlign', '#cTitleColor', '#cDescColor'].every(s => doc.querySelector(s)));

  // 书签大小：预设 + 实时 CSS 变量
  doc.querySelector('[data-size-preset="compact"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ok('紧凑预设写入滑杆',
    doc.querySelector('#szMinW').value === '140' && doc.querySelector('#szIcon').value === '30',
    doc.querySelector('#szMinW').value + '/' + doc.querySelector('#szIcon').value);
  ok('紧凑预设实时注入前台 CSS 变量',
    doc.documentElement.style.getPropertyValue('--card-icon').trim() === '30px',
    doc.documentElement.style.getPropertyValue('--card-icon'));
  ok('书签大小预览卡片已生成', !!doc.querySelector('#sizePrev .sp-card'));
  ok('布局预设数量为 7', doc.querySelectorAll('#sizePresets [data-size-preset]').length === 7,
    'count=' + doc.querySelectorAll('#sizePresets [data-size-preset]').length);

  doc.querySelector('[data-size-preset="tile"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ok('图标墙预设切换排列方式',
    doc.querySelector('#lCardStyle').value === 'tile' && doc.querySelector('#lIconPos').value === 'top' &&
    doc.body.classList.contains('icon-top'),
    doc.querySelector('#lCardStyle').value + ' / ' + doc.querySelector('#lIconPos').value + ' / ' + doc.body.className);
  ok('图标墙预设注入对应图标尺寸',
    doc.documentElement.style.getPropertyValue('--card-icon').trim() === '44px',
    doc.documentElement.style.getPropertyValue('--card-icon'));

  // 自定义布局：图标位置 / 名称描述顺序 / 对齐 / 文字颜色
  doc.querySelector('#lIconPos').value = 'top';
  doc.querySelector('#lIconPos').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('#lTextOrder').value = 'desc-first';
  doc.querySelector('#lTextOrder').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('#lTextAlign').value = 'center';
  doc.querySelector('#lTextAlign').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(150);
  ok('图标位置 / 文字顺序 / 对齐实时生效',
    doc.body.classList.contains('icon-top') && doc.body.classList.contains('text-desc-first') &&
    doc.body.classList.contains('text-center'),
    doc.body.className);

  const titleOn = doc.querySelector('#cTitleColorOn');
  titleOn.checked = true;
  titleOn.dispatchEvent(new window.Event('change', { bubbles: true }));
  const descOn = doc.querySelector('#cDescColorOn');
  descOn.checked = true;
  descOn.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('#cTitleColor').value = '#cc0000';
  doc.querySelector('#cTitleColor').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#cDescColor').value = '#005500';
  doc.querySelector('#cDescColor').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(500);
  ok('名称 / 描述自定义颜色实时生效',
    doc.documentElement.style.getPropertyValue('--card-title-color').trim() === '#cc0000' &&
    doc.documentElement.style.getPropertyValue('--card-desc-color').trim() === '#005500',
    doc.documentElement.style.getPropertyValue('--card-title-color') + ' / ' +
    doc.documentElement.style.getPropertyValue('--card-desc-color'));

  const descToggle = doc.querySelector('#lDesc');
  descToggle.checked = false;
  descToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(120);
  ok('关闭描述后应用 no-desc', doc.body.classList.contains('no-desc'));
  descToggle.checked = true;
  descToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(120);
  ok('重新开启描述后恢复显示', !doc.body.classList.contains('no-desc'));

  doc.querySelector('[data-size-preset="minimal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ok('极简预设不再误关描述',
    doc.querySelector('#lDesc').checked && !doc.body.classList.contains('no-desc') &&
    doc.querySelector('#szIcon').value === '26',
    'desc=' + doc.querySelector('#lDesc').checked + ' icon=' + doc.querySelector('#szIcon').value);

  // 背景：外链图片
  doc.querySelector('#bgType').value = 'url';
  doc.querySelector('#bgType').dispatchEvent(new window.Event('change', { bubbles: true }));
  const bgUrl = 'https://example.com/bg-test.jpg';
  doc.querySelector('#bgUrl').value = bgUrl;
  doc.querySelector('#bgUrl').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(500);
  const layer = doc.querySelector('#bgLayer');
  ok('外链背景实时显示到前台', String(layer.style.backgroundImage).indexOf('bg-test.jpg') > -1,
    layer.style.backgroundImage);
  ok('外链背景预览区生效', String(doc.querySelector('#bgPreview').style.backgroundImage).indexOf('bg-test.jpg') > -1,
    doc.querySelector('#bgPreview').style.backgroundImage);

  doc.querySelector('#saveStyle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const bsUrl = await waitBootstrap(j =>
    j.settings && j.settings.background && j.settings.background.type === 'url' && j.settings.background.url === bgUrl);
  ok('外链背景已保存并通过前台接口返回', !!bsUrl);
  ok('保存后前台背景图仍存在', String(doc.querySelector('#bgLayer').style.backgroundImage).indexOf('bg-test.jpg') > -1,
    doc.querySelector('#bgLayer').style.backgroundImage);

  // 背景：上传图片（存 KV）
  const tiny = 'data:image/png;base64,' + 'A'.repeat(4000);
  const uploaded = await window.fetch(BASE + '/api/admin/background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: tiny })
  });
  ok('通过接口上传背景图到 KV', uploaded.status === 200);
  await window.NavBoxAdmin.reload();
  await waitFor(() => doc.querySelector('#bgType'), 6000);
  doc.querySelector('#bgType').value = 'upload';
  doc.querySelector('#bgType').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(250);
  doc.querySelector('#saveStyle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const bsUp = await waitBootstrap(j =>
    j.settings && j.settings.background && j.settings.background.type === 'upload' &&
    j.background && String(j.background.dataUrl || '').indexOf('data:image/png;base64,') === 0);
  ok('上传背景类型与图片已持久化', !!bsUp);
  ok('上传背景实时显示到前台',
    String(doc.querySelector('#bgLayer').style.backgroundImage).indexOf('data:image/png;base64,') > -1,
    String(doc.querySelector('#bgLayer').style.backgroundImage).slice(0, 60));

  // ---------------- 私密设置：批量可见性 ----------------
  doc.querySelector('#adminTabs [data-tab="privacy"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok('私密设置标签页已渲染', await waitFor(() => doc.querySelector('#bvList'), 6000));
  ok('私密设置页不含死链 / 分组排序 / 尺寸控件',
    !doc.querySelector('#lcStart') && !doc.querySelector('#gsList') && !doc.querySelector('#sizePrev'));

  await sleep(300);
  const target = [...doc.querySelectorAll('#bvList .check-row')]
    .find(r => (r.textContent || '').indexOf('UI测试书签') > -1);
  ok('批量列表找到目标书签', !!target);
  if (target) {
    const cb = target.querySelector('input[data-bv-id]');
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    ok('勾选后计数更新', doc.querySelector('#bvSelCount').textContent.indexOf('1') > -1,
      doc.querySelector('#bvSelCount').textContent);

    doc.querySelector('#bvPrivate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const changed = await waitFor(() => {
      const row = [...doc.querySelectorAll('#bvList .check-row')]
        .find(r => (r.textContent || '').indexOf('UI测试书签') > -1);
      return row && row.querySelector('.pill') && row.querySelector('.pill').textContent === '私密';
    }, 8000);
    ok('批量设为私密后行内角标更新', changed);

    const d2 = await (await window.fetch(BASE + '/api/admin/data')).json();
    const saved = (d2.links || []).find(l => l.id === testId);
    ok('后端已保存为私密', saved && saved.visibility === 'private', saved && saved.visibility);
    ok('应用后自动清空选择',
      await waitFor(() => doc.querySelector('#bvSelCount').textContent.indexOf('0') > -1, 4000),
      doc.querySelector('#bvSelCount').textContent);
  } else {
    ok('勾选后计数更新', false, 'target missing');
    ok('批量设为私密后行内角标更新', false, 'target missing');
    ok('后端已保存为私密', false, 'target missing');
    ok('应用后自动清空选择', false, 'target missing');
  }
} catch (e) {
  console.error('\n❌ 测试执行异常：', e);
  fail++;
} finally {
  // 清理测试书签与背景，恢复默认设置
  try {
    if (testId) {
      await window.fetch(BASE + '/api/admin/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ids: [testId] })
      });
      console.log('  ✅ 已清理 UI 测试书签');
    }
    await window.fetch(BASE + '/api/admin/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' })
    });
    await window.fetch(BASE + '/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          background: { type: 'gradient', url: '', blur: 0, brightness: 100, overlay: 30, gradient: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)' },
          card: { titleColor: '', descColor: '' },
          layout: { cardStyle: 'row', iconPosition: 'left', textOrder: 'title-first', textAlign: 'left', showDesc: true, minCardWidth: 168, gridGap: 14, iconSize: 38, cardPadding: 11, titleSize: 14, descSize: 11.5 }
        }
      })
    });
    console.log('  ✅ 已恢复默认背景与书签尺寸');
  } catch (e) { /* 忽略清理失败 */ }
  console.log('\n' + '='.repeat(46));
  console.log('  通过：' + pass + '    失败：' + fail + '    总计：' + (pass + fail));
  console.log('='.repeat(46) + '\n');
  dom.window.close();
  process.exit(fail > 0 ? 1 : 0);
}
