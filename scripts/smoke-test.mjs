/**
 * NavBox 接口冒烟测试
 * 用法：先启动 dev-server.mjs，再执行  node scripts/smoke-test.mjs
 * 覆盖：健康检查 / 登录鉴权 / 私密过滤 / 书签增删改 / 分组排序 / 设置 / 导入导出 / 改密
 */

const BASE = process.env.BASE || 'http://localhost:8787';
let cookie = '';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}

async function call(path, opts) {
  const o = opts || {};
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: o.method || 'GET',
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    redirect: 'manual'
  });
  // 保存 cookie（登录/改密会重签）
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  sc.forEach(c => {
    const kv = c.split(';')[0];
    if (kv.startsWith('navbox_token=')) cookie = kv;
    if (kv === 'navbox_token=') cookie = '';
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

console.log('\n=== NavBox 接口冒烟测试 ===\n目标：' + BASE + '\n');

/* ---------- 1. 健康检查 ---------- */
console.log('[1] 健康检查与 KV 绑定');
{
  const r = await call('/api/health');
  ok('GET /api/health 返回 200', r.status === 200, 'status=' + r.status);
  ok('KV 已绑定', r.data && r.data.kv === true);
}

/* ---------- 2. 前台数据 ---------- */
console.log('\n[2] 前台 bootstrap 与私密书签过滤');
{
  const r = await call('/api/bootstrap');
  ok('GET /api/bootstrap 返回 200', r.status === 200, 'status=' + r.status);
  ok('已注入默认分组', Array.isArray(r.data.groups) && r.data.groups.length > 0,
    JSON.stringify(r.data.groups));
  ok('已注入默认书签', Array.isArray(r.data.links) && r.data.links.length > 0);
  ok('未登录时 isAdmin=false', r.data.isAdmin === false);
  const hasPrivate = (r.data.links || []).some(l => l.visibility === 'private');
  ok('未登录时私密书签被过滤', hasPrivate === false);
  ok('返回默认设置对象', r.data.settings && typeof r.data.settings === 'object');
  ok('卡片透明度设置存在', r.data.settings.card && r.data.settings.card.opacity !== undefined);
}

/* ---------- 3. 登录鉴权 ---------- */
console.log('\n[3] 登录鉴权');
{
  const r1 = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-pass' } });
  ok('错误密码返回 401', r1.status === 401, 'status=' + r1.status);

  const r2 = await call('/api/auth/check');
  ok('未登录 check 返回 isAdmin=false', r2.data && r2.data.isAdmin === false);

  const r3 = await call('/api/admin/data');
  ok('未登录访问管理数据返回 401', r3.status === 401, 'status=' + r3.status);

  const r4 = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok('默认账号登录成功', r4.status === 200 && r4.data.ok === true, JSON.stringify(r4.data));
  ok('登录后拿到会话 Cookie', cookie.indexOf('navbox_token=') === 0, cookie);

  const r5 = await call('/api/auth/check');
  ok('登录后 check 返回 isAdmin=true', r5.data && r5.data.isAdmin === true);

  const r6 = await call('/api/admin/data');
  ok('登录后可读管理数据', r6.status === 200 && r6.data.ok === true, 'status=' + r6.status);
  const priv = (r6.data.links || []).filter(l => l.visibility === 'private');
  ok('管理员可见私密书签', priv.length > 0, '私密数=' + priv.length);
  ok('管理数据含 webdav/backupLog 字段', 'webdav' in r6.data && 'backupLog' in r6.data);
}

/* ---------- 4. 书签增删改 ---------- */
console.log('\n[4] 书签增删改');
let newLinkId = '';
{
  const c = await call('/api/admin/link', {
    method: 'POST',
    body: { action: 'create', link: { title: '测试站点', url: 'example.com/test', desc: '冒烟测试用', visibility: 'private' } }
  });
  ok('创建书签成功', c.status === 200 && c.data.ok === true, JSON.stringify(c.data));
  newLinkId = c.data.link && c.data.link.id;
  ok('返回书签 id', !!newLinkId);
  ok('无协议网址自动补 https://', c.data.link && c.data.link.url === 'https://example.com/test',
    c.data.link && c.data.link.url);
  ok('私密属性已保存', c.data.link && c.data.link.visibility === 'private');
  ok('标题长度受控', c.data.link && c.data.link.title.length <= 80);

  const u = await call('/api/admin/link', {
    method: 'POST',
    body: { action: 'update', id: newLinkId, link: { title: '测试站点(改)', desc: '已更新', iconType: 'text' } }
  });
  ok('更新书签成功', u.status === 200 && u.data.ok === true, JSON.stringify(u.data));
  ok('标题已更新', u.data.link.title === '测试站点(改)', u.data.link.title);
  ok('图标类型已更新为 text', u.data.link.iconType === 'text');
  ok('更新时保留了原 url', u.data.link.url === 'https://example.com/test', u.data.link.url);

  const bad = await call('/api/admin/link', { method: 'POST', body: { action: 'create', link: { title: '无地址' } } });
  ok('缺少 url 时返回 400', bad.status === 400, 'status=' + bad.status);

  const xss = await call('/api/admin/link', {
    method: 'POST',
    body: { action: 'create', link: { title: '<script>alert(1)</script>', url: 'https://xss.test' } }
  });
  ok('标题中的脚本标签被原样存储（前端负责转义）', xss.status === 200);
  const xssId = xss.data.link && xss.data.link.id;

  const del = await call('/api/admin/link', { method: 'POST', body: { action: 'delete', ids: [xssId] } });
  ok('删除书签成功', del.status === 200 && del.data.deleted === 1, JSON.stringify(del.data));
}

/* ---------- 5. 分组与排序 ---------- */
console.log('\n[5] 分组管理与排序');
let g1 = '', g2 = '';
{
  const a = await call('/api/admin/group', { method: 'POST', body: { action: 'create', group: { name: '测试组A', icon: '🅰️' } } });
  ok('创建分组 A', a.status === 200 && a.data.ok === true);
  g1 = a.data.group.id;
  const b = await call('/api/admin/group', { method: 'POST', body: { action: 'create', group: { name: '测试组B', icon: '🅱️' } } });
  ok('创建分组 B', b.status === 200);
  g2 = b.data.group.id;
  ok('分组自动分配递增 order', b.data.group.order > a.data.group.order,
    'A=' + a.data.group.order + ' B=' + b.data.group.order);

  const up = await call('/api/admin/group', {
    method: 'POST', body: { action: 'reorder', orders: [{ id: g2, order: 1 }, { id: g1, order: 2 }] }
  });
  ok('分组重排成功', up.status === 200 && up.data.ok === true);
  const arr = up.data.groups || [];
  ok('重排后 B 排在 A 前面', arr.findIndex(x => x.id === g2) < arr.findIndex(x => x.id === g1));

  const ren = await call('/api/admin/group', { method: 'POST', body: { action: 'update', id: g1, group: { name: '测试组A改', icon: '⭐' } } });
  ok('分组重命名成功', ren.data.group.name === '测试组A改' && ren.data.group.icon === '⭐');

  // 把测试书签移入分组 A
  await call('/api/admin/link', { method: 'POST', body: { action: 'update', id: newLinkId, link: { groupId: g1 } } });

  const blockDel = await call('/api/admin/group', { method: 'POST', body: { action: 'delete', id: g1 } });
  ok('分组内有书签时拒绝删除(409)', blockDel.status === 409, 'status=' + blockDel.status);
  ok('409 响应告知受影响数量', blockDel.data && blockDel.data.affected === 1, JSON.stringify(blockDel.data));

  const forceDel = await call('/api/admin/group', { method: 'POST', body: { action: 'delete', id: g1, force: true } });
  ok('force=true 时连同书签删除', forceDel.status === 200 && forceDel.data.deletedLinks === 1, JSON.stringify(forceDel.data));
  await call('/api/admin/group', { method: 'POST', body: { action: 'delete', id: g2 } });

  const chk = await call('/api/admin/data');
  ok('删除后书签已同步移除', !(chk.data.links || []).some(l => l.id === newLinkId));
}

/* ---------- 6. 站点设置 ---------- */
console.log('\n[6] 站点设置（背景 / 卡片透明度 / 布局）');
{
  const r = await call('/api/admin/settings', {
    method: 'POST',
    body: {
      settings: {
        siteTitle: '我的导航站',
        siteSubtitle: '副标题测试',
        background: { type: 'url', url: 'https://i.example.com/bg.jpg', blur: 6, brightness: 90, overlay: 45 },
        card: { opacity: 55, bgColor: '#101828', blur: 18, radius: 20, textColor: '#ffffff', hoverScale: false },
        layout: { minCardWidth: 200, showDesc: false, denseMobile: true },
        favicon: { provider: 'icon.horse' },
        search: { enabled: true, placeholder: '找点什么…', openInNewTab: false }
      }
    }
  });
  ok('保存设置成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 200));
  const s = r.data.settings;
  ok('标题已保存', s.siteTitle === '我的导航站');
  ok('卡片透明度已保存', s.card.opacity === 55, String(s.card.opacity));
  ok('卡片背景色已保存', s.card.bgColor === '#101828');
  ok('背景类型/图床地址已保存', s.background.type === 'url' && s.background.url === 'https://i.example.com/bg.jpg');
  ok('背景模糊/亮度/遮罩已保存', s.background.blur === 6 && s.background.brightness === 90 && s.background.overlay === 45);
  ok('布局设置已保存', s.layout.minCardWidth === 200 && s.layout.denseMobile === true);
  ok('图标源已保存', s.favicon.provider === 'icon.horse');
  ok('搜索设置已保存', s.search.placeholder === '找点什么…');

  // 越界值应被夹紧
  const r2 = await call('/api/admin/settings', {
    method: 'POST',
    body: { settings: { card: { opacity: 999, blur: -5, radius: 888 }, background: { overlay: 200 } } }
  });
  ok('透明度越界值被夹紧到 100', r2.data.settings.card.opacity === 100, String(r2.data.settings.card.opacity));
  ok('模糊负值被夹紧到 0', r2.data.settings.card.blur === 0, String(r2.data.settings.card.blur));
  ok('圆角越界被夹紧到 40', r2.data.settings.card.radius === 40, String(r2.data.settings.card.radius));
  ok('遮罩越界被夹紧到 95', r2.data.settings.background.overlay === 95, String(r2.data.settings.background.overlay));

  // 非法枚举值应回退
  const r3 = await call('/api/admin/settings', {
    method: 'POST', body: { settings: { theme: 'neon', favicon: { provider: 'evil.com' } } }
  });
  ok('非法主题值回退为 auto', r3.data.settings.theme === 'auto', r3.data.settings.theme);
  ok('非法图标源被拒绝', r3.data.settings.favicon.provider === 'icon.horse', r3.data.settings.favicon.provider);

  // 恢复
  await call('/api/admin/settings', {
    method: 'POST',
    body: { settings: { siteTitle: 'NavBox 导航', siteSubtitle: '简洁、快速、可自定义的个人网址导航', theme: 'auto', card: { opacity: 82, bgColor: '#ffffff', blur: 12, radius: 14, textColor: '#1f2430', hoverScale: true }, background: { type: 'gradient', url: '', blur: 0, brightness: 100, overlay: 30 }, layout: { minCardWidth: 168, showDesc: true, denseMobile: false }, favicon: { provider: 'favicon.im' }, search: { enabled: true, placeholder: '搜索书签…', openInNewTab: true } } }
  });
}

/* ---------- 7. 背景图上传 ---------- */
console.log('\n[7] 背景图上传与大小限制');
{
  // 构造一个约 20KB 的 base64 假图片（仅验证存储与校验链路）
  const pngHeader = 'data:image/png;base64,';
  const small = pngHeader + 'A'.repeat(20000);
  const r = await call('/api/admin/background', { method: 'POST', body: { dataUrl: small } });
  ok('上传小体积 base64 图片成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  const bad = await call('/api/admin/background', { method: 'POST', body: { dataUrl: 'data:text/html;base64,AAAA' } });
  ok('拒绝非图片 MIME 类型', bad.status === 400, 'status=' + bad.status);

  const d = await call('/api/admin/data');
  ok('背景图已可在管理数据中读回', !!(d.data.background && d.data.background.dataUrl));

  const bs = await call('/api/bootstrap');
  ok('前台 bootstrap 返回背景数据', !!(bs.data.background && bs.data.background.dataUrl));

  const del = await call('/api/admin/background', { method: 'POST', body: { action: 'delete' } });
  ok('删除背景图成功', del.status === 200 && del.data.deleted === true);
  const d2 = await call('/api/admin/data');
  ok('删除后背景数据为空', d2.data.background === null);
}

/* ---------- 8. 导出 ---------- */
console.log('\n[8] 导出 JSON / HTML');
{
  const rj = await call('/api/export?format=json&scope=all');
  ok('导出 JSON（含私密）成功', rj.status === 200 && rj.data.app === 'NavBox', 'status=' + rj.status);
  ok('导出 JSON 含 groups/links/settings', Array.isArray(rj.data.groups) && Array.isArray(rj.data.links) && !!rj.data.settings);
  ok('导出 JSON 含私密书签', (rj.data.links || []).some(l => l.visibility === 'private'));

  const rp = await call('/api/export?format=json&scope=public');
  ok('导出 JSON（仅公开）不含私密', !(rp.data.links || []).some(l => l.visibility === 'private'));
  ok('公开导出数量少于全量导出', (rp.data.links || []).length < (rj.data.links || []).length);

  const rh = await call('/api/export?format=html&scope=all');
  const html = typeof rh.data === 'string' ? rh.data : '';
  ok('导出 HTML 成功', rh.status === 200);
  ok('HTML 为 Netscape 书签格式', html.indexOf('<!DOCTYPE NETSCAPE-Bookmark-file-1>') > -1);
  ok('HTML 含分组标题 H3', /<DT><H3>/.test(html));
  ok('HTML 含 HREF 链接', /HREF="/.test(html));
  ok('HTML 标记了私密书签', /PRIVATE="1"/.test(html));
}

/* ---------- 9. 导入 ---------- */
console.log('\n[9] 导入（JSON 合并 / 覆盖 / HTML）');
{
  const exported = await call('/api/export?format=json&scope=all');
  const before = (exported.data.links || []).length;

  // 合并模式：同内容应全部去重
  const m1 = await call('/api/admin/import', { method: 'POST', body: { mode: 'merge', data: JSON.stringify(exported.data) } });
  ok('JSON 合并导入成功', m1.status === 200 && m1.data.ok === true, JSON.stringify(m1.data));
  ok('重复内容按 URL 去重（added=0）', m1.data.added === 0, 'added=' + m1.data.added);
  ok('去重跳过数量等于原数量', m1.data.skipped === before, 'skipped=' + m1.data.skipped);

  // 合并新数据
  const newData = {
    groups: [{ id: 'gi1', name: '导入测试组', icon: '📥', order: 99 }],
    links: [{ id: 'li1', groupId: 'gi1', title: '导入书签一', url: 'https://import-one.test', visibility: 'public' },
            { id: 'li2', groupId: 'gi1', title: '导入书签二', url: 'https://import-two.test', visibility: 'private' }]
  };
  const m2 = await call('/api/admin/import', { method: 'POST', body: { mode: 'merge', data: JSON.stringify(newData) } });
  ok('合并新书签成功', m2.status === 200 && m2.data.added === 2, JSON.stringify(m2.data));
  const afterMerge = await call('/api/admin/data');
  ok('合并后总数增加 2', (afterMerge.data.links || []).length === before + 2);
  ok('合并时保留原有分组', (afterMerge.data.groups || []).some(g => g.name === '常用'));
  ok('导入分组已建立映射', (afterMerge.data.links || []).some(l => l.url === 'https://import-one.test'));
  const importedPriv = (afterMerge.data.links || []).find(l => l.url === 'https://import-two.test');
  ok('导入的私密属性被保留', importedPriv && importedPriv.visibility === 'private');

  // HTML 导入
  const htmlData = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>' +
    '<DT><H3>浏览器导入组</H3><DL><p>' +
    '<DT><A HREF="https://from-html.test" ICON="https://from-html.test/fav.png">来自HTML</A>' +
    '<DT><A HREF="https://priv-html.test" PRIVATE="1">HTML私密</A>' +
    '</DL><p></DL><p>';
  const h = await call('/api/admin/import', { method: 'POST', body: { mode: 'merge', data: htmlData } });
  ok('HTML 书签导入成功', h.status === 200 && h.data.ok === true, JSON.stringify(h.data));
  ok('HTML 导入新增 2 条', h.data.added === 2, 'added=' + h.data.added);
  const afterHtml = await call('/api/admin/data');
  const htmlLink = (afterHtml.data.links || []).find(l => l.url === 'https://from-html.test');
  ok('HTML 导入的 ICON 被识别为自定义图标', htmlLink && htmlLink.iconType === 'custom' && htmlLink.icon === 'https://from-html.test/fav.png',
    htmlLink ? htmlLink.iconType + ' / ' + htmlLink.icon : 'not found');
  const htmlPriv = (afterHtml.data.links || []).find(l => l.url === 'https://priv-html.test');
  ok('HTML 的 PRIVATE 标记被解析为私密', htmlPriv && htmlPriv.visibility === 'private');
  ok('HTML 分组名被正确提取', (afterHtml.data.groups || []).some(g => g.name === '浏览器导入组'));

  // 非法内容
  const badImp = await call('/api/admin/import', { method: 'POST', body: { mode: 'merge', data: 'random plain text here' } });
  ok('无法识别的内容返回错误', badImp.status === 400 || (badImp.data && badImp.data.ok === false), JSON.stringify(badImp.data).slice(0, 120));
  const badJson = await call('/api/admin/import', { method: 'POST', body: { mode: 'merge', data: '{broken json' } });
  ok('损坏的 JSON 返回 400', badJson.status === 400, 'status=' + badJson.status);

  // 覆盖模式恢复
  const rep = await call('/api/admin/import', { method: 'POST', body: { mode: 'replace', data: JSON.stringify(exported.data) } });
  ok('覆盖模式导入成功', rep.status === 200 && rep.data.mode === 'replace', JSON.stringify(rep.data));
  const afterRep = await call('/api/admin/data');
  ok('覆盖后数量回到导入前', (afterRep.data.links || []).length === before, 'now=' + (afterRep.data.links || []).length + ' before=' + before);
  ok('覆盖后清掉了导入的临时分组', !(afterRep.data.groups || []).some(g => g.name === '导入测试组'));
}

/* ---------- 10. WebDAV 配置 ---------- */
console.log('\n[10] WebDAV 配置与备份容错');
{
  const badUrl = await call('/api/admin/webdav', { method: 'POST', body: { action: 'save', url: 'ftp://x', path: '/b' } });
  ok('非 http(s) 地址被拒绝', badUrl.status === 400, 'status=' + badUrl.status);

  const save = await call('/api/admin/webdav', {
    method: 'POST',
    body: { url: 'https://dav.invalid-host-for-test.local/dav/', path: '/navbox-backup', username: 'tester', password: 'secret123', autoBackup: true, intervalHours: 6, keep: 5 }
  });
  ok('保存 WebDAV 配置成功', save.status === 200 && save.data.ok === true, JSON.stringify(save.data).slice(0, 160));
  ok('返回 cron 令牌', typeof save.data.cronToken === 'string' && save.data.cronToken.length >= 24);
  ok('响应中不回显密码', JSON.stringify(save.data).indexOf('secret123') === -1);

  const g = await call('/api/admin/webdav', { method: 'GET' });
  ok('读取配置成功', g.status === 200 && g.data.ok === true);
  ok('配置回显 username 但不回显密码', g.data.config.username === 'tester' && JSON.stringify(g.data.config).indexOf('secret123') === -1);
  ok('以 passwordSet 布尔值表示已存密码', g.data.config.passwordSet === true);
  ok('自动备份参数已保存', g.data.config.autoBackup === true && g.data.config.intervalHours === 6 && g.data.config.keep === 5);

  // 留空密码应保留原密码
  const save2 = await call('/api/admin/webdav', { method: 'POST', body: { url: 'https://dav.invalid-host-for-test.local/dav/', path: '/navbox-backup', username: 'tester', password: '', autoBackup: false, intervalHours: 24, keep: 10 } });
  ok('密码留空时保持原值(passwordSet 仍为 true)', save2.data.config.passwordSet === true);

  // 不可达主机的备份应优雅失败并记录日志
  const bk = await call('/api/admin/webdav', { method: 'POST', body: { action: 'backup' } });
  ok('不可达服务器时备份返回失败而非 500', bk.status === 200 && bk.data.ok === false, 'status=' + bk.status + ' ' + JSON.stringify(bk.data).slice(0, 140));
  ok('失败原因被写入日志', bk.data.result && typeof bk.data.result.error === 'string');

  const lg = await call('/api/admin/webdav', { method: 'GET' });
  ok('备份日志已记录失败条目', Array.isArray(lg.data.log) && lg.data.log.length > 0 && lg.data.log[0].ok === false);

  // 定时任务令牌校验
  const noTok = await call('/api/cron/backup', { method: 'POST', body: {} });
  ok('无令牌调用 cron 返回 403', noTok.status === 403, 'status=' + noTok.status);
  const badTok = await call('/api/cron/backup', { method: 'POST', body: { token: 'wrong-token' } });
  ok('错误令牌调用 cron 返回 403', badTok.status === 403, 'status=' + badTok.status);
  const goodTok = await call('/api/cron/backup', { method: 'POST', body: { token: save.data.cronToken } });
  ok('正确令牌可触发 cron（主机不可达故备份失败）', goodTok.status === 200 && goodTok.data.ok === false, 'status=' + goodTok.status);
  ok('cron 触发的日志标记为 cron', goodTok.data.result && goodTok.data.result.trigger === 'cron');

  // 测试连接
  const t = await call('/api/admin/webdav', { method: 'POST', body: { action: 'test' } });
  ok('测试连接返回结构化结果而非崩溃', t.status === 200 && typeof t.data === 'object');

  // 清理
  const del = await call('/api/admin/webdav', { method: 'POST', body: { action: 'delete' } });
  ok('删除 WebDAV 配置成功', del.status === 200 && del.data.deleted === true);
}

/* ---------- 11. 越权与请求体限制 ---------- */
console.log('\n[11] 安全边界');
{
  // 先清空会话，确保是在未登录状态下验证越权拦截
  cookie = '';
  const noTok = await call('/api/admin/webdav', { method: 'POST', body: { action: 'save', url: 'https://x.test' } });
  ok('管理接口未登录时拒绝(401)', noTok.status === 401, 'status=' + noTok.status);

  const forged = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok('重新登录获取有效会话', forged.status === 200);

  // 篡改令牌
  const realCookie = cookie;
  cookie = 'navbox_token=' + realCookie.split('=')[1].slice(0, -3) + 'abc';
  const tampered = await call('/api/admin/data');
  ok('篡改后的令牌被拒绝(401)', tampered.status === 401, 'status=' + tampered.status);
  cookie = realCookie;
  const restored = await call('/api/admin/data');
  ok('恢复正确令牌后可正常访问', restored.status === 200);

  // GET 方法访问仅 POST 接口
  const wrongMethod = await call('/api/auth/login');
  ok('GET 访问登录接口返回 405', wrongMethod.status === 405, 'status=' + wrongMethod.status);

  // 不存在的路由
  const nf = await call('/api/nonexistent-route');
  ok('未知接口返回 404', nf.status === 404, 'status=' + nf.status);

  const nonApi = await call('/not-api-path');
  ok('非 /api/ 路径不被函数接管', nonApi.status === 404 || nonApi.status === 200, 'status=' + nonApi.status);

  // 非法 JSON
  const raw = await fetch(BASE + '/api/admin/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{not json'
  });
  ok('非法 JSON 请求体返回 400', raw.status === 400, 'status=' + raw.status);
}

/* ---------- 12. 修改账号 ---------- */
console.log('\n[12] 修改管理员名称与密码');
{
  const wrongCur = await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'bad', newUsername: 'boss' } });
  ok('当前密码错误时返回 403', wrongCur.status === 403, 'status=' + wrongCur.status);

  const shortPw = await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'admin123', newPassword: '123' } });
  ok('过短新密码被拒绝', shortPw.status === 400, 'status=' + shortPw.status);

  const badUser = await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'admin123', newUsername: 'a' } });
  ok('过短用户名被拒绝', badUser.status === 400, 'status=' + badUser.status);

  const rename = await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'admin123', newUsername: 'navboss' } });
  ok('仅改用户名成功', rename.status === 200 && rename.data.username === 'navboss', JSON.stringify(rename.data));
  ok('仅改用户名时不标记密码已改', rename.data.passwordChanged === false);

  const stillWork = await call('/api/admin/data');
  ok('改名后原会话仍有效', stillWork.status === 200);

  const changePw = await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'admin123', newPassword: 'Str0ng!Pass#2026' } });
  ok('修改密码成功', changePw.status === 200 && changePw.data.passwordChanged === true, JSON.stringify(changePw.data));
  ok('改密后重新签发了会话 Cookie', cookie.indexOf('navbox_token=') === 0);
  const cur = await call('/api/admin/data');
  ok('新会话可正常访问', cur.status === 200);

  const oldPw = await call('/api/auth/login', { method: 'POST', body: { username: 'navboss', password: 'admin123' } });
  ok('旧密码登录失败', oldPw.status === 401, 'status=' + oldPw.status);
  const oldName = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Str0ng!Pass#2026' } });
  ok('旧用户名登录失败', oldName.status === 401, 'status=' + oldName.status);
  const newLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'navboss', password: 'Str0ng!Pass#2026' } });
  ok('新用户名+新密码登录成功', newLogin.status === 200 && newLogin.data.ok === true, JSON.stringify(newLogin.data));

  const accInfo = await call('/api/admin/data');
  ok('账号信息标记为非默认密码', accInfo.data.account && accInfo.data.account.isDefault === false);
  ok('账号信息不泄露哈希与盐', !JSON.stringify(accInfo.data.account).match(/hash|salt/));

  // 还原用户名与密码为默认值，方便用户开箱体验（否则本地跑完测试后默认密码会失效）
  await call('/api/auth/account', { method: 'POST', body: { currentPassword: 'Str0ng!Pass#2026', newUsername: 'admin', newPassword: 'admin123' } });
  const d2 = await call('/api/admin/data');
  ok('用户名已还原为 admin', d2.data.account.username === 'admin');

  // 验证还原后确实能用默认账号登录
  cookie = '';
  const relogin = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok('还原后可用默认账号 admin/admin123 重新登录', relogin.status === 200 && relogin.data.ok === true,
    'status=' + relogin.status);
}

