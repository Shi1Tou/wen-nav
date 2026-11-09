/* ============================================================
 * NavBox 导航页 - 前台逻辑
 * 职责：拉取数据 / 应用设置 / 渲染分组与书签 / 搜索 / 主题 / 图标回退
 * ============================================================ */
(function () {
  'use strict';

  const API = {
    bootstrap: '/api/bootstrap',
    track: '/api/track'
  };

  const LS = {
    theme: 'navbox_theme',
    collapsed: 'navbox_collapsed'
  };

  /* ---------------- 状态 ---------------- */
  const state = {
    settings: null,
    groups: [],
    links: [],
    background: null,
    isAdmin: false,
    username: null,
    query: '',
    // 用户在前台手动切换的主题（null = 未手动切换，采用管理员在后台设置的主题）
    themeOverride: null,
    // 卡片配色计算依据（由 applySettings 写入）
    cardAlpha: 0.82,
    cardBgColor: '#ffffff',
    userTextColor: '#1f2430',
    collapsed: {}
  };

  /* ---------------- 工具 ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 搜索高亮：先转义再按关键词包裹 mark */
  function highlight(text, query) {
    const safe = esc(text);
    if (!query) return safe;
    const q = query.trim();
    if (!q) return safe;
    // 转义正则特殊字符
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return safe.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark class="hit">$1</mark>');
    } catch (e) {
      return safe;
    }
  }

  function toast(msg, type, ms) {
    const host = $('#toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    host.appendChild(el);
    const life = ms || 2600;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, life);
  }

  function getDomain(url) {
    try {
      return new URL(url, location.origin).hostname.replace(/^www\./i, '');
    } catch (e) {
      return '';
    }
  }

  /** 由域名生成稳定的文字图标配色 */
  function textIconStyle(seed) {
    const palette = [
      ['#5b8cff', '#7c5bff'], ['#ff7a59', '#ff4f81'], ['#22c1a4', '#0ea5a4'],
      ['#f6a623', '#f2762e'], ['#8b5cf6', '#c026d3'], ['#06b6d4', '#3b82f6'],
      ['#ef4444', '#f97316'], ['#10b981', '#84cc16'], ['#6366f1', '#0ea5e9'],
      ['#ec4899', '#f43f5e']
    ];
    let h = 0;
    const s = String(seed || 'x');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const pair = palette[h % palette.length];
    return 'background:linear-gradient(135deg,' + pair[0] + ',' + pair[1] + ')';
  }

  function firstChar(title) {
    const t = String(title || '').trim();
    if (!t) return '?';
    // 中文取首字，英文取首字母大写
    return /[\u4e00-\u9fa5]/.test(t[0]) ? t[0] : t[0].toUpperCase();
  }

  /* ---------------- 图标源 ---------------- */

  function providerUrl(provider, domain) {
    if (!domain) return '';
    switch (provider) {
      case 'icon.horse':
        return 'https://icon.horse/icon/' + encodeURIComponent(domain);
      case 'google':
        return 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=64&url=' + encodeURIComponent('https://' + domain);
      case 'direct':
        return 'https://' + domain + '/favicon.ico';
      case 'favicon.im':
      default:
        return 'https://favicon.im/' + encodeURIComponent(domain) + '?larger=true';
    }
  }

  /** 生成图标候选链：自定义 → 用户配置的 provider → 常见回退源 */
  function iconCandidates(link) {
    const out = [];
    const domain = getDomain(link.url);
    const provider = (state.settings && state.settings.favicon && state.settings.favicon.provider) || 'favicon.im';

    if (link.icon && (link.iconType === 'custom' || provider === 'custom')) {
      out.push(link.icon);
    }
    out.push(providerUrl(provider, domain));
    // 回退链
    ['favicon.im', 'icon.horse', 'google', 'direct'].forEach(p => {
      if (p !== provider) {
        const u = providerUrl(p, domain);
        if (u && out.indexOf(u) === -1) out.push(u);
      }
    });
    return out.filter(Boolean);
  }

  /** 渲染图标：依次尝试候选源，全部失败则显示首字文字图标 */
  function buildIcon(link) {
    const box = document.createElement('div');
    box.className = 'c-icon';
    const domain = getDomain(link.url);

    const showText = () => {
      box.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'txt';
      span.textContent = firstChar(link.title || domain);
      span.setAttribute('style', textIconStyle(domain || link.title));
      box.appendChild(span);
    };

    // iconType=text 时强制文字图标
    if (link.iconType === 'text') { showText(); return box; }

    const cands = iconCandidates(link);
    if (cands.length === 0) { showText(); return box; }

    let idx = 0;
    const tryNext = () => {
      if (idx >= cands.length) { showText(); return; }
      const src = cands[idx++];
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.onload = () => {
        // 过滤 1x1 占位图与明显的错误图
        if (img.naturalWidth <= 1 || img.naturalHeight <= 1) { tryNext(); return; }
        box.innerHTML = '';
        box.appendChild(img);
      };
      img.onerror = tryNext;
      img.src = src;
    };
    tryNext();
    return box;
  }

  /* ---------------- 应用设置 ---------------- */

  function hexToRgba(hex, alpha) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'rgba(255,255,255,' + alpha + ')';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function applySettings() {
    const s = state.settings;
    if (!s) return;
    const root = document.documentElement;
    const card = s.card || {};
    const layout = s.layout || {};
    const bg = s.background || {};

    // 数值型设置：用 != null 判断，避免把用户显式设置的 0 误当缺省值
    const num = (v, d) => (v == null || v === '' || !isFinite(Number(v)) ? d : Number(v));

    root.style.setProperty('--card-blur', num(card.blur, 12) + 'px');
    root.style.setProperty('--card-radius', num(card.radius, 14) + 'px');
    root.style.setProperty('--min-card-w', num(layout.minCardWidth, 168) + 'px');
    root.style.setProperty('--bg-blur', num(bg.blur, 0) + 'px');
    root.style.setProperty('--bg-brightness', num(bg.brightness, 100) + '%');
    root.style.setProperty('--bg-overlay', num(bg.overlay, 30) / 100);

    // 透明度、背景色与文字色（文字色最终由 applyCardColors 按可读性决定）
    state.cardAlpha = Math.max(0, Math.min(1, num(card.opacity, 82) / 100));
    state.cardBgColor = card.bgColor || '#ffffff';
    state.userTextColor = card.textColor || '#1f2430';

    document.body.classList.toggle('no-desc', layout.showDesc === false);
    document.body.classList.toggle('dense-mobile', !!layout.denseMobile);
    document.body.classList.toggle('hover-scale', card.hoverScale !== false);

    // 文案
    if (s.siteTitle) {
      document.title = s.siteTitle;
      $('#heroTitle').textContent = s.siteTitle;
      $('#brandText').textContent = s.siteTitle;
    }
    $('#heroSubtitle').textContent = s.siteSubtitle || '';
    $('#heroSubtitle').style.display = s.siteSubtitle ? '' : 'none';
    const f = $('#footer');
    f.innerHTML = s.footer ? linkify(esc(s.footer)) : '';
    f.style.display = s.footer ? '' : 'none';

    const search = s.search || {};
    const input = $('#searchInput');
    input.placeholder = search.placeholder || '搜索书签…';
    $('#searchWrap').style.display = search.enabled === false ? 'none' : '';

    applyBackground();
    applyTheme();
  }

  function linkify(safeHtml) {
    return String(safeHtml).replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>'
    );
  }

  /**
   * 依据当前明暗模式计算并注入卡片配色。
   * 原则：用户选择的颜色优先，但必须保证可读性——
   * 若用户设置的文字色与实际底色对比度不足（WCAG < 3），自动纠正为可读的深/浅色，
   * 否则深色模式下会出现「深灰字压深色底」的不可读情况。
   */
  function applyCardColors(isDark) {
    const root = document.documentElement;
    const alpha = state.cardAlpha != null ? state.cardAlpha : 0.82;
    const base = normalizeHex(state.cardBgColor) || '#ffffff';

    // 页面底层近似色：背景可能是图片或渐变，无法精确取色，
    // 这里用主题近似值参与 alpha 混合，估算卡片实际可见的等效底色
    const pageBg = isDark ? '#0e1119' : '#f4f6fa';

    let groupHex, itemCss, itemHoverCss;
    if (isDark) {
      // 深色模式下把用户所选色压暗，保证与深色背景协调
      groupHex = shadeColor(base, -0.82);
      itemCss = 'rgba(255,255,255,' + (alpha * 0.08).toFixed(3) + ')';
      itemHoverCss = 'rgba(255,255,255,' + (alpha * 0.15).toFixed(3) + ')';
    } else {
      groupHex = base;
      // 单卡片比容器略实，形成层次
      itemCss = hexToRgba(base, Math.min(1, alpha * 0.78 + 0.2));
      itemHoverCss = hexToRgba(base, Math.min(1, alpha * 0.5 + 0.5));
    }

    const effBg = blendOver(groupHex, alpha, pageBg);

    const wanted = normalizeHex(state.userTextColor) || (isDark ? '#e8ebf2' : '#1f2430');
    const text = ensureReadableText(wanted, effBg);

    root.style.setProperty('--card-bg-solid', hexToRgba(groupHex, alpha));
    root.style.setProperty('--card-bg-item', itemCss);
    root.style.setProperty('--card-bg-item-hover', itemHoverCss);
    root.style.setProperty('--card-text', text);

    // 边框与次要文字按实际等效底色的明暗自适应
    const onDark = !isDarkText(effBg);
    root.style.setProperty('--muted', onDark ? 'rgba(196,205,220,.82)' : 'rgba(120,130,150,.95)');
    root.style.setProperty('--item-border', onDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.055)');
    root.style.setProperty('--border', onDark ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.55)');
  }

  /** 归一化颜色为 #rrggbb；非法值返回 null */
  function normalizeHex(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toLowerCase() : null;
  }

  function hexToRgb(hex) {
    const h = normalizeHex(hex);
    if (!h) return [0, 0, 0];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  /** WCAG 相对亮度 */
  function relLum(rgb) {
    const a = rgb.map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }

  /** WCAG 对比度，范围 1 ~ 21 */
  function contrastRatio(hexA, hexB) {
    const la = relLum(hexToRgb(hexA));
    const lb = relLum(hexToRgb(hexB));
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** 半透明前景叠加到不透明底色上的等效色 */
  function blendOver(fgHex, alpha, bgHex) {
    const fg = hexToRgb(fgHex), bg = hexToRgb(bgHex);
    const a = Math.max(0, Math.min(1, alpha));
    const out = fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
    return '#' + out.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  /** 文字色可读性兜底：对比度不足时在黑/白中取更优者 */
  function ensureReadableText(textHex, bgHex) {
    if (contrastRatio(textHex, bgHex) >= 3) return textHex;
    const white = '#ffffff', nearBlack = '#101418';
    return contrastRatio(white, bgHex) >= contrastRatio(nearBlack, bgHex) ? white : nearBlack;
  }

  /** 按亮度判断背景上应使用深色还是浅色文字 */
  function isDarkText(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return true;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    // 相对亮度（WCAG）
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.55;
  }

  /** 将颜色按比例变暗(amount<0)或变亮(amount>0)，返回 #rrggbb */
  function shadeColor(hex, amount) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#1a1e2a';
    const mix = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const out = [0, 2, 4].map(i => {
      const c = parseInt(h.substr(i, 2), 16);
      return Math.round(c + (mix - c) * p);
    });
    return '#' + out.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  function applyBackground() {
    const bg = state.settings && state.settings.background;
    const layer = $('#bgLayer');
    if (!bg) {
      layer.style.backgroundImage = '';
      layer.style.background = 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)';
      return;
    }
    if (bg.type === 'upload' && state.background && state.background.dataUrl) {
      layer.style.backgroundImage = 'url("' + state.background.dataUrl + '")';
    } else if (bg.type === 'url' && bg.url) {
      layer.style.backgroundImage = 'url("' + bg.url.replace(/"/g, '%22') + '")';
    } else {
      layer.style.backgroundImage = '';
      layer.style.background = bg.gradient || 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)';
      return;
    }
    layer.style.background = '';
    // 图片加载失败时回退到渐变，避免露出白底
    const probe = new Image();
    probe.onerror = () => {
      layer.style.backgroundImage = '';
      layer.style.background = bg.gradient || 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)';
    };
    probe.src = bg.type === 'upload' ? state.background.dataUrl : bg.url;
  }

  function applyTheme() {
    // 优先级：用户本地手动切换 > 管理员在后台设置的主题 > 跟随系统
    const adminTheme = (state.settings && state.settings.theme) || 'auto';
    const pref = state.themeOverride || adminTheme;
    const dark = pref === 'dark' || (pref === 'auto' &&
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-light', !dark);
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#12141c' : '#4f7cff');
    applyCardColors(dark);
  }

  /* ---------------- 渲染 ---------------- */

  function renderError(title, detail) {
    $('#content').innerHTML =
      '<div class="err-banner"><b>' + esc(title) + '</b>' + esc(detail || '') + '</div>';
  }

  function render() {
    const host = $('#content');
    const q = state.query.trim().toLowerCase();

    let links = state.links.slice();
    if (q) {
      links = links.filter(l =>
        (l.title || '').toLowerCase().indexOf(q) > -1 ||
        (l.url || '').toLowerCase().indexOf(q) > -1 ||
        (l.desc || '').toLowerCase().indexOf(q) > -1 ||
        groupName(l.groupId).toLowerCase().indexOf(q) > -1
      );
    }

    if (links.length === 0) {
      if (state.links.length === 0) {
        host.innerHTML =
          '<div class="empty"><div class="big">📭</div><p>还没有任何书签</p>' +
          '<p class="hint">点击右上角 ⚙ 登录管理后台，添加你的第一个书签分组</p></div>';
      } else {
        host.innerHTML =
          '<div class="empty"><div class="big">🔍</div><p>没有找到匹配「' + esc(state.query) + '」的书签</p>' +
          '<p class="hint">试试其他关键词，或清空搜索框</p></div>';
      }
      return;
    }

    const byGroup = {};
    links.forEach(l => {
      const gid = l.groupId || '__none__';
      (byGroup[gid] = byGroup[gid] || []).push(l);
    });

    const groups = state.groups.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const orderedGids = groups.map(g => g.id).filter(id => byGroup[id]);
    Object.keys(byGroup).forEach(id => { if (orderedGids.indexOf(id) === -1) orderedGids.push(id); });

    const frag = document.createDocumentFragment();
    const searchOpenNewTab = !(state.settings && state.settings.search && state.settings.search.openInNewTab === false);

    orderedGids.forEach(gid => {
      const items = byGroup[gid];
      const g = groups.find(x => x.id === gid);
      const gName = g ? g.name : '未分组';
      const gIcon = g ? (g.icon || '📁') : '📁';
      const collapsed = state.query ? false : !!state.collapsed[gid];

      const sec = document.createElement('section');
      sec.className = 'group' + (collapsed ? ' collapsed' : '');
      sec.dataset.gid = gid;

      const head = document.createElement('div');
      head.className = 'group-head';
      head.innerHTML =
        '<span class="g-icon">' + esc(gIcon) + '</span>' +
        '<span class="g-name">' + highlight(gName, state.query) + '</span>' +
        '<span class="g-count">' + items.length + '</span>' +
        '<span class="g-arrow">▼</span>';
      head.addEventListener('click', () => {
        sec.classList.toggle('collapsed');
        if (!state.query) {
          state.collapsed[gid] = sec.classList.contains('collapsed');
          try { localStorage.setItem(LS.collapsed, JSON.stringify(state.collapsed)); } catch (e) {}
        }
      });

      const wrap = document.createElement('div');
      wrap.className = 'grid-wrap';
      const grid = document.createElement('div');
      grid.className = 'grid';

      items.forEach(l => {
        const a = document.createElement('a');
        a.className = 'card';
        a.href = l.url;
        a.target = searchOpenNewTab ? '_blank' : '_self';
        a.rel = 'noopener noreferrer nofollow';
        a.title = l.title + (l.desc ? ' — ' + l.desc : '') + '\n' + l.url;
        a.dataset.id = l.id;

        a.appendChild(buildIcon(l));

        const body = document.createElement('div');
        body.className = 'c-body';
        body.innerHTML =
          '<div class="c-title">' + highlight(l.title, state.query) + '</div>' +
          (l.desc ? '<div class="c-desc">' + highlight(l.desc, state.query) + '</div>' : '');
        a.appendChild(body);

        if (l.visibility === 'private' && state.isAdmin &&
            !(state.settings && state.settings.privateBadge === false)) {
          const badge = document.createElement('span');
          badge.className = 'c-badge';
          badge.textContent = '私密';
          badge.title = '此书签仅管理员登录后可见';
          a.appendChild(badge);
        }

        a.addEventListener('click', () => trackClick(l.id));
        grid.appendChild(a);
      });

      wrap.appendChild(grid);
      sec.appendChild(head);
      sec.appendChild(wrap);
      frag.appendChild(sec);
    });

    host.innerHTML = '';
    host.appendChild(frag);
  }

  function groupName(gid) {
    const g = state.groups.find(x => x.id === gid);
    return g ? g.name : '未分组';
  }

  let trackQueue = null;
  function trackClick(id) {
    // 点击计数为尽力而为，失败不影响跳转
    if (!navigator.sendBeacon) return;
    try {
      const blob = new Blob([JSON.stringify({ id: id })], { type: 'application/json' });
      navigator.sendBeacon(API.track, blob);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadBootstrap() {
    const res = await fetch(API.bootstrap, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || '未知错误');
    return data;
  }

  function applyData(data) {
    state.settings = data.settings || {};
    state.groups = data.groups || [];
    state.links = data.links || [];
    state.background = data.background || null;
    state.isAdmin = !!data.isAdmin;
    state.username = data.username || null;
    applySettings();
    render();
    refreshAdminEntry();
  }

  async function init() {
    // 本地折叠状态
    try {
      const raw = localStorage.getItem(LS.collapsed);
      if (raw) state.collapsed = JSON.parse(raw) || {};
    } catch (e) { state.collapsed = {}; }

    // 主题偏好：仅当用户此前手动切换过时才覆盖后台设置，否则跟随管理员配置
    try {
      const t = localStorage.getItem(LS.theme);
      state.themeOverride = (t && ['auto', 'light', 'dark'].indexOf(t) > -1) ? t : null;
    } catch (e) { state.themeOverride = null; }
    applyTheme();
    startClock();

    try {
      const data = await loadBootstrap();
      applyData(data);
    } catch (e) {
      const isKv = String(e.message || '').indexOf('KV_NOT_BOUND') > -1;
      renderError(
        isKv ? '后端存储未就绪' : '加载失败：' + (e.message || e),
        isKv
          ? '请在 EdgeOne(Makers) 控制台完成两步：① 开通 KV 存储并创建命名空间；② 进入项目 → KV 存储 → 绑定命名空间，变量名填 NAV_KV，然后重新部署。'
          : '本地直接打开 HTML 无法访问 /api 接口。请使用 edgeone dev 本地调试，或部署到 EdgeOne Pages 后访问线上地址。'
      );
      // 仍然给出可用的界面壳
      state.settings = {
        siteTitle: 'NavBox 导航', siteSubtitle: '尚未连接到后端数据',
        background: { type: 'gradient', gradient: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', overlay: 30 },
        card: { opacity: 82, blur: 12, radius: 14, textColor: '#1f2430', bgColor: '#ffffff', hoverScale: true },
        layout: { minCardWidth: 168, showDesc: true, showGroupIcon: true },
        favicon: { provider: 'favicon.im' },
        search: { enabled: true, placeholder: '搜索书签…', openInNewTab: true },
        footer: ''
      };
      applySettings();
    }
  }

  /* ---------------- 时钟 ---------------- */

  function startClock() {
    const el = $('#heroClock');
    if (!el) return;
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const tick = () => {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      el.textContent = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 星期' +
        week[d.getDay()] + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------- 搜索 ---------------- */

  function bindSearch() {
    const input = $('#searchInput');
    const wrap = $('#searchWrap');
    const clear = $('#searchClear');
    let timer = null;
    input.addEventListener('input', () => {
      wrap.classList.toggle('has-val', input.value.length > 0);
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.query = input.value;
        render();
      }, 110);
    });
    clear.addEventListener('click', () => {
      input.value = '';
      wrap.classList.remove('has-val');
      state.query = '';
      render();
      input.focus();
    });
    // 快捷键：/ 或 Ctrl+K 聚焦搜索，Esc 退出
    document.addEventListener('keydown', e => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === 'Escape' && typing && e.target === input) {
        input.blur();
      }
    });
  }

  /* ---------------- 主题切换 ---------------- */

  function bindTheme() {
    $('#themeBtn').addEventListener('click', () => {
      // 以当前实际生效的偏好为起点循环，避免后台设了 dark 时点击跳变
      const adminTheme = (state.settings && state.settings.theme) || 'auto';
      const current = state.themeOverride || adminTheme;
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(current) + 1) % order.length];
      state.themeOverride = next;
      try { localStorage.setItem(LS.theme, next); } catch (e) {}
      applyTheme();
      const label = { auto: '跟随系统', light: '浅色', dark: '深色' }[next];
      toast('主题：' + label);
    });
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          const adminTheme = (state.settings && state.settings.theme) || 'auto';
          if ((state.themeOverride || adminTheme) === 'auto') applyTheme();
        });
      } catch (e) {}
    }
  }

  /* ---------------- 管理入口 ---------------- */

  function refreshAdminEntry() {
    const btn = $('#adminBtn');
    if (!btn) return;
    btn.classList.toggle('on', !!state.isAdmin);
    btn.title = state.isAdmin ? ('管理后台（已登录：' + (state.username || 'admin') + '）') : '管理后台登录';
    if (window.NavBoxAdmin && typeof window.NavBoxAdmin.syncAuth === 'function') {
      window.NavBoxAdmin.syncAuth(state.isAdmin, state.username);
    }
  }

  function bindAdmin() {
    $('#adminBtn').addEventListener('click', () => {
      if (window.NavBoxAdmin) window.NavBoxAdmin.open();
      else toast('管理模块未加载', 'err');
    });
    $('#adminClose').addEventListener('click', () => {
      if (window.NavBoxAdmin) window.NavBoxAdmin.close();
    });
    $('#adminMask').addEventListener('click', e => {
      if (e.target === e.currentTarget && window.NavBoxAdmin) window.NavBoxAdmin.close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('#adminMask') && !$('#adminMask').hidden && window.NavBoxAdmin) {
        // 仅在无二级弹窗时关闭
        if (!document.querySelector('.sub-modal:not([hidden])')) window.NavBoxAdmin.close();
      }
    });
  }

  /* ---------------- 对外接口（供 admin.js 调用） ---------------- */

  window.NavBox = {
    state: state,
    toast: toast,
    render: render,
    applySettings: applySettings,
    esc: esc,
    getDomain: getDomain,
    reload: async function (silent) {
      try {
        const data = await loadBootstrap();
        applyData(data);
        if (!silent) toast('已刷新', 'ok', 1400);
      } catch (e) {
        if (!silent) toast('刷新失败：' + (e.message || e), 'err');
      }
    },
    refreshAdminEntry: refreshAdminEntry,
    /**
     * 供后台局部更新，避免整页刷新。
     * styleOnly=true 时只重算样式变量，不重建 DOM：
     * 后台拖动滑杆做实时预览时用，否则每次都会重新加载全部图标造成闪烁与重复请求。
     */
    patch: function (data, styleOnly) {
      if (data.settings) { state.settings = data.settings; }
      if (data.groups) { state.groups = data.groups; }
      if (data.links) { state.links = data.links; }
      if (data.background !== undefined) { state.background = data.background; }
      if (data.isAdmin !== undefined) { state.isAdmin = !!data.isAdmin; state.username = data.username || state.username; }
      if (styleOnly) {
        const s = state.settings || {};
        const card = s.card || {};
        const layout = s.layout || {};
        state.cardAlpha = Math.max(0, Math.min(1, Number(card.opacity == null ? 82 : card.opacity) / 100));
        state.cardBgColor = card.bgColor || '#ffffff';
        state.userTextColor = card.textColor || state.userTextColor;
        const root = document.documentElement;
        root.style.setProperty('--card-blur', (card.blur == null ? 12 : card.blur) + 'px');
        root.style.setProperty('--card-radius', (card.radius == null ? 14 : card.radius) + 'px');
        root.style.setProperty('--min-card-w', (layout.minCardWidth || 168) + 'px');
        root.style.setProperty('--bg-blur', ((s.background && s.background.blur) || 0) + 'px');
        root.style.setProperty('--bg-brightness', ((s.background && s.background.brightness) || 100) + '%');
        root.style.setProperty('--bg-overlay', ((s.background && s.background.overlay == null) ? 30 : s.background.overlay) / 100);
        document.body.classList.toggle('no-desc', layout.showDesc === false);
        document.body.classList.toggle('dense-mobile', !!layout.denseMobile);
        document.body.classList.toggle('hover-scale', card.hoverScale !== false);
        applyBackground();
        applyTheme();
        return;
      }
      applySettings();
      render();
      refreshAdminEntry();
    }
  };

  /* ---------------- 启动 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    bindSearch();
    bindTheme();
    bindAdmin();
    init();
  });
})();
