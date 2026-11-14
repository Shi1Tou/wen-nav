/* ============================================================
 * NavBox 管理后台
 * 登录 / 书签管理 / 分组排序 / 外观背景 / 导入导出 / WebDAV 备份 / 账号设置
 * ============================================================ */
(function () {
  'use strict';

  const API = {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    check: '/api/auth/check',
    account: '/api/auth/account',
    data: '/api/admin/data',
    link: '/api/admin/link',
    group: '/api/admin/group',
    settings: '/api/admin/settings',
    background: '/api/admin/background',
    importData: '/api/admin/import',
    exportData: '/api/export',
    webdav: '/api/admin/webdav',
    linkCheck: '/api/admin/linkcheck'
  };

  /* ---------------- 状态 ---------------- */
  const S = {
    isAdmin: false,
    username: null,
    data: null,          // 后台完整数据
    tab: 'links',
    filter: '',
    busy: false,
    iconTypeDraft: 'auto',
    uploadDataUrl: null
  };

  /* ---------------- 工具 ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, type, ms) {
    if (window.NavBox && window.NavBox.toast) return window.NavBox.toast(msg, type, ms);
    alert(msg);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return String(iso); }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  async function api(path, opts) {
    const o = opts || {};
    const init = {
      method: o.method || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (o.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data || { ok: true };
  }

  function confirmBox(message) {
    return window.confirm(message);
  }

  function busy(on) {
    S.busy = !!on;
    $$('.btn[data-busy-guard]').forEach(b => { b.disabled = !!on; });
  }

  function withBusy(btn, fn) {
    return async function (ev) {
      if (S.busy) return;
      if (ev) ev.preventDefault();
      const old = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span> 处理中…'; }
      busy(true);
      try {
        await fn(ev);
      } catch (e) {
        toast(e.message || String(e), 'err', 4200);
      } finally {
        busy(false);
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
      }
    };
  }

  /* ---------------- 图标渲染 ---------------- */
  function domainOf(url) {
    try { return new URL(url, location.origin).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
  }
  function textIconStyle(seed) {
    const palette = [['#5b8cff','#7c5bff'],['#ff7a59','#ff4f81'],['#22c1a4','#0ea5a4'],
      ['#f6a623','#f2762e'],['#8b5cf6','#c026d3'],['#06b6d4','#3b82f6'],
      ['#ef4444','#f97316'],['#10b981','#84cc16'],['#6366f1','#0ea5e9'],['#ec4899','#f43f5e']];
    let h = 0; const s = String(seed || 'x');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const p = palette[h % palette.length];
    return 'background:linear-gradient(135deg,' + p[0] + ',' + p[1] + ')';
  }
  function firstChar(t) {
    const s = String(t || '').trim();
    if (!s) return '?';
    return /[\u4e00-\u9fa5]/.test(s[0]) ? s[0] : s[0].toUpperCase();
  }
  function providerUrl(provider, domain) {
    if (!domain) return '';
    switch (provider) {
      case 'icon.horse': return 'https://icon.horse/icon/' + encodeURIComponent(domain);
      case 'google': return 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=64&url=' + encodeURIComponent('https://' + domain);
      case 'direct': return 'https://' + domain + '/favicon.ico';
      default: return 'https://favicon.im/' + encodeURIComponent(domain) + '?larger=true';
    }
  }
  function iconCandidates(link) {
    const out = [];
    const domain = domainOf(link.url);
    const provider = (S.data && S.data.settings && S.data.settings.favicon && S.data.settings.favicon.provider) || 'favicon.im';
    if (link.icon && (link.iconType === 'custom' || provider === 'custom')) out.push(link.icon);
    const p = providerUrl(provider, domain);
    if (p) out.push(p);
    ['favicon.im','icon.horse','google','direct'].forEach(x => {
      if (x !== provider) { const u = providerUrl(x, domain); if (u && out.indexOf(u) === -1) out.push(u); }
    });
    return out;
  }
  /** 返回一个 DOM 节点作为图标（带回退） */
  function buildIconNode(link, size) {
    const box = document.createElement('div');
    box.className = 'li-icon';
    if (size) { box.style.flex = '0 0 ' + size + 'px'; box.style.width = size + 'px'; box.style.height = size + 'px'; }
    const domain = domainOf(link.url);
    const showText = () => {
      box.innerHTML = '';
      const sp = document.createElement('span');
      sp.className = 'txt';
      sp.textContent = firstChar(link.title || domain);
      sp.setAttribute('style', textIconStyle(domain || link.title));
      box.appendChild(sp);
    };
    if (link.iconType === 'text') { showText(); return box; }
    const cands = iconCandidates(link);
    if (!cands.length) { showText(); return box; }
    let i = 0;
    const next = () => {
      if (i >= cands.length) return showText();
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.onload = () => {
        if (img.naturalWidth <= 1) return next();
        box.innerHTML = ''; box.appendChild(img);
      };
      img.onerror = next;
      img.src = cands[i++];
    };
    next();
    return box;
  }

  /* ---------------- 二级弹窗 ---------------- */
  function openSub(title, bodyHtml, footHtml) {
    closeSub();
    const mask = document.createElement('div');
    mask.className = 'sub-modal';
    mask.innerHTML =
      '<div class="sub-panel">' +
        '<div class="sub-head"><span>' + esc(title) + '</span>' +
          '<button class="mini-btn sub-close" type="button" aria-label="关闭">✕</button></div>' +
        '<div class="sub-body">' + bodyHtml + '</div>' +
        (footHtml ? '<div class="sub-foot">' + footHtml + '</div>' : '') +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask) closeSub(); });
    $('.sub-close', mask).addEventListener('click', closeSub);
    return mask;
  }
  function closeSub() {
    $$('.sub-modal').forEach(m => m.remove());
  }

  /* ============================================================
   * 打开 / 关闭
   * ============================================================ */
  function open() {
    const mask = $('#adminMask');
    mask.hidden = false;
    document.body.style.overflow = 'hidden';
    if (S.isAdmin) {
      renderShell();
      loadAdminData();
    } else {
      renderLogin();
    }
  }

  function close() {
    const mask = $('#adminMask');
    if (!mask) return;
    mask.hidden = true;
    document.body.style.overflow = '';
    closeSub();
    $('#adminBody').innerHTML = '';
  }

  function syncAuth(isAdmin, username) {
    S.isAdmin = !!isAdmin;
    S.username = username || null;
    const mask = $('#adminMask');
    if (mask && !mask.hidden) {
      if (S.isAdmin && !S.data) loadAdminData();
      else if (!S.isAdmin) renderLogin();
    }
  }

  /* ============================================================
   * 登录
   * ============================================================ */
  function renderLogin() {
    $('#adminHeadText').textContent = '管理员登录';
    $('#adminBody').innerHTML =
      '<div class="login-box">' +
        '<div class="logo">N</div>' +
        '<h2>管理后台</h2>' +
        '<p class="sub">登录后可管理书签、分组与站点外观</p>' +
        '<div class="login-err" id="loginErr" hidden></div>' +
        '<form id="loginForm" autocomplete="on">' +
          '<div class="field">' +
            '<label for="lgUser">用户名</label>' +
            '<input class="input" id="lgUser" name="username" autocomplete="username" required maxlength="32" placeholder="admin">' +
          '</div>' +
          '<div class="field">' +
            '<label for="lgPass">密码</label>' +
            '<input class="input" id="lgPass" name="password" type="password" autocomplete="current-password" required placeholder="••••••••">' +
          '</div>' +
          '<button class="btn btn-primary btn-block" type="submit" id="lgBtn">登 录</button>' +
        '</form>' +
        '<div class="notice info" style="margin-top:20px">' +
          '首次部署后默认账号为 <code>admin</code> / <code>admin123</code>，' +
          '<b>请立即在「账号安全」中修改密码</b>。' +
        '</div>' +
      '</div>';

    const form = $('#loginForm');
    const errBox = $('#loginErr');
    form.addEventListener('submit', withBusy($('#lgBtn'), async () => {
      errBox.hidden = true;
      try {
        const res = await api(API.login, {
          method: 'POST',
          body: { username: $('#lgUser').value.trim(), password: $('#lgPass').value }
        });
        S.isAdmin = true;
        S.username = res.username || $('#lgUser').value.trim();
        // 必须先同步 nav.js 的登录状态再刷新入口：
        // refreshAdminEntry() 读取的是 nav.js 的 state.isAdmin（登录前为 false），
        // 若不同步，它会通过 syncAuth(false) 把刚置位的登录态打回，
        // 待 loadAdminData 返回后再次触发 syncAuth(false)，界面被踢回登录页
        if (window.NavBox) {
          if (window.NavBox.state) {
            window.NavBox.state.isAdmin = true;
            window.NavBox.state.username = S.username;
          }
          window.NavBox.refreshAdminEntry();
        }
        toast('登录成功', 'ok', 1600);
        $('#adminHeadText').textContent = '管理后台';
        renderShell();
        loadAdminData();
      } catch (e) {
        errBox.hidden = false;
        errBox.textContent = e.message || '登录失败';
      }
    }));
    setTimeout(() => { const u = $('#lgUser'); if (u) u.focus(); }, 60);
  }

  /* ============================================================
   * 外壳与标签
   * ============================================================ */
  const TABS = [
    { id: 'links', name: '书签', ico: '🔖' },
    { id: 'groups', name: '分组', ico: '🗂️' },
    { id: 'settings', name: '设置', ico: '🧰' },
    { id: 'style', name: '外观', ico: '🎨' },
    { id: 'transfer', name: '导入导出', ico: '🔄' },
    { id: 'backup', name: '备份', ico: '☁️' },
    { id: 'account', name: '账号', ico: '🔐' }
  ];

  function renderShell() {
    $('#adminHeadText').textContent = '管理后台 · ' + (S.username || 'admin');
    $('#adminBody').innerHTML =
      '<div class="admin-tabs" id="adminTabs">' +
        TABS.map(t => '<button class="tab-btn" data-tab="' + t.id + '" type="button">' +
          '<span>' + t.ico + '</span> ' + esc(t.name) + '</button>').join('') +
        '<button class="tab-btn" data-act="logout" type="button" style="margin-left:auto;color:#c23b32">退出</button>' +
      '</div>' +
      '<div id="tabHost"></div>';

    $('#adminTabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      if (btn.dataset.act === 'logout') { doLogout(); return; }
      switchTab(btn.dataset.tab);
    });
    switchTab(S.tab);
  }

  function switchTab(id) {
    S.tab = id;
    $$('#adminTabs .tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    const host = $('#tabHost');
    host.innerHTML = '<div class="tab-panel"><div class="empty-list"><span class="spinner-sm spinner-dark"></span></div></div>';
    switch (id) {
      case 'links': renderLinksTab(); break;
      case 'groups': renderGroupsTab(); break;
      case 'settings': renderSettingsTab(); break;
      case 'style': renderStyleTab(); break;
      case 'transfer': renderTransferTab(); break;
      case 'backup': renderBackupTab(); break;
      case 'account': renderAccountTab(); break;
      default: renderLinksTab();
    }
  }

  let adminDataInFlight = false;
  async function loadAdminData(silent) {
    // 防止登录流程与 syncAuth 同时触发造成并发重复请求
    if (adminDataInFlight) return;
    adminDataInFlight = true;
    try {
      const data = await api(API.data);
      S.data = data;
      if (!silent) toast('已加载最新数据', 'ok', 1200);
      // 若当前已渲染，刷新对应标签
      if ($('#tabHost')) switchTab(S.tab);
      syncFront();
    } catch (e) {
      if (e.status === 401) {
        S.isAdmin = false;
        S.data = null;
        S.username = null;
        // 同步清理 nav.js 的登录状态：否则 refreshAdminEntry 会把它的旧状态
        // （isAdmin=true）回填给 syncAuth，再次触发 loadAdminData 形成 401 循环
        if (window.NavBox) {
          if (window.NavBox.state) {
            window.NavBox.state.isAdmin = false;
            window.NavBox.state.username = null;
          }
          window.NavBox.refreshAdminEntry();
        }
        renderLogin();
        toast('登录已过期，请重新登录', 'err');
        return;
      }
      $('#tabHost').innerHTML =
        '<div class="tab-panel"><div class="notice warn">' + esc(e.message || '加载失败') + '</div></div>';
    } finally {
      adminDataInFlight = false;
    }
  }

  function syncFront() {
    if (!window.NavBox || !S.data) return;
    const visible = S.isAdmin
      ? S.data.links
      : S.data.links.filter(l => l.visibility !== 'private');
    window.NavBox.patch({
      settings: S.data.settings,
      groups: S.data.groups,
      links: visible,
      background: S.data.background || null,
      isAdmin: S.isAdmin,
      username: S.username
    });
  }

  async function doLogout() {
    if (!confirmBox('确定退出登录？')) return;
    try { await api(API.logout, { method: 'POST', body: {} }); } catch (e) {}
    S.isAdmin = false;
    S.data = null;
    S.username = null;
    if (window.NavBox) {
      // 先清 nav.js 的登录状态，避免 refreshAdminEntry 把旧的 true 回填给
      // syncAuth，导致退出过程中再发起一次注定 401 的数据请求
      if (window.NavBox.state) {
        window.NavBox.state.isAdmin = false;
        window.NavBox.state.username = null;
      }
      window.NavBox.refreshAdminEntry();
      window.NavBox.reload(true);
    }
    renderLogin();
    toast('已退出登录', 'ok', 1600);
  }

  /* ============================================================
   * 标签页 1：书签管理
   * ============================================================ */
  function renderLinksTab() {
    const d = S.data;
    if (!d) return;
    const groups = (d.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const gname = id => { const g = groups.find(x => x.id === id); return g ? g.name : '未分组'; };

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar">' +
        '<h3>🔖 书签管理</h3><div class="spacer"></div>' +
        '<span class="badge badge-gray" id="lnkCount">' + (d.links || []).length + ' 个书签</span>' +
        '<button class="btn btn-primary btn-sm" id="addLink" type="button">＋ 新建书签</button>' +
      '</div>' +
      '<div class="list-toolbar">' +
        '<input class="search-mini" id="lnkFilter" placeholder="筛选标题 / 网址 / 描述…" value="' + esc(S.filter) + '">' +
        '<select class="select" id="lnkGroupFilter" style="flex:0 0 auto;width:auto;min-width:120px">' +
          '<option value="">全部分组</option>' +
          groups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('') +
          '<option value="__none__">未分组</option>' +
        '</select>' +
        '<select class="select" id="lnkVisFilter" style="flex:0 0 auto;width:auto;min-width:110px">' +
          '<option value="">全部可见性</option><option value="public">仅公开</option><option value="private">仅私密</option>' +
        '</select>' +
      '</div>' +
      '<div class="notice info" style="font-size:12px">拖动左侧 ⠿ 手柄可调整顺序，顺序会保存到云端；也可用 ↑↓ 按钮微调。</div>' +
      '<div class="data-list" id="lnkList"></div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    const listEl = $('#lnkList');

    function drawList() {
      const q = S.filter.trim().toLowerCase();
      const gf = $('#lnkGroupFilter').value;
      const vf = $('#lnkVisFilter').value;
      let items = (d.links || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      if (gf === '__none__') items = items.filter(l => !groups.some(g => g.id === l.groupId));
      else if (gf) items = items.filter(l => l.groupId === gf);
      if (vf) items = items.filter(l => l.visibility === vf);
      if (q) {
        items = items.filter(l =>
          (l.title || '').toLowerCase().indexOf(q) > -1 ||
          (l.url || '').toLowerCase().indexOf(q) > -1 ||
          (l.desc || '').toLowerCase().indexOf(q) > -1);
      }
      $('#lnkCount').textContent = items.length + ' 个书签';

      if (items.length === 0) {
        listEl.innerHTML = '<div class="empty-list"><div class="big">🔖</div>' +
          (q || gf || vf ? '没有符合条件的书签' : '还没有书签，点击右上角「＋ 新建书签」开始添加') + '</div>';
        return;
      }

      listEl.innerHTML = '';
      items.forEach((l, i) => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.draggable = true;
        row.dataset.id = l.id;
        row.dataset.index = i;

        const grip = document.createElement('span');
        grip.className = 'li-grip';
        grip.textContent = '⠿';
        grip.title = '拖动排序';
        row.appendChild(grip);
        row.appendChild(buildIconNode(l, 34));

        const main = document.createElement('div');
        main.className = 'li-main';
        main.innerHTML =
          '<div class="li-title">' + esc(l.title) + ' ' +
            (l.visibility === 'private' ? '<span class="badge badge-priv">私密</span>' : '<span class="badge badge-pub">公开</span>') +
            (l.iconType === 'custom' ? ' <span class="badge badge-blue">自定义图标</span>' : '') +
            (l.iconType === 'text' ? ' <span class="badge badge-gray">文字图标</span>' : '') +
          '</div>' +
          '<div class="li-meta"><span>' + esc(l.url) + '</span><span class="badge badge-gray">' + esc(gname(l.groupId)) + '</span>' +
          (l.clicks ? '<span>点击 ' + l.clicks + '</span>' : '') + '</div>';
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 'li-actions';
        acts.innerHTML =
          '<button class="mini-btn up" type="button" title="上移">↑</button>' +
          '<button class="mini-btn down" type="button" title="下移">↓</button>' +
          '<button class="mini-btn" type="button" data-act="edit" title="编辑">✎</button>' +
          '<button class="mini-btn danger" type="button" data-act="del" title="删除">🗑</button>';
        row.appendChild(acts);

        acts.addEventListener('click', e => {
          const b = e.target.closest('button');
          if (!b) return;
          const act = b.dataset.act;
          if (act === 'edit') editLink(l);
          else if (act === 'del') delLink(l);
          else if (b.classList.contains('up') || b.classList.contains('down')) {
            moveLink(items, i, b.classList.contains('up') ? -1 : 1);
          }
        });

        // 拖拽排序
        row.addEventListener('dragstart', e => {
          dragId = l.id;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', l.id); } catch (err) {}
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          $$('.list-item', listEl).forEach(x => x.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('drag-over');
          const targetId = l.id;
          if (!dragId || dragId === targetId) return;
          reorderByIds(items, dragId, targetId);
        });

        listEl.appendChild(row);
      });
    }

    let dragId = null;

    function moveLink(items, index, delta) {
      const target = index + delta;
      if (target < 0 || target >= items.length) return;
      const copy = items.slice();
      const [m] = copy.splice(index, 1);
      copy.splice(target, 0, m);
      persistOrder(copy);
    }

    function reorderByIds(items, srcId, dstId) {
      const copy = items.slice();
      const si = copy.findIndex(x => x.id === srcId);
      const di = copy.findIndex(x => x.id === dstId);
      if (si < 0 || di < 0) return;
      const [m] = copy.splice(si, 1);
      copy.splice(di, 0, m);
      persistOrder(copy);
    }

    async function persistOrder(orderedItems) {
      // 将当前可见顺序写回 order；未显示的项保留原相对顺序并排在后面
      const shownIds = orderedItems.map(x => x.id);
      const hidden = (d.links || []).filter(l => shownIds.indexOf(l.id) === -1)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const finalList = orderedItems.concat(hidden).map((l, i) => ({ ...l, order: i + 1 }));
      d.links = finalList;
      drawList();
      syncFront();
      try {
        await api(API.link, {
          method: 'POST',
          body: { action: 'reorder', orders: finalList.map(l => ({ id: l.id, order: l.order, groupId: l.groupId })) }
        });
        toast('排序已保存', 'ok', 1200);
      } catch (e) {
        toast('排序保存失败：' + e.message, 'err');
        loadAdminData(true);
      }
    }

    /* -------- 新建 / 编辑书签 -------- */
    function editLink(link) {
      const isNew = !link;
      const l = link || { title: '', url: '', desc: '', icon: '', iconType: 'auto', visibility: 'public', groupId: '' };
      const groupsOpt = (d.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

      const body =
        '<div class="field"><label>名称<span class="req">*</span></label>' +
          '<input class="input" id="fTitle" maxlength="80" value="' + esc(l.title) + '" placeholder="例如：GitHub"></div>' +
        '<div class="field"><label>网址<span class="req">*</span></label>' +
          '<input class="input mono" id="fUrl" maxlength="2000" value="' + esc(l.url) + '" placeholder="https://example.com"></div>' +
        '<div class="field"><label>描述</label>' +
          '<input class="input" id="fDesc" maxlength="300" value="' + esc(l.desc) + '" placeholder="一句话说明这个网站（可留空）"></div>' +
        '<div class="row2">' +
          '<div class="field"><label>所属分组</label><select class="select" id="fGroup">' +
            '<option value="">未分组</option>' +
            groupsOpt.map(g => '<option value="' + esc(g.id) + '"' + (g.id === l.groupId ? ' selected' : '') + '>' +
              esc((g.icon ? g.icon + ' ' : '') + g.name) + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>可见性</label><select class="select" id="fVis">' +
            '<option value="public"' + (l.visibility !== 'private' ? ' selected' : '') + '>公开（所有人可见）</option>' +
            '<option value="private"' + (l.visibility === 'private' ? ' selected' : '') + '>私密（仅管理员登录后可见）</option>' +
          '</select></div>' +
        '</div>' +
        '<hr class="divider">' +
        '<div class="field"><label>图标方式</label>' +
          '<div class="icon-picker">' +
            '<div class="icon-preview" id="iconPrev"></div>' +
            '<select class="select" id="fIconType" style="flex:0 0 auto;width:auto;min-width:132px">' +
              '<option value="auto"' + (l.iconType !== 'custom' && l.iconType !== 'text' ? ' selected' : '') + '>自动抓取网站图标</option>' +
              '<option value="custom"' + (l.iconType === 'custom' ? ' selected' : '') + '>自定义图标地址</option>' +
              '<option value="text"' + (l.iconType === 'text' ? ' selected' : '') + '>显示名称首字</option>' +
            '</select>' +
          '</div>' +
          '<div class="field-hint" id="iconHint"></div>' +
        '</div>' +
        '<div class="field" id="iconUrlField"><label>自定义图标地址</label>' +
          '<input class="input mono" id="fIcon" maxlength="5000" value="' + esc(l.icon) + '" placeholder="https://…/logo.png，或直接粘贴 data:image/png;base64,…">' +
          '<div class="field-hint">支持图床直链或本地上传（上传会压缩后以 base64 内嵌保存）。</div>' +
          '<div class="btn-group"><label class="btn btn-ghost btn-sm" for="iconFile" style="cursor:pointer">📤 上传本地图标</label>' +
          '<input type="file" id="iconFile" accept="image/*" hidden></div>' +
        '</div>';

      const foot =
        '<button class="btn btn-ghost" type="button" id="subCancel">取消</button>' +
        '<button class="btn btn-primary" type="button" id="subSave">' + (isNew ? '创建书签' : '保存修改') + '</button>';

      const mask = openSub(isNew ? '新建书签' : '编辑书签', body, foot);

      const typeSel = $('#fIconType', mask);
      const iconInput = $('#fIcon', mask);
      const urlInput = $('#fUrl', mask);
      const titleInput = $('#fTitle', mask);
      const prev = $('#iconPrev', mask);
      const hint = $('#iconHint', mask);
      const iconField = $('#iconUrlField', mask);

      function refreshPreview() {
        const type = typeSel.value;
        iconField.style.display = type === 'custom' ? '' : 'none';
        const fake = {
          url: urlInput.value || 'https://example.com',
          title: titleInput.value || '',
          icon: iconInput.value,
          iconType: type
        };
        const node = buildIconNode(fake, 42);
        node.className = 'icon-preview';
        node.style.cssText = 'width:42px;height:42px;flex:0 0 42px;border-radius:10px;border:1px solid #e3e7f0;overflow:hidden;background:#fff;display:grid;place-items:center';
        prev.replaceWith(node);
        node.id = 'iconPrev';
        const map = {
          auto: '自动抓取该网址的网站图标；抓取失败时自动回退到其它图标源，全部失败则显示名称首字。',
          custom: '使用你填写的图标地址；留空则回退到自动抓取。',
          text: '不加载网络图标，直接用名称首字生成彩色文字图标（加载最快，适合内网站点）。'
        };
        hint.textContent = map[type] || '';
      }

      typeSel.addEventListener('change', refreshPreview);
      iconInput.addEventListener('input', debounce(refreshPreview, 400));
      urlInput.addEventListener('input', debounce(refreshPreview, 400));
      titleInput.addEventListener('input', debounce(refreshPreview, 400));
      $('#iconFile', mask).addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const dataUrl = await compressImage(f, 128, 0.9);
          iconInput.value = dataUrl;
          typeSel.value = 'custom';
          refreshPreview();
          toast('图标已内嵌（' + fmtBytes(dataUrl.length) + '）', 'ok', 2000);
        } catch (err) {
          toast('图片处理失败：' + err.message, 'err');
        }
      });
      $('#subCancel', mask).addEventListener('click', closeSub);
      refreshPreview();

      $('#subSave', mask).addEventListener('click', withBusy($('#subSave', mask), async () => {
        const title = titleInput.value.trim();
        const url = urlInput.value.trim();
        if (!url) { toast('请填写网址', 'err'); return; }
        const payload = {
          title: title || domainOf(url) || url,
          url: url,
          desc: $('#fDesc', mask).value.trim(),
          groupId: $('#fGroup', mask).value,
          visibility: $('#fVis', mask).value === 'private' ? 'private' : 'public',
          iconType: typeSel.value,
          icon: typeSel.value === 'custom' ? iconInput.value.trim() : ''
        };
        let res;
        if (isNew) {
          res = await api(API.link, { method: 'POST', body: { action: 'create', link: payload } });
        } else {
          res = await api(API.link, { method: 'POST', body: { action: 'update', id: l.id, link: payload } });
        }
        closeSub();
        if (isNew) {
          d.links.push(res.link);
        } else {
          const idx = d.links.findIndex(x => x.id === l.id);
          if (idx > -1) d.links[idx] = res.link;
        }
        drawList();
        syncFront();
        toast(isNew ? '书签已创建' : '书签已保存', 'ok', 1600);
      }));

      setTimeout(() => titleInput.focus(), 60);
    }

    async function delLink(l) {
      if (!confirmBox('确定删除书签「' + l.title + '」？此操作不可撤销。')) return;
      try {
        await api(API.link, { method: 'POST', body: { action: 'delete', id: l.id } });
        d.links = d.links.filter(x => x.id !== l.id);
        drawList();
        syncFront();
        toast('已删除', 'ok', 1400);
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
      }
    }

    $('#addLink').addEventListener('click', () => editLink(null));
    $('#lnkFilter').addEventListener('input', debounce(e => { S.filter = e.target.value; drawList(); }, 160));
    $('#lnkGroupFilter').addEventListener('change', drawList);
    $('#lnkVisFilter').addEventListener('change', drawList);

    drawList();
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  /* ---------------- 图片压缩（用于内嵌 base64） ---------------- */
  function compressImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('请选择图片文件'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.onload = () => {
          try {
            const ms = maxSize || 512;
            let w = img.naturalWidth, h = img.naturalHeight;
            const scale = Math.min(1, ms / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const out = canvas.toDataURL('image/jpeg', quality || 0.85);
            resolve(out);
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ============================================================
   * 标签页 2：分组管理与排序
   * ============================================================ */
  function renderGroupsTab() {
    const d = S.data;
    if (!d) return;
    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar">' +
        '<h3>🗂️ 分组与排序</h3><div class="spacer"></div>' +
        '<button class="btn btn-primary btn-sm" id="addGroup" type="button">＋ 新建分组</button>' +
      '</div>' +
      '<div class="notice info" style="font-size:12px">分组顺序即前台展示顺序。拖动 ⠿ 或用 ↑↓ 调整，改动自动保存。</div>' +
      '<div class="data-list" id="grpList"></div>';
    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    const listEl = $('#grpList');
    let dragId = null;

    function countOf(gid) { return (d.links || []).filter(l => l.groupId === gid).length; }

    function draw() {
      const items = (d.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      if (items.length === 0) {
        listEl.innerHTML = '<div class="empty-list"><div class="big">🗂️</div>还没有分组，点击右上角新建</div>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach((g, i) => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.draggable = true;
        row.dataset.id = g.id;

        const grip = document.createElement('span');
        grip.className = 'li-grip';
        grip.textContent = '⠿';
        row.appendChild(grip);

        const ico = document.createElement('div');
        ico.className = 'li-icon';
        ico.style.cssText = 'font-size:17px;background:#f7f8fc';
        ico.textContent = g.icon || '📁';
        row.appendChild(ico);

        const main = document.createElement('div');
        main.className = 'li-main';
        main.innerHTML = '<div class="li-title">' + esc(g.name) + '</div>' +
          '<div class="li-meta"><span class="badge badge-blue">' + countOf(g.id) + ' 个书签</span>' +
          '<span>顺序 ' + (g.order || 0) + '</span></div>';
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 'li-actions';
        acts.innerHTML =
          '<button class="mini-btn up" type="button" title="上移">↑</button>' +
          '<button class="mini-btn down" type="button" title="下移">↓</button>' +
          '<button class="mini-btn" type="button" data-act="edit" title="编辑">✎</button>' +
          '<button class="mini-btn danger" type="button" data-act="del" title="删除">🗑</button>';
        row.appendChild(acts);

        acts.addEventListener('click', e => {
          const b = e.target.closest('button');
          if (!b) return;
          const act = b.dataset.act;
          if (act === 'edit') editGroup(g);
          else if (act === 'del') delGroup(g);
          else {
            const delta = b.classList.contains('up') ? -1 : 1;
            const t = i + delta;
            if (t < 0 || t >= items.length) return;
            const copy = items.slice();
            const [m] = copy.splice(i, 1);
            copy.splice(t, 0, m);
            persist(copy);
          }
        });

        row.addEventListener('dragstart', e => {
          dragId = g.id; row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', g.id); } catch (err) {}
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          $$('.list-item', listEl).forEach(x => x.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('drag-over');
          if (!dragId || dragId === g.id) return;
          const copy = items.slice();
          const si = copy.findIndex(x => x.id === dragId);
          const di = copy.findIndex(x => x.id === g.id);
          if (si < 0 || di < 0) return;
          const [m] = copy.splice(si, 1);
          copy.splice(di, 0, m);
          persist(copy);
        });

        listEl.appendChild(row);
      });
    }

    async function persist(ordered) {
      const next = ordered.map((g, i) => ({ ...g, order: i + 1 }));
      d.groups = next;
      draw();
      syncFront();
      try {
        await api(API.group, {
          method: 'POST',
          body: { action: 'reorder', orders: next.map(g => ({ id: g.id, order: g.order })) }
        });
        toast('分组顺序已保存', 'ok', 1200);
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        loadAdminData(true);
      }
    }

    function editGroup(g) {
      const isNew = !g;
      const v = g || { name: '', icon: '', order: (d.groups || []).length + 1 };
      const body =
        '<div class="field"><label>分组名称<span class="req">*</span></label>' +
          '<input class="input" id="gName" maxlength="40" value="' + esc(v.name) + '" placeholder="例如：常用工具"></div>' +
        '<div class="field"><label>分组图标</label>' +
          '<input class="input" id="gIcon" maxlength="8" value="' + esc(v.icon) + '" placeholder="可填 emoji，如 ⭐ 🛠️ 📚（留空则默认 📁）">' +
          '<div class="field-hint">建议使用单个 emoji 字符，显示效果最好。</div></div>' +
        '<div class="field"><label>显示顺序</label>' +
          '<input class="input" id="gOrder" type="number" min="0" step="1" value="' + (v.order || 0) + '">' +
          '<div class="field-hint">数字越小越靠前；也可以直接用列表里的拖动排序。</div></div>';
      const foot =
        '<button class="btn btn-ghost" type="button" id="subCancel">取消</button>' +
        '<button class="btn btn-primary" type="button" id="subSave">' + (isNew ? '创建分组' : '保存') + '</button>';
      const mask = openSub(isNew ? '新建分组' : '编辑分组', body, foot);
      $('#subCancel', mask).addEventListener('click', closeSub);
      $('#subSave', mask).addEventListener('click', withBusy($('#subSave', mask), async () => {
        const name = $('#gName', mask).value.trim();
        if (!name) { toast('请填写分组名称', 'err'); return; }
        const payload = { name: name, icon: $('#gIcon', mask).value.trim(), order: Number($('#gOrder', mask).value) || 0 };
        if (isNew) {
          const res = await api(API.group, { method: 'POST', body: { action: 'create', group: payload } });
          d.groups.push(res.group);
        } else {
          const res = await api(API.group, { method: 'POST', body: { action: 'update', id: g.id, group: payload } });
          const idx = d.groups.findIndex(x => x.id === g.id);
          if (idx > -1) d.groups[idx] = res.group;
        }
        closeSub();
        draw();
        syncFront();
        toast(isNew ? '分组已创建' : '分组已保存', 'ok', 1500);
      }));
      setTimeout(() => $('#gName', mask).focus(), 60);
    }

    async function delGroup(g) {
      const n = countOf(g.id);
      let force = false;
      if (n > 0) {
        const ok = confirmBox('分组「' + g.name + '」下还有 ' + n + ' 个书签。\n\n确定 = 连同这 ' + n + ' 个书签一起删除\n取消 = 放弃删除\n\n（如只想删分组、保留书签，请先将书签移到其它分组）');
        if (!ok) return;
        force = true;
      } else if (!confirmBox('确定删除分组「' + g.name + '」？')) {
        return;
      }
      try {
        await api(API.group, { method: 'POST', body: { action: 'delete', id: g.id, force: force } });
        d.groups = d.groups.filter(x => x.id !== g.id);
        if (force) d.links = d.links.filter(l => l.groupId !== g.id);
        draw();
        syncFront();
        toast('分组已删除', 'ok', 1500);
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
      }
    }

    $('#addGroup').addEventListener('click', () => editGroup(null));
    draw();
  }

  /* ============================================================
   * 标签页：设置（死链检测 / 分组排序 / 批量可见性 / 书签大小）
   * ============================================================ */
  function renderSettingsTab() {
    const d = S.data;
    if (!d) return;

    const groups = () => (S.data.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const gname = id => { const g = (S.data.groups || []).find(x => x.id === id); return g ? g.name : '未分组'; };

    const STATE_LABEL = { alive: '正常', dead: '死链', blocked: '受限', error: '错误', invalid: '无效' };
    const STATE_PILL = { alive: 'ok', dead: 'dead', blocked: 'warn', error: 'err', invalid: 'gray' };
    const STATE_ORDER = { dead: 0, error: 1, invalid: 2, blocked: 3, alive: 4 };

    const layout0 = (d.settings && d.settings.layout) || {};
    const SIZE_DEFAULTS = { minCardWidth: 168, gridGap: 14, iconSize: 38, cardPadding: 11, titleSize: 14, descSize: 11.5 };
    const sizeNum = k => {
      const v = Number(layout0[k]);
      return (layout0[k] != null && layout0[k] !== '' && isFinite(v)) ? v : SIZE_DEFAULTS[k];
    };

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar"><h3>🧰 设置</h3><div class="spacer"></div>' +
        '<span class="badge badge-gray" id="setCount">' + (d.links || []).length + ' 个书签 · ' +
        (d.groups || []).length + ' 个分组</span>' +
      '</div>' +

      /* ---------- 1. 死链检测 ---------- */
      '<div class="section-card">' +
        '<h3><span class="h-ico">🩺</span>死链检测</h3>' +
        '<div class="notice info" style="font-size:12px">' +
          '由服务器逐条请求书签地址（先 HEAD，不支持时回退 GET），每批最多 <b>10</b> 条、单条超时 <b>6 秒</b>。' +
          '返回 <code>401/403/429</code> 通常只是站点拒绝程序访问，会标记为「受限」而不是死链；' +
          '内网 / 本地地址出于安全考虑不参与检测。' +
        '</div>' +
        '<div class="stat-grid">' +
          '<div class="stat-card"><div class="num" id="lcNumTotal">0</div><div class="lbl">已检测</div></div>' +
          '<div class="stat-card"><div class="num" id="lcNumAlive" style="color:#12917a">0</div><div class="lbl">正常</div></div>' +
          '<div class="stat-card"><div class="num" id="lcNumDead" style="color:#c23b32">0</div><div class="lbl">死链</div></div>' +
          '<div class="stat-card"><div class="num" id="lcNumBlocked" style="color:#9a6410">0</div><div class="lbl">受限 / 错误</div></div>' +
        '</div>' +
        '<div class="row-inline" style="margin-bottom:12px">' +
          '<div class="field" style="flex:1 1 180px;min-width:150px"><label>检测范围</label>' +
            '<select class="select" id="lcScope">' +
              '<option value="all">全部书签</option>' +
              '<option value="public">仅公开书签</option>' +
              '<option value="private">仅私密书签</option>' +
            '</select></div>' +
          '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label>' +
            '<div class="btn-group" style="margin:0">' +
              '<button class="btn btn-primary btn-sm" id="lcStart" type="button">开始检测</button>' +
              '<button class="btn btn-ghost btn-sm" id="lcStop" type="button" disabled>停止</button>' +
            '</div></div>' +
        '</div>' +
        '<div id="lcProgressWrap" style="display:none;margin-bottom:12px">' +
          '<div class="progress"><i id="lcProgressBar"></i></div>' +
          '<div class="field-hint" id="lcProgressText"></div>' +
        '</div>' +
        '<div class="list-toolbar" style="margin-bottom:8px">' +
          '<div class="seg" id="lcFilter">' +
            '<button class="seg-btn active" type="button" data-lc-filter="all">全部</button>' +
            '<button class="seg-btn" type="button" data-lc-filter="dead">死链</button>' +
            '<button class="seg-btn" type="button" data-lc-filter="blocked">受限</button>' +
            '<button class="seg-btn" type="button" data-lc-filter="alive">正常</button>' +
          '</div>' +
          '<div class="spacer"></div>' +
          '<button class="btn btn-ghost btn-sm" id="lcSelectDead" type="button">全选死链</button>' +
          '<button class="btn btn-danger btn-sm" id="lcDel" type="button">删除选中</button>' +
        '</div>' +
        '<div id="lcList" class="bulk-list"></div>' +
        '<div class="field-hint" id="lcSavedAt"></div>' +
      '</div>' +

      /* ---------- 2. 分组排序 ---------- */
      '<div class="section-card">' +
        '<h3><span class="h-ico">🗂️</span>分组排序调整</h3>' +
        '<div class="notice info" style="font-size:12px">' +
          '前台按这里的顺序展示分组。拖动 ⠿、点 ↑↓ 或置顶 / 置底都会<b>立即保存</b>；也可以用下面的预设一键重排。' +
        '</div>' +
        '<div class="btn-group" style="margin-bottom:12px">' +
          '<button class="btn btn-ghost btn-sm" id="gsByName" type="button">按名称 A→Z</button>' +
          '<button class="btn btn-ghost btn-sm" id="gsByCount" type="button">按书签数从多到少</button>' +
          '<button class="btn btn-ghost btn-sm" id="gsRenumber" type="button">按当前顺序重新编号</button>' +
        '</div>' +
        '<div class="data-list" id="gsList"></div>' +
      '</div>' +

      /* ---------- 3. 私密 / 公开批量设置 ---------- */
      '<div class="section-card">' +
        '<h3><span class="h-ico">🔐</span>私密 / 公开批量设置</h3>' +
        '<div class="notice info" style="font-size:12px">' +
          '勾选书签后一键设为私密或公开。私密书签只对已登录管理员可见，' +
          '未登录访客从 <code>/api/bootstrap</code> 拿不到数据，不依赖前端隐藏。' +
        '</div>' +
        '<div class="list-toolbar">' +
          '<input class="search-mini" id="bvFilter" placeholder="筛选标题 / 网址 / 描述…">' +
          '<select class="select" id="bvGroup" style="flex:0 0 auto;width:auto;min-width:120px">' +
            '<option value="">全部分组</option>' +
            '<option value="__none__">未分组</option>' +
            groups().map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('') +
          '</select>' +
          '<select class="select" id="bvVis" style="flex:0 0 auto;width:auto;min-width:110px">' +
            '<option value="">全部可见性</option><option value="public">仅公开</option><option value="private">仅私密</option>' +
          '</select>' +
        '</div>' +
        '<div class="list-toolbar">' +
          '<label class="chk-inline"><input type="checkbox" id="bvAll"> 全选当前列表</label>' +
          '<span class="badge badge-blue" id="bvSelCount">已选 0 个</span>' +
          '<div class="spacer"></div>' +
          '<button class="btn btn-soft btn-sm" id="bvPublic" type="button">设为公开</button>' +
          '<button class="btn btn-soft btn-sm" id="bvPrivate" type="button">设为私密</button>' +
        '</div>' +
        '<div id="bvList" class="bulk-list"></div>' +
      '</div>' +

      /* ---------- 4. 书签大小 ---------- */
      '<div class="section-card">' +
        '<h3><span class="h-ico">📏</span>书签大小调整</h3>' +
        '<div class="notice info" style="font-size:12px">' +
          '拖动滑杆可实时预览到前台页面（只重算样式，不会重新加载图标）。满意后点「保存大小设置」。' +
        '</div>' +
        '<div class="btn-group" style="margin-bottom:14px" id="sizePresets">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-size-preset="compact">紧凑</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-size-preset="standard">标准</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-size-preset="large">大</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-size-preset="xlarge">超大</button>' +
        '</div>' +
        '<div class="size-preview" id="sizePrev"></div>' +
        '<div class="row2">' +
          '<div class="field"><label>卡片最小宽度</label>' +
            '<div class="range-row"><input type="range" id="szMinW" min="110" max="420" step="2" value="' + sizeNum('minCardWidth') + '"><span class="range-val" id="vSzMinW"></span></div>' +
            '<div class="field-hint">越小每行卡片越多。</div></div>' +
          '<div class="field"><label>卡片间距</label>' +
            '<div class="range-row"><input type="range" id="szGap" min="6" max="30" step="1" value="' + sizeNum('gridGap') + '"><span class="range-val" id="vSzGap"></span></div></div>' +
        '</div>' +
        '<div class="row2">' +
          '<div class="field"><label>图标尺寸</label>' +
            '<div class="range-row"><input type="range" id="szIcon" min="20" max="64" step="1" value="' + sizeNum('iconSize') + '"><span class="range-val" id="vSzIcon"></span></div></div>' +
          '<div class="field"><label>卡片内边距</label>' +
            '<div class="range-row"><input type="range" id="szPad" min="4" max="24" step="1" value="' + sizeNum('cardPadding') + '"><span class="range-val" id="vSzPad"></span></div></div>' +
        '</div>' +
        '<div class="row2">' +
          '<div class="field"><label>标题字号</label>' +
            '<div class="range-row"><input type="range" id="szTitle" min="10" max="22" step="0.5" value="' + sizeNum('titleSize') + '"><span class="range-val" id="vSzTitle"></span></div></div>' +
          '<div class="field"><label>描述字号</label>' +
            '<div class="range-row"><input type="range" id="szDesc" min="9" max="18" step="0.5" value="' + sizeNum('descSize') + '"><span class="range-val" id="vSzDesc"></span></div></div>' +
        '</div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="szSave" type="button">保存大小设置</button>' +
          '<button class="btn btn-ghost btn-sm" id="szReset" type="button">恢复标准尺寸</button>' +
        '</div>' +
      '</div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    /* ============================================================
     * 1. 死链检测
     * ============================================================ */
    let lcResults = (d.linkCheck && Array.isArray(d.linkCheck.items)) ? d.linkCheck.items.slice() : [];
    let lcFilter = 'all';
    let lcRunning = false;
    let lcAbort = false;
    const lcSelected = new Set();
    const lcKey = x => (x && (x.id || x.url)) || '';

    function lcUpdateStats() {
      const count = s => lcResults.filter(x => x.state === s).length;
      $('#lcNumTotal').textContent = lcResults.length;
      $('#lcNumAlive').textContent = count('alive');
      $('#lcNumDead').textContent = count('dead');
      $('#lcNumBlocked').textContent = count('blocked') + count('error') + count('invalid');
      const savedAt = (S.data.linkCheck && S.data.linkCheck.at) || null;
      $('#lcSavedAt').textContent = savedAt ? ('上次检测完成：' + fmtTime(savedAt) +
        '（共 ' + (S.data.linkCheck.total || 0) + ' 条）') : '还没有检测记录，点「开始检测」运行一次。';
    }

    function lcVisible() {
      const list = lcResults.slice().sort((a, b) => {
        const sa = STATE_ORDER[a.state] == null ? 5 : STATE_ORDER[a.state];
        const sb = STATE_ORDER[b.state] == null ? 5 : STATE_ORDER[b.state];
        return sa - sb;
      });
      if (lcFilter === 'all') return list;
      if (lcFilter === 'blocked') return list.filter(x => x.state === 'blocked' || x.state === 'error' || x.state === 'invalid');
      return list.filter(x => x.state === lcFilter);
    }

    function lcDraw() {
      const host = $('#lcList');
      const items = lcVisible();
      if (!items.length) {
        host.innerHTML = '<div class="empty-list">' +
          (lcResults.length ? '当前筛选下没有记录' : '暂无检测结果') + '</div>';
        return;
      }
      host.innerHTML = items.map(x => {
        const key = lcKey(x);
        const st = x.state || 'error';
        return '<label class="check-row">' +
          '<input type="checkbox" data-lc-key="' + esc(key) + '"' + (lcSelected.has(key) ? ' checked' : '') + '>' +
          '<span class="pill ' + (STATE_PILL[st] || 'gray') + '">' + esc(STATE_LABEL[st] || st) + '</span>' +
          '<div class="cr-main"><div class="cr-title">' + esc(x.title || x.url || '（已删除）') + '</div>' +
            '<div class="cr-url">' + esc(x.url || '') + '</div>' +
            (x.error ? '<div class="cr-err">' + esc(x.error) + '</div>' : '') + '</div>' +
          '<span class="cr-status">' + (x.status ? 'HTTP ' + x.status : '') +
            (x.ms ? '<br><span style="color:#9aa1b3">' + x.ms + 'ms</span>' : '') + '</span>' +
        '</label>';
      }).join('');
    }

    function lcProgress(done, total) {
      const pct = total ? Math.round(done / total * 100) : 0;
      $('#lcProgressWrap').style.display = '';
      $('#lcProgressBar').style.width = pct + '%';
      $('#lcProgressText').textContent = '检测中… ' + done + ' / ' + total + '（' + pct + '%）';
    }

    async function lcRun() {
      if (lcRunning) return;
      const scope = $('#lcScope').value;
      const targets = (S.data.links || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .filter(l => scope === 'all' ? true : l.visibility === scope);
      if (!targets.length) { toast('当前范围内没有可检测的书签', 'err'); return; }
      if (targets.length > 500) {
        toast('单次最多检测 500 条，已按顺序取前 500 条', 'warn', 4000);
        targets.length = 500;
      }
      lcRunning = true;
      lcAbort = false;
      lcResults = [];
      lcSelected.clear();
      $('#lcStart').disabled = true;
      $('#lcScope').disabled = true;
      $('#lcStop').disabled = false;
      lcDraw();
      lcUpdateStats();

      const BATCH = 8;
      let done = 0;
      for (let i = 0; i < targets.length; i += BATCH) {
        if (lcAbort) break;
        const batch = targets.slice(i, i + BATCH);
        try {
          const res = await api(API.linkCheck, {
            method: 'POST',
            body: {
              action: 'check',
              links: batch.map(l => ({ id: l.id, title: l.title, url: l.url }))
            }
          });
          lcResults = lcResults.concat((res && res.results) || []);
        } catch (e) {
          lcResults = lcResults.concat(batch.map(l => ({
            id: l.id, title: l.title, url: l.url,
            state: 'error', status: 0, error: e.message || '检测失败', ms: 0
          })));
        }
        done += batch.length;
        lcProgress(done, targets.length);
        lcDraw();
        lcUpdateStats();
      }

      lcRunning = false;
      $('#lcStart').disabled = false;
      $('#lcScope').disabled = false;
      $('#lcStop').disabled = true;
      $('#lcProgressText').textContent = (lcAbort ? '已停止' : '检测完成') +
        '：共 ' + lcResults.length + ' 条；单条最长耗时约 ' + Math.max(1, Math.round(
          lcResults.reduce((s, x) => Math.max(s, Number(x.ms) || 0), 0) / 1000)) + ' 秒。';

      // 保存结果，供下次打开后台时回显
      try {
        const saved = await api(API.linkCheck, { method: 'POST', body: { action: 'save', items: lcResults } });
        S.data.linkCheck = saved.linkCheck;
      } catch (e) {
        toast('检测结果保存失败：' + e.message, 'err', 4200);
      }
      lcDraw();
      lcUpdateStats();
      const dead = lcResults.filter(x => x.state === 'dead').length;
      toast('检测完成：死链 ' + dead + ' 条 / 共 ' + lcResults.length + ' 条', dead ? 'warn' : 'ok', 3600);
    }

    async function lcDeleteSelected() {
      const ids = Array.from(lcSelected).filter(k => (S.data.links || []).some(l => l.id === k));
      if (!ids.length) { toast('请先勾选要删除的书签', 'err'); return; }
      if (!confirmBox('确定删除选中的 ' + ids.length + ' 个书签？此操作不可撤销。')) return;
      try {
        const res = await api(API.link, { method: 'POST', body: { action: 'delete', ids: ids } });
        S.data.links = (S.data.links || []).filter(l => ids.indexOf(l.id) === -1);
        lcResults = lcResults.filter(x => ids.indexOf(x.id) === -1);
        ids.forEach(id => lcSelected.delete(id));
        lcDraw();
        lcUpdateStats();
        $('#setCount').textContent = (S.data.links || []).length + ' 个书签 · ' + (S.data.groups || []).length + ' 个分组';
        bvDraw();
        syncFront();
        toast('已删除 ' + ((res && res.deleted) || ids.length) + ' 个书签', 'ok', 2400);
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
      }
    }

    $('#lcStart').addEventListener('click', withBusy($('#lcStart'), lcRun));
    $('#lcStop').addEventListener('click', () => {
      if (!lcRunning) return;
      lcAbort = true;
      $('#lcStop').disabled = true;
      $('#lcProgressText').textContent = '正在停止…（等待当前批次返回）';
    });
    $('#lcList').addEventListener('change', e => {
      const cb = e.target.closest('input[data-lc-key]');
      if (!cb) return;
      const key = cb.dataset.lcKey;
      if (cb.checked) lcSelected.add(key); else lcSelected.delete(key);
    });
    $('#lcFilter').addEventListener('click', e => {
      const b = e.target.closest('[data-lc-filter]');
      if (!b) return;
      lcFilter = b.dataset.lcFilter;
      $$('#lcFilter .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      lcDraw();
    });
    $('#lcSelectDead').addEventListener('click', () => {
      const dead = lcResults.filter(x => x.state === 'dead' || x.state === 'error');
      if (!dead.length) { toast('没有可选择的死链', 'err'); return; }
      dead.forEach(x => lcSelected.add(lcKey(x)));
      lcDraw();
      toast('已选中 ' + dead.length + ' 条死链 / 错误项', 'ok', 2200);
    });
    $('#lcDel').addEventListener('click', withBusy($('#lcDel'), lcDeleteSelected));

    /* ============================================================
     * 2. 分组排序调整
     * ============================================================ */
    let gsDragId = null;

    function gsCount(gid) { return (S.data.links || []).filter(l => l.groupId === gid).length; }

    function gsDraw() {
      const host = $('#gsList');
      const items = groups();
      if (!items.length) {
        host.innerHTML = '<div class="empty-list"><div class="big">🗂️</div>还没有分组</div>';
        return;
      }
      host.innerHTML = '';
      items.forEach((g, i) => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.draggable = true;
        row.dataset.id = g.id;

        const grip = document.createElement('span');
        grip.className = 'li-grip';
        grip.textContent = '⠿';
        grip.title = '拖动排序';
        row.appendChild(grip);

        const ico = document.createElement('div');
        ico.className = 'li-icon';
        ico.style.cssText = 'font-size:17px;background:#f7f8fc';
        ico.textContent = g.icon || '📁';
        row.appendChild(ico);

        const main = document.createElement('div');
        main.className = 'li-main';
        main.innerHTML = '<div class="li-title">' + esc(g.name) + '</div>' +
          '<div class="li-meta"><span class="badge badge-blue">' + gsCount(g.id) + ' 个书签</span>' +
          '<span>第 ' + (i + 1) + ' 位</span></div>';
        row.appendChild(main);

        const acts = document.createElement('div');
        acts.className = 'li-actions';
        acts.innerHTML =
          '<button class="mini-btn" data-move="top" type="button" title="置顶">⤒</button>' +
          '<button class="mini-btn" data-move="up" type="button" title="上移">↑</button>' +
          '<button class="mini-btn" data-move="down" type="button" title="下移">↓</button>' +
          '<button class="mini-btn" data-move="bottom" type="button" title="置底">⤓</button>';
        row.appendChild(acts);

        acts.addEventListener('click', e => {
          const b = e.target.closest('button[data-move]');
          if (!b) return;
          const list = groups();
          const idx = list.findIndex(x => x.id === g.id);
          if (idx < 0) return;
          let target = idx;
          const mv = b.dataset.move;
          if (mv === 'up') target = idx - 1;
          else if (mv === 'down') target = idx + 1;
          else if (mv === 'top') target = 0;
          else if (mv === 'bottom') target = list.length - 1;
          if (target === idx || target < 0 || target >= list.length) return;
          const copy = list.slice();
          const [m] = copy.splice(idx, 1);
          copy.splice(target, 0, m);
          gsPersist(copy);
        });

        row.addEventListener('dragstart', e => {
          gsDragId = g.id;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', g.id); } catch (err) {}
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          $$('.list-item', host).forEach(x => x.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('drag-over');
          if (!gsDragId || gsDragId === g.id) return;
          const list = groups();
          const si = list.findIndex(x => x.id === gsDragId);
          const di = list.findIndex(x => x.id === g.id);
          if (si < 0 || di < 0) return;
          const [m] = list.splice(si, 1);
          list.splice(di, 0, m);
          gsPersist(list);
        });

        host.appendChild(row);
      });
    }

    async function gsPersist(ordered) {
      const next = ordered.map((g, i) => ({ ...g, order: i + 1 }));
      S.data.groups = next;
      gsDraw();
      if (window.NavBox && window.NavBox.patch) window.NavBox.patch({ groups: next });
      try {
        await api(API.group, {
          method: 'POST',
          body: { action: 'reorder', orders: next.map(g => ({ id: g.id, order: g.order })) }
        });
        toast('分组顺序已保存', 'ok', 1200);
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        loadAdminData(true);
      }
    }

    $('#gsByName').addEventListener('click', withBusy($('#gsByName'), async () => {
      const list = groups().slice().sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
      await gsPersist(list);
    }));
    $('#gsByCount').addEventListener('click', withBusy($('#gsByCount'), async () => {
      const list = groups().slice().sort((a, b) => gsCount(b.id) - gsCount(a.id));
      await gsPersist(list);
    }));
    $('#gsRenumber').addEventListener('click', withBusy($('#gsRenumber'), async () => {
      await gsPersist(groups());
    }));

    /* ============================================================
     * 3. 私密 / 公开批量设置
     * ============================================================ */
    const bvSelected = new Set();

    function bvFiltered() {
      const q = ($('#bvFilter').value || '').trim().toLowerCase();
      const gf = $('#bvGroup').value;
      const vf = $('#bvVis').value;
      let list = (S.data.links || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      if (gf === '__none__') list = list.filter(l => !(S.data.groups || []).some(g => g.id === l.groupId));
      else if (gf) list = list.filter(l => l.groupId === gf);
      if (vf) list = list.filter(l => (l.visibility === 'private' ? 'private' : 'public') === vf);
      if (q) {
        list = list.filter(l =>
          (l.title || '').toLowerCase().indexOf(q) > -1 ||
          (l.url || '').toLowerCase().indexOf(q) > -1 ||
          (l.desc || '').toLowerCase().indexOf(q) > -1);
      }
      return list;
    }

    function bvDraw() {
      const host = $('#bvList');
      const list = bvFiltered();
      if (!list.length) {
        host.innerHTML = '<div class="empty-list">没有符合条件的书签</div>';
        $('#bvAll').checked = false;
        return;
      }
      host.innerHTML = list.map(l => {
        const isPriv = l.visibility === 'private';
        return '<label class="check-row">' +
          '<input type="checkbox" data-bv-id="' + esc(l.id) + '"' + (bvSelected.has(l.id) ? ' checked' : '') + '>' +
          '<span class="pill ' + (isPriv ? 'warn' : 'ok') + '">' + (isPriv ? '私密' : '公开') + '</span>' +
          '<div class="cr-main"><div class="cr-title">' + esc(l.title) + '</div>' +
            '<div class="cr-url">' + esc(l.url) + '</div></div>' +
          '<span class="cr-status">' + esc(gname(l.groupId)) + '</span>' +
        '</label>';
      }).join('');
      const allChecked = list.every(l => bvSelected.has(l.id));
      $('#bvAll').checked = allChecked;
    }

    function bvUpdateCount() {
      $('#bvSelCount').textContent = '已选 ' + bvSelected.size + ' 个';
    }

    async function bvApply(vis) {
      const ids = Array.from(bvSelected);
      if (!ids.length) { toast('请先勾选要修改的书签', 'err'); return; }
      const label = vis === 'private' ? '私密' : '公开';
      if (!confirmBox('将选中的 ' + ids.length + ' 个书签设为「' + label + '」？')) return;
      // 后端单次最多处理 2000 个；这里按 500 分批，兼顾大书签集与 KV 写入
      let updated = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const res = await api(API.link, {
          method: 'POST',
          body: { action: 'bulk', ids: ids.slice(i, i + 500), visibility: vis }
        });
        updated += (res && res.updated) || 0;
      }
      const set = new Set(ids);
      S.data.links = (S.data.links || []).map(l => set.has(l.id) ? { ...l, visibility: vis } : l);
      ids.forEach(id => bvSelected.delete(id));
      bvDraw();
      bvUpdateCount();
      syncFront();
      toast('已将 ' + (updated || ids.length) + ' 个书签设为' + label, 'ok', 3000);
    }

    $('#bvFilter').addEventListener('input', debounce(bvDraw, 160));
    $('#bvGroup').addEventListener('change', bvDraw);
    $('#bvVis').addEventListener('change', bvDraw);
    $('#bvList').addEventListener('change', e => {
      const cb = e.target.closest('input[data-bv-id]');
      if (!cb) return;
      if (cb.checked) bvSelected.add(cb.dataset.bvId); else bvSelected.delete(cb.dataset.bvId);
      bvUpdateCount();
      const list = bvFiltered();
      $('#bvAll').checked = list.length > 0 && list.every(l => bvSelected.has(l.id));
    });
    $('#bvAll').addEventListener('change', () => {
      const list = bvFiltered();
      if ($('#bvAll').checked) list.forEach(l => bvSelected.add(l.id));
      else list.forEach(l => bvSelected.delete(l.id));
      bvDraw();
      bvUpdateCount();
    });
    $('#bvPublic').addEventListener('click', withBusy($('#bvPublic'), () => bvApply('public')));
    $('#bvPrivate').addEventListener('click', withBusy($('#bvPrivate'), () => bvApply('private')));

    /* ============================================================
     * 4. 书签大小调整
     * ============================================================ */
    const SIZE_PRESETS = {
      compact: { minCardWidth: 140, gridGap: 10, iconSize: 30, cardPadding: 8, titleSize: 12.5, descSize: 10.5 },
      standard: { minCardWidth: 168, gridGap: 14, iconSize: 38, cardPadding: 11, titleSize: 14, descSize: 11.5 },
      large: { minCardWidth: 200, gridGap: 16, iconSize: 46, cardPadding: 14, titleSize: 15.5, descSize: 12.5 },
      xlarge: { minCardWidth: 240, gridGap: 18, iconSize: 54, cardPadding: 16, titleSize: 17, descSize: 13.5 }
    };

    function sizeModel() {
      return {
        minCardWidth: Number($('#szMinW').value),
        gridGap: Number($('#szGap').value),
        iconSize: Number($('#szIcon').value),
        cardPadding: Number($('#szPad').value),
        titleSize: Number($('#szTitle').value),
        descSize: Number($('#szDesc').value)
      };
    }

    function sizeRefresh() {
      const m = sizeModel();
      $('#vSzMinW').textContent = m.minCardWidth + 'px';
      $('#vSzGap').textContent = m.gridGap + 'px';
      $('#vSzIcon').textContent = m.iconSize + 'px';
      $('#vSzPad').textContent = m.cardPadding + 'px';
      $('#vSzTitle').textContent = m.titleSize + 'px';
      $('#vSzDesc').textContent = m.descSize + 'px';

      $('#sizePrev').innerHTML =
        '<div class="sp-card" style="display:flex;align-items:center;gap:' + (m.cardPadding * 0.9) + 'px;' +
          'padding:' + m.cardPadding + 'px ' + (m.cardPadding + 1) + 'px;border-radius:12px;background:#fff;' +
          'border:1px solid #e3e7f0;max-width:340px;min-height:' + (m.iconSize + m.cardPadding * 2) + 'px;' +
          'box-shadow:0 3px 12px rgba(30,50,100,.08)">' +
          '<div style="flex:0 0 ' + m.iconSize + 'px;width:' + m.iconSize + 'px;height:' + m.iconSize + 'px;' +
            'border-radius:9px;background:linear-gradient(135deg,#5b8cff,#7c5bff);display:grid;place-items:center;' +
            'color:#fff;font-weight:700;font-size:' + (m.iconSize * 0.42).toFixed(1) + 'px">N</div>' +
          '<div style="min-width:0"><div style="font-size:' + m.titleSize + 'px;font-weight:650;' +
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">示例书签</div>' +
            '<div style="font-size:' + m.descSize + 'px;color:#8a92a6;white-space:nowrap;overflow:hidden;' +
            'text-overflow:ellipsis">这是书签描述文字预览</div></div>' +
        '</div>';

      // 实时预览到前台（只重算 CSS 变量，不重建卡片）
      if (window.NavBox && window.NavBox.patch) {
        const live = JSON.parse(JSON.stringify(S.data.settings || {}));
        live.layout = { ...(live.layout || {}), ...m };
        window.NavBox.patch({ settings: live }, true);
      }

      $$('#sizePresets [data-size-preset]').forEach(b => {
        const p = SIZE_PRESETS[b.dataset.sizePreset];
        const same = p && Object.keys(p).every(k => Math.abs(Number(p[k]) - m[k]) < 0.001);
        b.classList.toggle('active', !!same);
      });
    }

    function sizeApplyPreset(name) {
      const p = SIZE_PRESETS[name];
      if (!p) return;
      $('#szMinW').value = p.minCardWidth;
      $('#szGap').value = p.gridGap;
      $('#szIcon').value = p.iconSize;
      $('#szPad').value = p.cardPadding;
      $('#szTitle').value = p.titleSize;
      $('#szDesc').value = p.descSize;
      sizeRefresh();
    }

    ['#szMinW', '#szGap', '#szIcon', '#szPad', '#szTitle', '#szDesc'].forEach(sel => {
      $(sel).addEventListener('input', sizeRefresh);
    });
    $$('#sizePresets [data-size-preset]').forEach(b => {
      b.addEventListener('click', () => sizeApplyPreset(b.dataset.sizePreset));
    });
    $('#szReset').addEventListener('click', () => {
      sizeApplyPreset('standard');
      toast('已填入标准尺寸，点「保存大小设置」生效', 'ok', 2600);
    });
    $('#szSave').addEventListener('click', withBusy($('#szSave'), async () => {
      const res = await api(API.settings, { method: 'POST', body: { settings: { layout: sizeModel() } } });
      S.data.settings = res.settings;
      syncFront();
      toast('书签大小已保存', 'ok');
    }));

    /* ---- 初始化 ---- */
    lcDraw();
    lcUpdateStats();
    gsDraw();
    bvDraw();
    bvUpdateCount();
    sizeRefresh();
  }

  /* ============================================================
   * 标签页 3：外观设置（背景 + 书签卡片透明度/背景）
   * ============================================================ */
  function renderStyleTab() {
    const d = S.data;
    if (!d) return;
    const s = JSON.parse(JSON.stringify(d.settings || {}));
    const bg = s.background || {};
    const card = s.card || {};
    const layout = s.layout || {};

    const gradients = [
      'linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
      'linear-gradient(135deg,#0f2027,#203a43,#2c5364)',
      'linear-gradient(135deg,#ff9966,#ff5e62)',
      'linear-gradient(135deg,#11998e,#38ef7d)',
      'linear-gradient(135deg,#2b5876,#4e4376)',
      'linear-gradient(135deg,#ee9ca7,#ffdde1)',
      'linear-gradient(160deg,#0f172a,#1e293b 55%,#334155)',
      'linear-gradient(135deg,#4facfe,#00f2fe)'
    ];

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar"><h3>🎨 外观设置</h3><div class="spacer"></div>' +
        '<button class="btn btn-ghost btn-sm" id="resetStyle" type="button">恢复默认</button>' +
        '<button class="btn btn-primary btn-sm" id="saveStyle" type="button">保存全部设置</button>' +
      '</div>' +

      /* --- 站点信息 --- */
      '<div class="section-card"><h3><span class="h-ico">📝</span>站点信息</h3>' +
        '<div class="field"><label>站点标题</label>' +
          '<input class="input" id="sTitle" maxlength="60" value="' + esc(s.siteTitle || '') + '"></div>' +
        '<div class="field"><label>副标题</label>' +
          '<input class="input" id="sSubtitle" maxlength="160" value="' + esc(s.siteSubtitle || '') + '"></div>' +
        '<div class="field"><label>页脚文字</label>' +
          '<input class="input" id="sFooter" maxlength="200" value="' + esc(s.footer || '') + '">' +
          '<div class="field-hint">支持直接写 http(s) 链接，前台会自动变成可点击链接。</div></div>' +
        '<div class="row2">' +
          '<div class="field"><label>主题模式</label><select class="select" id="sTheme">' +
            ['auto|跟随系统','light|始终浅色','dark|始终深色'].map(o => {
              const [v, t] = o.split('|');
              return '<option value="' + v + '"' + (s.theme === v ? ' selected' : '') + '>' + t + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field"><label>图标抓取源</label><select class="select" id="sFavicon">' +
            [['favicon.im','favicon.im（推荐，国内较快）'],['icon.horse','icon.horse（质量高）'],
             ['google','Google favicon（需可访问 Google）'],['direct','站点 /favicon.ico（最省流量）'],
             ['custom','全部使用自定义图标']]
            .map(o => '<option value="' + o[0] + '"' + ((s.favicon && s.favicon.provider) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
          '</select><div class="field-hint">抓取失败时会自动尝试其它源，全部失败则显示名称首字。</div></div>' +
        '</div>' +
        '<label class="switch"><input type="checkbox" id="sPrivateBadge"' + (s.privateBadge !== false ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">管理员视图下给私密书签显示「私密」角标</span></label>' +
      '</div>' +

      /* --- 背景 --- */
      '<div class="section-card"><h3><span class="h-ico">🖼️</span>背景设置</h3>' +
        '<div class="bg-preview" id="bgPreview"><div class="overlay"></div><span>预览效果</span></div>' +
        '<div style="height:14px"></div>' +
        '<div class="field"><label>背景类型</label><select class="select" id="bgType">' +
          '<option value="gradient"' + (bg.type !== 'url' && bg.type !== 'upload' ? ' selected' : '') + '>渐变色</option>' +
          '<option value="url"' + (bg.type === 'url' ? ' selected' : '') + '>图床 / 外链图片地址</option>' +
          '<option value="upload"' + (bg.type === 'upload' ? ' selected' : '') + '>上传图片（存入 KV）</option>' +
        '</select></div>' +

        '<div id="bgGradientBox">' +
          '<div class="field"><label>预设渐变</label>' +
            '<div id="gradList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px"></div></div>' +
          '<div class="field"><label>自定义渐变 CSS</label>' +
            '<input class="input mono" id="bgGradient" maxlength="300" value="' + esc(bg.gradient || '') + '">' +
            '<div class="field-hint">可填任意 CSS 渐变，例如 <code>linear-gradient(135deg,#667eea,#764ba2)</code></div></div>' +
        '</div>' +

        '<div id="bgUrlBox">' +
          '<div class="field"><label>图片直链</label>' +
            '<input class="input mono" id="bgUrl" maxlength="2000" value="' + esc(bg.url || '') + '" placeholder="https://i.example.com/bg.jpg">' +
            '<div class="field-hint">推荐使用图床直链（如 SM.MS、Imgur、Cloudflare R2、七牛等），无大小限制且不占用 KV 容量。' +
            '注意：图床需允许跨域引用（无防盗链）。</div></div>' +
        '</div>' +

        '<div id="bgUploadBox">' +
          '<div class="field"><label>上传背景图</label>' +
            '<div class="upload-drop" id="bgDrop">点击选择，或将图片拖到此处<br><span style="font-size:11.5px;opacity:.75">自动压缩到 1600px 以内以适配平台 1MB 请求体限制</span></div>' +
            '<input type="file" id="bgFile" accept="image/*" hidden>' +
            '<div class="field-hint" id="bgUploadHint"></div>' +
            '<div class="btn-group" id="bgUploadActions" style="display:none">' +
              '<button class="btn btn-soft btn-sm" type="button" id="bgUploadSave">☁️ 上传到服务器</button>' +
              '<button class="btn btn-danger btn-sm" type="button" id="bgUploadDel">删除已上传图片</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<hr class="divider">' +
        '<div class="field"><label>背景模糊 <span id="lblBlur"></span></label>' +
          '<div class="range-row"><input type="range" id="bgBlur" min="0" max="40" step="1" value="' + (bg.blur || 0) + '"><span class="range-val" id="valBlur"></span></div></div>' +
        '<div class="field"><label>背景亮度 <span id="lblBright"></span></label>' +
          '<div class="range-row"><input type="range" id="bgBright" min="20" max="200" step="5" value="' + (bg.brightness || 100) + '"><span class="range-val" id="valBright"></span></div></div>' +
        '<div class="field"><label>暗色遮罩不透明度</label>' +
          '<div class="range-row"><input type="range" id="bgOverlay" min="0" max="95" step="1" value="' + (bg.overlay != null ? bg.overlay : 30) + '"><span class="range-val" id="valOverlay"></span></div>' +
          '<div class="field-hint">数值越大背景越暗，卡片文字越清晰。</div></div>' +
      '</div>' +

      /* --- 书签卡片 --- */
      '<div class="section-card"><h3><span class="h-ico">🎴</span>书签卡片样式</h3>' +
        '<div class="notice info" style="font-size:12px">下方调整会实时反映到前台页面，满意后点顶部「保存全部设置」。</div>' +
        '<div class="field"><label>卡片背景不透明度</label>' +
          '<div class="range-row"><input type="range" id="cOpacity" min="0" max="100" step="1" value="' + (card.opacity != null ? card.opacity : 82) + '"><span class="range-val" id="valOpacity"></span></div>' +
          '<div class="field-hint">0 = 完全透明，100 = 完全不透明。</div></div>' +
        '<div class="row2">' +
          '<div class="field"><label>卡片背景色</label><input type="color" id="cColor" value="' + esc(normalizeColor(card.bgColor || '#ffffff')) + '"></div>' +
          '<div class="field"><label>文字颜色</label><input type="color" id="cText" value="' + esc(normalizeColor(card.textColor || '#1f2430')) + '"></div>' +
        '</div>' +
        '<div class="row2">' +
          '<div class="field"><label>毛玻璃强度 (px)</label>' +
            '<div class="range-row"><input type="range" id="cBlur" min="0" max="40" step="1" value="' + (card.blur != null ? card.blur : 12) + '"><span class="range-val" id="valCBlur"></span></div></div>' +
          '<div class="field"><label>圆角 (px)</label>' +
            '<div class="range-row"><input type="range" id="cRadius" min="0" max="40" step="1" value="' + (card.radius != null ? card.radius : 14) + '"><span class="range-val" id="valRadius"></span></div></div>' +
        '</div>' +
        '<label class="switch"><input type="checkbox" id="cHover"' + (card.hoverScale !== false ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">悬停时卡片轻微上浮放大</span></label>' +
      '</div>' +

      /* --- 布局 --- */
      '<div class="section-card"><h3><span class="h-ico">📐</span>布局与搜索</h3>' +
        '<div class="field"><label>桌面端卡片最小宽度 (px)</label>' +
          '<div class="range-row"><input type="range" id="lMinW" min="110" max="420" step="2" value="' + (layout.minCardWidth || 168) + '"><span class="range-val" id="valMinW"></span></div>' +
          '<div class="field-hint">越小每行卡片越多。手机端会自动使用更紧凑的宽度。</div></div>' +
        '<div class="field"><label>搜索框占位提示</label>' +
          '<input class="input" id="sSearchPh" maxlength="60" value="' + esc((s.search && s.search.placeholder) || '') + '"></div>' +
        '<label class="switch" style="margin-bottom:10px"><input type="checkbox" id="lDesc"' + (layout.showDesc !== false ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">显示书签描述文字</span></label><br>' +
        '<label class="switch" style="margin-bottom:10px"><input type="checkbox" id="lDense"' + (layout.denseMobile ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">手机端使用密集布局（每行更多卡片）</span></label><br>' +
        '<label class="switch" style="margin-bottom:10px"><input type="checkbox" id="sSearchOn"' + ((s.search && s.search.enabled) !== false ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">启用前台搜索框（快捷键 / 或 Ctrl+K）</span></label><br>' +
        '<label class="switch"><input type="checkbox" id="sSearchNew"' + ((s.search && s.search.openInNewTab) !== false ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">点击书签在新标签页打开</span></label>' +
      '</div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    function normalizeColor(c) {
      if (/^#[0-9a-fA-F]{6}$/.test(String(c || ''))) return c;
      if (/^#[0-9a-fA-F]{3}$/.test(String(c || ''))) {
        return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      }
      return '#ffffff';
    }

    /* --- 渐变预设 --- */
    const gradList = $('#gradList');
    gradients.forEach(g => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = 'height:40px;border-radius:8px;border:2px solid transparent;cursor:pointer;background:' + g;
      b.title = g;
      b.addEventListener('click', () => {
        $('#bgGradient').value = g;
        $$('#gradList button').forEach(x => x.style.borderColor = 'transparent');
        b.style.borderColor = '#4f7cff';
        refreshPreview();
      });
      gradList.appendChild(b);
    });

    /* --- 背景上传 --- */
    const drop = $('#bgDrop');
    const fileInput = $('#bgFile');
    drop.addEventListener('click', () => fileInput.click());
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleBgFile(f);
    });
    fileInput.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) handleBgFile(f);
    });

    async function handleBgFile(f) {
      try {
        // 1600px 内 + 0.82 质量，保证 base64 后仍远小于 1MB 请求体限制
        const dataUrl = await compressImage(f, 1600, 0.82);
        if (dataUrl.length > 900 * 1024) {
          const again = await compressImage(f, 1100, 0.7);
          if (again.length > 900 * 1024) {
            toast('图片压缩后仍超过 900KB，请改用「图床外链」方式，或先用其他工具压缩到 600KB 以内', 'err', 6000);
            return;
          }
          S.uploadDataUrl = again;
        } else {
          S.uploadDataUrl = dataUrl;
        }
        $('#bgType').value = 'upload';
        syncBgBoxes();
        refreshPreview();
        $('#bgUploadHint').innerHTML = '已选择图片，压缩后大小 <b>' + fmtBytes(S.uploadDataUrl.length) + '</b>（上限 900KB）。请点击下方「上传到服务器」。';
        $('#bgUploadActions').style.display = '';
        toast('图片已压缩，请点「上传到服务器」', 'ok', 2600);
      } catch (e) {
        toast('图片处理失败：' + e.message, 'err');
      }
    }

    $('#bgUploadSave').addEventListener('click', withBusy($('#bgUploadSave'), async () => {
      if (!S.uploadDataUrl) { toast('请先选择一张图片', 'err'); return; }
      await api(API.background, { method: 'POST', body: { dataUrl: S.uploadDataUrl } });
      d.background = { dataUrl: S.uploadDataUrl, updatedAt: new Date().toISOString() };
      $('#bgType').value = 'upload';
      syncBgBoxes();
      refreshPreview();
      syncFront();
      $('#bgUploadHint').innerHTML = '✅ 已保存到服务器（' + fmtBytes(S.uploadDataUrl.length) + '）。';
      toast('背景图已上传', 'ok');
    }));

    $('#bgUploadDel').addEventListener('click', withBusy($('#bgUploadDel'), async () => {
      if (!confirmBox('确定删除已上传的背景图？删除后可改用渐变或图床外链。')) return;
      await api(API.background, { method: 'POST', body: { action: 'delete' } });
      d.background = null;
      S.uploadDataUrl = null;
      $('#bgUploadHint').textContent = '';
      $('#bgUploadActions').style.display = 'none';
      refreshPreview();
      syncFront();
      toast('已删除上传的背景图', 'ok');
    }));

    if (d.background && d.background.dataUrl) {
      $('#bgUploadHint').innerHTML = '当前已有一张上传的背景图（' + fmtBytes(String(d.background.dataUrl).length) + '）。重新选择图片即可替换。';
      $('#bgUploadActions').style.display = '';
    }

    /* --- 背景类型切换 --- */
    function syncBgBoxes() {
      const t = $('#bgType').value;
      $('#bgGradientBox').style.display = t === 'gradient' ? '' : 'none';
      $('#bgUrlBox').style.display = t === 'url' ? '' : 'none';
      $('#bgUploadBox').style.display = t === 'upload' ? '' : 'none';
    }
    $('#bgType').addEventListener('change', () => { syncBgBoxes(); refreshPreview(); });
    syncBgBoxes();

    /* --- 预览与实时应用 --- */
    function currentBgModel() {
      return {
        type: $('#bgType').value,
        url: $('#bgUrl').value.trim(),
        gradient: $('#bgGradient').value.trim() || gradients[0],
        blur: Number($('#bgBlur').value),
        brightness: Number($('#bgBright').value),
        overlay: Number($('#bgOverlay').value)
      };
    }

    function refreshPreview() {
      const m = currentBgModel();
      const el = $('#bgPreview');
      $('.overlay', el).style.setProperty('--ov', (m.overlay / 100));
      if (m.type === 'url' && m.url) {
        el.style.backgroundImage = 'url("' + m.url.replace(/"/g, '%22') + '")';
        el.style.background = '';
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      } else if (m.type === 'upload' && (S.uploadDataUrl || (d.background && d.background.dataUrl))) {
        el.style.backgroundImage = 'url("' + (S.uploadDataUrl || d.background.dataUrl) + '")';
        el.style.background = '';
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      } else {
        el.style.backgroundImage = '';
        el.style.background = m.gradient;
      }
      el.style.filter = 'blur(' + Math.min(m.blur, 6) + 'px) brightness(' + m.brightness + '%)';

      // 实时更新前台
      if (window.NavBox) {
        const live = JSON.parse(JSON.stringify(S.data.settings));
        live.background = m;
        live.card = {
          opacity: Number($('#cOpacity').value),
          bgColor: $('#cColor').value,
          blur: Number($('#cBlur').value),
          radius: Number($('#cRadius').value),
          textColor: $('#cText').value,
          hoverScale: $('#cHover').checked
        };
        live.layout = {
          ...((S.data.settings && S.data.settings.layout) || {}),
          minCardWidth: Number($('#lMinW').value),
          showDesc: $('#lDesc').checked,
          showGroupIcon: true,
          denseMobile: $('#lDense').checked
        };
        if (m.type === 'upload') {
          window.NavBox.state.background = S.uploadDataUrl
            ? { dataUrl: S.uploadDataUrl }
            : (d.background || null);
        }
        // 主题下拉框也参与实时预览（此时尚未保存）
        const themeSel = $('#sTheme');
        if (themeSel) live.theme = themeSel.value;
        // styleOnly=true：只重算样式变量，不重建卡片 DOM，
        // 否则每拖一次滑杆都会重新加载全部图标造成闪烁与重复请求
        window.NavBox.patch({ settings: live }, true);
      }
    }

    function bindRange(id, valId, suffix) {
      const r = $(id), v = $(valId);
      const upd = () => { v.textContent = r.value + (suffix || ''); };
      r.addEventListener('input', () => { upd(); refreshPreview(); });
      upd();
    }
    bindRange('#bgBlur', '#valBlur', 'px');
    bindRange('#bgBright', '#valBright', '%');
    bindRange('#bgOverlay', '#valOverlay', '%');
    bindRange('#cOpacity', '#valOpacity', '%');
    bindRange('#cBlur', '#valCBlur', 'px');
    bindRange('#cRadius', '#valRadius', 'px');
    bindRange('#lMinW', '#valMinW', 'px');
    ['#bgUrl', '#bgGradient', '#cColor', '#cText'].forEach(sel => {
      const el = $(sel);
      el.addEventListener('input', debounce(refreshPreview, 220));
      el.addEventListener('change', refreshPreview);
    });
    ['#cHover', '#lDesc', '#lDense'].forEach(sel => $(sel).addEventListener('change', refreshPreview));

    /* --- 保存 --- */
    $('#saveStyle').addEventListener('click', withBusy($('#saveStyle'), async () => {
      const payload = {
        settings: {
          siteTitle: $('#sTitle').value.trim(),
          siteSubtitle: $('#sSubtitle').value.trim(),
          footer: $('#sFooter').value.trim(),
          theme: $('#sTheme').value,
          privateBadge: $('#sPrivateBadge').checked,
          background: currentBgModel(),
          card: {
            opacity: Number($('#cOpacity').value),
            bgColor: $('#cColor').value,
            blur: Number($('#cBlur').value),
            radius: Number($('#cRadius').value),
            textColor: $('#cText').value,
            hoverScale: $('#cHover').checked
          },
          layout: {
            minCardWidth: Number($('#lMinW').value),
            showDesc: $('#lDesc').checked,
            showGroupIcon: true,
            denseMobile: $('#lDense').checked
          },
          favicon: { provider: $('#sFavicon').value },
          search: {
            enabled: $('#sSearchOn').checked,
            placeholder: $('#sSearchPh').value.trim(),
            openInNewTab: $('#sSearchNew').checked
          }
        }
      };
      // 类型与已上传图片不匹配时给出提示
      if (payload.settings.background.type === 'upload' && !S.uploadDataUrl && !(d.background && d.background.dataUrl)) {
        toast('背景类型选择了「上传图片」，但还没有上传任何图片', 'err', 4200);
        return;
      }
      if (payload.settings.background.type === 'url' && !payload.settings.background.url) {
        toast('背景类型选择了「图床外链」，但地址为空', 'err', 4200);
        return;
      }
      const res = await api(API.settings, { method: 'POST', body: payload });
      S.data.settings = res.settings;
      syncFront();
      toast('外观设置已保存', 'ok');
    }));

    $('#resetStyle').addEventListener('click', () => {
      if (!confirmBox('恢复默认外观设置？（不影响书签数据，需再点「保存全部设置」才生效）')) return;
      switchTab('style');
      setTimeout(() => {
        const def = {
          siteTitle: 'NavBox 导航', siteSubtitle: '简洁、快速、可自定义的个人网址导航',
          footer: 'Powered by NavBox · Deployed on EdgeOne Pages', theme: 'auto', privateBadge: true
        };
        if ($('#sTitle')) $('#sTitle').value = def.siteTitle;
        if ($('#sSubtitle')) $('#sSubtitle').value = def.siteSubtitle;
        if ($('#sFooter')) $('#sFooter').value = def.footer;
        toast('已填入默认值，请点击「保存全部设置」生效', 'ok', 3000);
      }, 60);
    });

    refreshPreview();
  }

  /* ============================================================
   * 标签页 4：导入导出
   * ============================================================ */
  function renderTransferTab() {
    const d = S.data;
    if (!d) return;
    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar"><h3>🔄 书签导入与导出</h3></div>' +

      '<div class="stat-grid">' +
        '<div class="stat-card"><div class="num">' + (d.groups || []).length + '</div><div class="lbl">分组数</div></div>' +
        '<div class="stat-card"><div class="num">' + (d.links || []).length + '</div><div class="lbl">书签总数</div></div>' +
        '<div class="stat-card"><div class="num">' + (d.links || []).filter(l => l.visibility === 'private').length + '</div><div class="lbl">私密书签</div></div>' +
        '<div class="stat-card"><div class="num">' + (d.links || []).reduce((s, l) => s + (l.clicks || 0), 0) + '</div><div class="lbl">累计点击</div></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">📤</span>导出书签</h3>' +
        '<div class="notice info" style="font-size:12px">' +
          '<b>JSON</b>：本项目完整备份格式，含分组、书签、外观设置，可用于导入恢复。<br>' +
          '<b>HTML</b>：Netscape 标准书签格式，可导入 Chrome / Edge / Firefox 浏览器，也可导入其他导航站程序。' +
          '私密书签会带上 <code>PRIVATE="1"</code> 标记，重新导入本项目时会保持私密属性。' +
        '</div>' +
        '<div class="field"><label>导出范围</label><select class="select" id="exScope">' +
          '<option value="public">仅公开书签（分享给他人时用）</option>' +
          '<option value="all" selected>全部书签（含私密，仅自己备份用）</option>' +
        '</select></div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="exJson" type="button">⬇ 下载 JSON 备份</button>' +
          '<button class="btn btn-ghost btn-sm" id="exHtml" type="button">⬇ 下载 HTML 书签</button>' +
          '<button class="btn btn-ghost btn-sm" id="exCopy" type="button">📋 复制 JSON 到剪贴板</button>' +
        '</div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">📥</span>导入书签</h3>' +
        '<div class="field"><label>数据来源</label>' +
          '<div class="btn-group" style="margin-bottom:12px">' +
            '<label class="btn btn-ghost btn-sm" for="impFile" style="cursor:pointer">📁 选择本地文件（JSON / HTML）</label>' +
            '<input type="file" id="impFile" accept=".json,.html,.htm,application/json,text/html" hidden>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="impPasteToggle">📋 粘贴文本导入</button>' +
          '</div>' +
          '<div id="impPasteBox" style="display:none">' +
            '<textarea class="textarea mono" id="impText" rows="7" placeholder="把 JSON 备份内容或浏览器书签 HTML 粘贴到这里…"></textarea>' +
          '</div>' +
          '<div class="field-hint" id="impFileInfo"></div>' +
        '</div>' +
        '<div class="field"><label>导入方式</label><select class="select" id="impMode">' +
          '<option value="merge">合并（推荐）：按网址去重后追加，不删除现有书签</option>' +
          '<option value="replace">覆盖：清空现有书签与分组，完全替换为导入内容</option>' +
        '</select></div>' +
        '<div class="notice warn" style="font-size:12px">' +
          '「覆盖」模式会同时替换外观设置与背景图，且<b>不可撤销</b>。建议先导出一份 JSON 备份。' +
        '</div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="impRun" type="button">🚀 开始导入</button>' +
        '</div>' +
        '<div id="impResult" style="margin-top:14px"></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">💡</span>格式说明</h3>' +
        '<div class="kv-row"><span class="k">支持的导入格式</span><span class="v">本项目 JSON 备份 / 浏览器书签 HTML</span></div>' +
        '<div class="kv-row"><span class="k">请求体上限</span><span class="v">1 MB（平台限制）</span></div>' +
        '<div class="kv-row"><span class="k">单条数据上限</span><span class="v">KV value ≤ 25 MB</span></div>' +
        '<div class="kv-row"><span class="k">超大书签集建议</span><span class="v">分批导入，或改用 WebDAV 备份恢复</span></div>' +
      '</div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    let pendingText = null;

    /* ---- 导出 ---- */
    function triggerDownload(url, name) {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); }, 200);
    }

    async function fetchExport(format) {
      const scope = $('#exScope').value;
      const res = await fetch(API.exportData + '?format=' + format + '&scope=' + scope, {
        credentials: 'same-origin'
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const name = 'navbox-' + (format === 'html' ? 'bookmarks' : 'export') + '-' + stamp +
        (scope === 'all' ? '-full' : '') + (format === 'html' ? '.html' : '.json');
      const url = URL.createObjectURL(blob);
      triggerDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return name;
    }

    $('#exJson').addEventListener('click', withBusy($('#exJson'), async () => {
      const n = await fetchExport('json');
      toast('已导出：' + n, 'ok', 2600);
    }));
    $('#exHtml').addEventListener('click', withBusy($('#exHtml'), async () => {
      const n = await fetchExport('html');
      toast('已导出：' + n, 'ok', 2600);
    }));
    $('#exCopy').addEventListener('click', withBusy($('#exCopy'), async () => {
      const scope = $('#exScope').value;
      const res = await fetch(API.exportData + '?format=json&scope=' + scope, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制 ' + fmtBytes(text.length) + ' JSON 到剪贴板', 'ok', 2400);
    }));

    /* ---- 导入 ---- */
    $('#impPasteToggle').addEventListener('click', () => {
      const box = $('#impPasteBox');
      const show = box.style.display === 'none';
      box.style.display = show ? '' : 'none';
      if (show) { pendingText = null; $('#impFileInfo').textContent = ''; $('#impText').focus(); }
    });

    $('#impFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 950 * 1024) {
        $('#impFileInfo').innerHTML = '<span style="color:#c23b32">文件 ' + fmtBytes(f.size) +
          ' 超过平台 1MB 请求体限制，请拆分文件或改用 WebDAV 恢复。</span>';
        pendingText = null;
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        pendingText = String(r.result || '');
        $('#impFileInfo').innerHTML = '已选择 <b>' + esc(f.name) + '</b>（' + fmtBytes(f.size) + '），可以开始导入。';
        $('#impPasteBox').style.display = 'none';
      };
      r.onerror = () => { $('#impFileInfo').textContent = '文件读取失败'; };
      r.readAsText(f, 'utf-8');
    });

    $('#impRun').addEventListener('click', withBusy($('#impRun'), async () => {
      const mode = $('#impMode').value;
      const pasted = $('#impText').value.trim();
      const text = pasted || pendingText;
      if (!text) { toast('请先选择文件或粘贴内容', 'err'); return; }
      if (text.length > 950 * 1024) {
        toast('内容 ' + fmtBytes(text.length) + ' 超过平台 1MB 限制，请拆分后再导入', 'err', 5000);
        return;
      }
      if (mode === 'replace' && !confirmBox('覆盖模式会清空现有全部书签、分组与外观设置，且不可撤销。确定继续？')) return;

      const res = await api(API.importData, { method: 'POST', body: { mode: mode, data: text } });
      let html = '';
      if (mode === 'merge') {
        html = '<div class="notice ok">导入完成（合并模式）：新增 <b>' + res.added + '</b> 个书签，' +
          '跳过重复 <b>' + res.skipped + '</b> 个。当前共 ' + res.links + ' 个书签、' + res.groups + ' 个分组。</div>';
      } else {
        html = '<div class="notice ok">导入完成（覆盖模式）：已替换为 <b>' + res.links + '</b> 个书签、' +
          res.groups + ' 个分组。</div>';
      }
      $('#impResult').innerHTML = html;
      pendingText = null;
      $('#impText').value = '';
      $('#impFile').value = '';
      $('#impFileInfo').textContent = '';
      await loadAdminData(true);
      toast('导入成功', 'ok');
    }));
  }

  /* ============================================================
   * 标签页 5：WebDAV 备份
   * ============================================================ */
  function renderBackupTab() {
    const d = S.data;
    if (!d) return;
    const w = d.webdav || {};

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar"><h3>☁️ WebDAV 备份</h3><div class="spacer"></div>' +
        '<span class="badge ' + (w.url ? 'badge-pub' : 'badge-gray') + '">' + (w.url ? '已配置' : '未配置') + '</span>' +
      '</div>' +

      '<div class="notice info" style="font-size:12px">' +
        '备份内容为完整 JSON（分组 + 书签 + 外观设置），上传到你的 WebDAV 网盘。' +
        '常见可用服务：坚果云、Nextcloud、ownCloud、Alist、InfiniCloud 等。' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">⚙️</span>服务器配置</h3>' +
        '<div class="field"><label>WebDAV 地址<span class="req">*</span></label>' +
          '<input class="input mono" id="wUrl" value="' + esc(w.url || '') + '" placeholder="https://dav.jianguoyun.com/dav/">' +
          '<div class="field-hint">坚果云示例：<code>https://dav.jianguoyun.com/dav/</code>；Nextcloud 示例：<code>https://your.domain/remote.php/dav/files/用户名/</code></div></div>' +
        '<div class="row2">' +
          '<div class="field"><label>备份目录</label>' +
            '<input class="input mono" id="wPath" value="' + esc(w.path || '/navbox-backup') + '" placeholder="/navbox-backup"></div>' +
          '<div class="field"><label>用户名</label>' +
            '<input class="input" id="wUser" value="' + esc(w.username || '') + '" placeholder="你的账号" autocomplete="off"></div>' +
        '</div>' +
        '<div class="field"><label>密码 / 应用专用密码</label>' +
          '<input class="input" id="wPass" type="password" placeholder="' + (w.passwordSet ? '已保存（留空表示不修改）' : '请输入密码') + '" autocomplete="new-password">' +
          '<div class="field-hint">⚠️ 坚果云等服务需在网页端生成「应用密码 / 安全设置密码」，直接用登录密码会返回 401。' +
          '密码仅保存在你自己的 KV 中，<b>不会</b>写入导出的备份文件。</div></div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="wSave" type="button">💾 保存配置</button>' +
          '<button class="btn btn-ghost btn-sm" id="wTest" type="button">🔌 测试连接</button>' +
          (w.url ? '<button class="btn btn-danger btn-sm" id="wDel" type="button">删除配置</button>' : '') +
        '</div>' +
        '<div id="wTestResult" style="margin-top:12px"></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">⏰</span>自动备份</h3>' +
        '<label class="switch" style="margin-bottom:14px"><input type="checkbox" id="wAuto"' + (w.autoBackup ? ' checked' : '') + '>' +
          '<span class="track"></span><span class="lbl">启用自动备份</span></label>' +
        '<div class="row2">' +
          '<div class="field"><label>最小间隔（小时）</label>' +
            '<input class="input" id="wInterval" type="number" min="1" max="720" step="1" value="' + (w.intervalHours || 24) + '">' +
            '<div class="field-hint">由站点访问触发，距上次备份超过该间隔才执行。</div></div>' +
          '<div class="field"><label>云端保留份数</label>' +
            '<input class="input" id="wKeep" type="number" min="1" max="100" step="1" value="' + (w.keep || 10) + '">' +
            '<div class="field-hint">超出后自动删除最旧的备份文件。</div></div>' +
        '</div>' +
        '<div class="notice warn" style="font-size:12px">' +
          '<b>关于「定时」备份的两种机制</b>（建议都配上，互为补充）：<br>' +
          '① <b>流量驱动</b>：勾选上面的「启用自动备份」即可，有访客打开站点时自动检查并备份，无需额外配置。<br>' +
          '② <b>平台定时任务</b>：在项目根目录 <code>edgeone.json</code> 的 <code>schedules</code> 中配置 cron。' +
          '注意 EdgeOne 平台定时任务<b>最小间隔为一天</b>，因此「每小时级」的自动备份只能靠机制①实现。<br>' +
          '保存配置后下方会显示你的专属 cron 令牌与可直接粘贴的配置片段。' +
        '</div>' +
        '<div id="cronBox"></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">🚀</span>手动备份与恢复</h3>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="wBackupNow" type="button"' + (w.url ? '' : ' disabled') + '>⬆ 立即备份到 WebDAV</button>' +
          '<button class="btn btn-ghost btn-sm" id="wList" type="button"' + (w.url ? '' : ' disabled') + '>📂 列出云端备份文件</button>' +
          '<button class="btn btn-soft btn-sm" id="wRestoreLatest" type="button"' + (w.url ? '' : ' disabled') + '>⬇ 从最新备份恢复</button>' +
        '</div>' +
        '<div id="wFileList" style="margin-top:14px"></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">📜</span>备份日志（最近 30 条）</h3>' +
        '<div id="wLog"></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">ℹ️</span>当前状态</h3>' +
        '<div class="kv-row"><span class="k">上次备份时间</span><span class="v">' + esc(fmtTime(w.lastBackupAt)) + '</span></div>' +
        '<div class="kv-row"><span class="k">上次备份文件</span><span class="v" style="font-size:11.5px">' + esc(w.lastBackupTarget || '—') + '</span></div>' +
        '<div class="kv-row"><span class="k">触发方式</span><span class="v">手动 / 流量驱动 / 平台定时任务</span></div>' +
      '</div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    function drawLog() {
      const log = (S.data && S.data.backupLog) || [];
      const host = $('#wLog');
      if (log.length === 0) {
        host.innerHTML = '<div class="empty-list">暂无备份记录</div>';
        return;
      }
      host.innerHTML = log.map(l =>
        '<div class="log-item"><span class="dot ' + (l.ok ? 'ok' : 'err') + '"></span>' +
        '<div class="log-main"><div class="log-msg">' +
          (l.ok
            ? esc('备份成功 · ' + (l.trigger === 'manual' ? '手动' : l.trigger === 'cron' ? '定时任务' : '自动') +
                ' · ' + fmtBytes(l.bytes) + ' · ' + (l.links || 0) + ' 个书签')
            : esc('备份失败 · ' + (l.error || '未知错误') + (l.detail ? ' · ' + l.detail : ''))) +
        '</div><div class="log-time">' + esc(fmtTime(l.at)) + '</div></div></div>'
      ).join('');
    }

    function showCronBox(token) {
      if (!token) return;
      const snippet = JSON.stringify({
        schedules: [{
          name: 'navbox-webdav-backup',
          cron: '0 4 * * *',
          timezone: 'Asia/Shanghai',
          path: '/api/cron/backup',
          method: 'POST',
          payload: { token: token }
        }]
      }, null, 2);
      $('#cronBox').innerHTML =
        '<div class="field"><label>你的定时任务令牌（用于校验触发来源）</label>' +
          '<div class="row-inline"><input class="input mono" id="cronToken" readonly value="' + esc(token) + '">' +
          '<button class="btn btn-ghost btn-sm" id="copyToken" type="button">复制</button></div>' +
          '<div class="field-hint">此令牌等同于备份权限，请勿公开分享或提交到公开仓库。</div></div>' +
        '<div class="field"><label>可直接粘贴到 edgeone.json 的配置</label>' +
          '<textarea class="textarea mono" rows="11" readonly id="cronSnippet">' + esc(snippet) + '</textarea>' +
          '<div class="field-hint">示例为每天 04:00（北京时间）执行一次。修改 <code>cron</code> 字段可调整时间；平台最小间隔为一天。</div></div>' +
        '<div class="btn-group"><button class="btn btn-ghost btn-sm" id="copySnippet" type="button">📋 复制配置片段</button></div>';

      $('#copyToken').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(token); toast('令牌已复制', 'ok', 1500); }
        catch (e) { $('#cronToken').select(); document.execCommand('copy'); toast('令牌已复制', 'ok', 1500); }
      });
      $('#copySnippet').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(snippet); toast('配置片段已复制', 'ok', 1500); }
        catch (e) { $('#cronSnippet').select(); document.execCommand('copy'); toast('配置片段已复制', 'ok', 1500); }
      });
    }

    /* ---- 保存配置 ---- */
    $('#wSave').addEventListener('click', withBusy($('#wSave'), async () => {
      const url = $('#wUrl').value.trim();
      if (!url) { toast('请填写 WebDAV 地址', 'err'); return; }
      const res = await api(API.webdav, {
        method: 'POST',
        body: {
          url: url,
          path: $('#wPath').value.trim() || '/navbox-backup',
          username: $('#wUser').value.trim(),
          password: $('#wPass').value,
          autoBackup: $('#wAuto').checked,
          intervalHours: Number($('#wInterval').value) || 24,
          keep: Number($('#wKeep').value) || 10
        }
      });
      toast('WebDAV 配置已保存', 'ok');
      await loadAdminData(true);
      showCronBox(res.cronToken);
    }));

    /* ---- 测试连接 ---- */
    $('#wTest').addEventListener('click', withBusy($('#wTest'), async () => {
      $('#wTestResult').innerHTML = '<div class="notice info"><span class="spinner-sm spinner-dark"></span> 正在测试连接…</div>';
      const res = await api(API.webdav, { method: 'POST', body: { action: 'test' } });
      $('#wTestResult').innerHTML = res.ok
        ? '<div class="notice ok">✅ 连接成功（HTTP ' + res.status + '）<br><span style="font-size:11.5px;opacity:.8">' + esc(res.target) + '</span></div>'
        : '<div class="notice warn">⚠️ ' + esc(res.error || res.message || '连接失败') + '</div>';
    }));

    /* ---- 删除配置 ---- */
    const wDel = $('#wDel');
    if (wDel) {
      wDel.addEventListener('click', withBusy(wDel, async () => {
        if (!confirmBox('确定删除 WebDAV 配置？已上传到网盘的备份文件不会被删除。')) return;
        await api(API.webdav, { method: 'POST', body: { action: 'delete' } });
        toast('配置已删除', 'ok');
        await loadAdminData(true);
      }));
    }

    /* ---- 立即备份 ---- */
    $('#wBackupNow').addEventListener('click', withBusy($('#wBackupNow'), async () => {
      const res = await api(API.webdav, { method: 'POST', body: { action: 'backup' } });
      if (res.ok) {
        toast('备份成功：' + fmtBytes(res.result.bytes) + ' · ' + (res.result.links || 0) + ' 个书签', 'ok', 3200);
      } else {
        toast('备份失败：' + (res.result && res.result.error || '未知错误'), 'err', 5000);
      }
      await loadAdminData(true);
    }));

    /* ---- 列出云端备份 ---- */
    $('#wList').addEventListener('click', withBusy($('#wList'), async () => {
      const host = $('#wFileList');
      host.innerHTML = '<div class="notice info"><span class="spinner-sm spinner-dark"></span> 正在读取 WebDAV 目录…</div>';
      const res = await api(API.webdav, { method: 'POST', body: { action: 'list' } });
      const files = res.files || [];
      if (files.length === 0) {
        host.innerHTML = '<div class="notice warn">云端目录下没有找到 .json 备份文件。请先执行一次「立即备份」。</div>';
        return;
      }
      host.innerHTML = '<div class="file-list">' + files.map((f, i) =>
        '<div class="file-item">' +
          '<div class="fi-name">' + esc(f.name) + (f.isLatest ? ' <span class="badge badge-blue">最新</span>' : '') +
            '<div class="fi-meta">' + esc(f.modified ? fmtTime(f.modified) : '') + (f.size ? ' · ' + fmtBytes(f.size) : '') + '</div></div>' +
          '<button class="btn btn-soft btn-sm" type="button" data-restore="' + i + '">恢复此备份</button>' +
        '</div>').join('') + '</div>';
      host.querySelectorAll('[data-restore]').forEach(btn => {
        btn.addEventListener('click', withBusy(btn, async () => {
          const f = files[Number(btn.dataset.restore)];
          if (!confirmBox('将从「' + f.name + '」恢复，覆盖当前全部书签、分组与外观设置。此操作不可撤销，建议先手动备份一次。')) return;
          const r = await api(API.webdav, { method: 'POST', body: { action: 'restore', href: f.href } });
          toast('恢复成功：' + (r.links || 0) + ' 个书签、' + (r.groups || 0) + ' 个分组', 'ok', 3600);
          await loadAdminData(true);
        }));
      });
    }));

    /* ---- 从最新备份恢复 ---- */
    $('#wRestoreLatest').addEventListener('click', withBusy($('#wRestoreLatest'), async () => {
      if (!confirmBox('将从云端 navbox-latest.json 恢复，覆盖当前全部书签、分组与外观设置。此操作不可撤销，建议先手动备份一次。')) return;
      const r = await api(API.webdav, { method: 'POST', body: { action: 'restore' } });
      toast('恢复成功：' + (r.links || 0) + ' 个书签、' + (r.groups || 0) + ' 个分组', 'ok', 3600);
      await loadAdminData(true);
    }));

    drawLog();

    // 若已配置过，尝试取回 cron 令牌展示
    if (w.url) {
      api(API.webdav, { method: 'POST', body: { action: 'cronToken' } })
        .then(r => showCronBox(r.cronToken))
        .catch(() => {});
    }
  }

  /* ============================================================
   * 标签页 6：账号安全
   * ============================================================ */
  function renderAccountTab() {
    const d = S.data;
    if (!d) return;
    const acc = d.account || {};

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.innerHTML =
      '<div class="section-head-bar"><h3>🔐 管理员账号</h3></div>' +
      (acc.isDefault ? '<div class="notice warn">⚠️ 当前仍在使用初始默认密码 <code>admin123</code>，' +
        '任何人都可能登录并修改你的书签，<b>请立即修改</b>。</div>' : '') +

      '<div class="section-card"><h3><span class="h-ico">👤</span>当前账号</h3>' +
        '<div class="kv-row"><span class="k">用户名</span><span class="v">' + esc(acc.username || S.username || 'admin') + '</span></div>' +
        '<div class="kv-row"><span class="k">密码状态</span><span class="v">' + (acc.isDefault ? '默认密码（未修改）' : '已自定义') + '</span></div>' +
        '<div class="kv-row"><span class="k">最近修改</span><span class="v">' + esc(fmtTime(acc.updatedAt)) + '</span></div>' +
        '<div class="kv-row"><span class="k">会话有效期</span><span class="v">7 天（HttpOnly Cookie）</span></div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">🔑</span>修改用户名与密码</h3>' +
        '<div class="notice info" style="font-size:12px">用户名和密码可以只改其中一项：把不需要修改的输入框留空即可。' +
        '修改密码后，其它设备上的登录会话会全部失效，需要重新登录。</div>' +
        '<div class="field"><label>当前密码<span class="req">*</span></label>' +
          '<input class="input" id="aCur" type="password" autocomplete="current-password" placeholder="用于身份校验"></div>' +
        '<hr class="divider">' +
        '<div class="field"><label>新用户名（留空表示不修改）</label>' +
          '<input class="input" id="aUser" maxlength="32" autocomplete="off" placeholder="2-32 位字母、数字及 _ . @ - 字符"></div>' +
        '<div class="field"><label>新密码（留空表示不修改）</label>' +
          '<input class="input" id="aPass" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>' +
        '<div class="field"><label>确认新密码</label>' +
          '<input class="input" id="aPass2" type="password" autocomplete="new-password" placeholder="再输入一次"></div>' +
        '<div class="field"><label>密码强度</label>' +
          '<div style="height:7px;border-radius:4px;background:#e9ecf4;overflow:hidden">' +
            '<div id="pwBar" style="height:100%;width:0;background:#e6483d;transition:width .2s,background .2s"></div></div>' +
          '<div class="field-hint" id="pwHint">建议 12 位以上，混合大小写字母、数字与符号。</div></div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-primary btn-sm" id="aSave" type="button">保存修改</button>' +
          '<button class="btn btn-ghost btn-sm" id="aGen" type="button">🎲 生成随机强密码</button>' +
        '</div>' +
      '</div>' +

      '<div class="section-card"><h3><span class="h-ico">🛡️</span>安全说明</h3>' +
        '<div class="kv-row"><span class="k">密码存储方式</span><span class="v">PBKDF2-SHA256，60000 轮 + 随机盐</span></div>' +
        '<div class="kv-row"><span class="k">会话令牌</span><span class="v">HMAC-SHA256 签名，HttpOnly + Secure Cookie</span></div>' +
        '<div class="kv-row"><span class="k">登录限流</span><span class="v">同 IP 连续失败 5 次锁定 10 分钟</span></div>' +
        '<div class="kv-row"><span class="k">私密书签</span><span class="v">仅管理员登录后可见，接口层面过滤</span></div>' +
        '<div class="notice warn" style="margin-top:12px;font-size:12px">' +
          '本系统为单管理员设计，不区分多用户。忘记管理员密码时，可在 EdgeOne 控制台 KV 数据管理中删除键 ' +
          '<code>navbox_admin</code>，系统会自动重建默认账号（<b>书签数据不受影响</b>）。' +
        '</div>' +
      '</div>';

    $('#tabHost').innerHTML = '';
    $('#tabHost').appendChild(panel);

    /* 密码强度 */
    const passEl = $('#aPass');
    passEl.addEventListener('input', () => {
      const v = passEl.value;
      let score = 0;
      if (v.length >= 8) score++;
      if (v.length >= 12) score++;
      if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      const pct = Math.min(100, (score / 5) * 100);
      const bar = $('#pwBar');
      bar.style.width = (v ? Math.max(8, pct) : 0) + '%';
      bar.style.background = pct < 40 ? '#e6483d' : pct < 75 ? '#f6a623' : '#22c1a4';
      const labels = ['太弱', '较弱', '一般', '较强', '很强', '极强'];
      $('#pwHint').textContent = v ? ('强度：' + labels[score] + '（建议 12 位以上，混合大小写、数字与符号）')
        : '建议 12 位以上，混合大小写字母、数字与符号。';
    });

    $('#aGen').addEventListener('click', () => {
      const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      const lower = 'abcdefghijkmnopqrstuvwxyz';
      const digit = '23456789';
      const sym = '!@#$%^&*-_=+';
      const all = upper + lower + digit + sym;
      const buf = new Uint32Array(18);
      crypto.getRandomValues(buf);
      let pw = '';
      // 保证四类字符各至少一个
      const pools = [upper, lower, digit, sym];
      pools.forEach((p, i) => { pw += p[buf[i] % p.length]; });
      for (let i = pools.length; i < 18; i++) pw += all[buf[i] % all.length];
      // 打乱顺序
      const arr = pw.split('');
      const shuf = new Uint32Array(arr.length);
      crypto.getRandomValues(shuf);
      for (let i = arr.length - 1; i > 0; i--) {
        const j = shuf[i] % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      passEl.value = arr.join('');
      $('#aPass2').value = passEl.value;
      passEl.dispatchEvent(new Event('input'));
      toast('已生成 18 位随机密码，请立即保存到密码管理器', 'ok', 4000);
    });

    $('#aSave').addEventListener('click', withBusy($('#aSave'), async () => {
      const cur = $('#aCur').value;
      const newUser = $('#aUser').value.trim();
      const np = $('#aPass').value;
      const np2 = $('#aPass2').value;
      if (!cur) { toast('请输入当前密码', 'err'); return; }
      if (!newUser && !np) { toast('请至少填写一项要修改的内容', 'err'); return; }
      if (np && np !== np2) { toast('两次输入的新密码不一致', 'err'); return; }
      if (np && np.length < 8) { toast('新密码至少 8 位', 'err'); return; }

      const res = await api(API.account, {
        method: 'POST',
        body: { currentPassword: cur, newUsername: newUser, newPassword: np }
      });
      S.username = res.username;
      $('#aCur').value = ''; $('#aPass').value = ''; $('#aPass2').value = ''; $('#aUser').value = '';
      passEl.dispatchEvent(new Event('input'));
      $('#adminHeadText').textContent = '管理后台 · ' + (S.username || 'admin');
      if (window.NavBox) window.NavBox.refreshAdminEntry();
      await loadAdminData(true);
      toast(res.passwordChanged
        ? '账号已更新，其它设备的登录会话已失效'
        : '用户名已更新', 'ok', 3600);
    }));
  }

  /* ============================================================
   * 导出模块
   * ============================================================ */
  window.NavBoxAdmin = {
    open: open,
    close: close,
    syncAuth: syncAuth,
    reload: loadAdminData
  };
})();