/* ---------- 13. 登出 ---------- */
console.log('\n[13] 登出');
{
  const r = await call('/api/auth/logout', { method: 'POST', body: {} });
  ok('登出成功', r.status === 200 && r.data.ok === true);
  const after = await call('/api/admin/data');
  ok('登出后管理接口返回 401', after.status === 401, 'status=' + after.status);
  const bs = await call('/api/bootstrap');
  ok('登出后前台仍可访问公开数据', bs.status === 200 && bs.data.isAdmin === false);
  ok('登出后私密书签不再返回', !(bs.data.links || []).some(l => l.visibility === 'private'));
}

/* ---------- 14. 静态资源 ---------- */
console.log('\n[14] 静态资源');
{
  const idx = await fetch(BASE + '/');
  const idxText = await idx.text();
  ok('首页返回 200', idx.status === 200);
  ok('首页为 HTML 文档', idxText.indexOf('<!DOCTYPE html>') > -1);
  ok('首页引用了 nav.css', idxText.indexOf('/assets/nav.css') > -1);
  ok('首页引用了 admin.js', idxText.indexOf('/assets/admin.js') > -1);
  ok('首页包含管理后台容器', idxText.indexOf('id="adminMask"') > -1);
  ok('viewport 已设置（移动端自适应）', /name="viewport"[^>]*width=device-width/.test(idxText));

  for (const p of ['/assets/nav.css', '/assets/nav.js', '/assets/admin.css', '/assets/admin.js']) {
    const r = await fetch(BASE + p);
    const t = await r.text();
    ok('资源 ' + p + ' 可访问且非空', r.status === 200 && t.length > 500, 'status=' + r.status + ' len=' + t.length);
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(46));
console.log('  通过：' + pass + '    失败：' + fail + '    总计：' + (pass + fail));
console.log('='.repeat(46) + '\n');
process.exit(fail > 0 ? 1 : 0);
