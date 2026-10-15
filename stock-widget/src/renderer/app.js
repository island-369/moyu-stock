'use strict';
/* 行情小窗 · 渲染层主逻辑（无框架、零网络请求，全部经 IPC） */

const $ = (s) => document.querySelector(s);
const app = $('#app');

const IS_SMOKE = new URLSearchParams(location.search).has('smoke');
if (IS_SMOKE) document.body.classList.add('smoke-bg');

const SVG = {
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.2 8h9.6"/></svg>',
  magnifier: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4l3 3"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
  news: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4.5 2.2l7.6 6.1-3.4.6 1.5 3.4-1.7.8-1.6-3.4-2.4 2z"/></svg>',  set: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="5.5" stroke-width="2.4" stroke-dasharray="2.88 2.88"/><circle cx="8" cy="8" r="3.5" stroke-width="1.9"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6l2 4.1 4.5.6-3.3 3.1.8 4.5L8 11.7l-4 2.2.8-4.5L1.5 6.3 6 5.7z"/></svg>',
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.6 8s2.4-4.1 6.4-4.1S14.4 8 14.4 8s-2.4 4.1-6.4 4.1S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2.1"/></svg>',
};

let settings = null;
let state = null;
let obMode = 'cloud';
let newsOpen = false;
let newsTimer = null;
let toastTimer = null;
let measureTimer = null;
let pendingVis = false; // 迷你条点眼睛：待切回完整形态后自动展开面板
let settingsVis = false; // 设置窗是否可见（可见时标题栏也要可点击）
let suppressClick = false;
let dragging = null;
let lastDragY = 0;
let penOn = false;
let meetingOn = false; // 会议模式运行时状态（主进程经 evt:meeting 广播）
let alphaT = null;

const prevPrices = new Map();
const rowEls = new Map();
const sparkCache = new Map();

/* ---------------- 工具 ---------------- */

function hhmm(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function hhmmss(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
}
/** 裸 6 位数字的简易市场猜测（搜索接口不可用时的兜底） */
function guessMarket(code) {
  if (/^(6|5)/.test(code)) return 'SH';
  if (/^(4|8|92)/.test(code)) return 'BJ';
  return 'SZ';
}
function toast(text, ms) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2800);
}
function measureSoon() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    if (!settings) return;
    const list = $('#list');
    // 迷你条：窗口高度 = 实测标题栏高度（精确贴齐，不残留空白）
    if (settings.window.form === 'mini') {
      const tb = $('#titlebar');
      const h = Math.max(30, Math.round(tb.offsetHeight + 7));
      widget.invoke('app:win:height', { height: h }).catch(() => {});
      syncPopExpand();
      autoScroll.sync(); // 迷你条下列表隐藏，视为无需轮播
      return;
    }
    const inner = $('#listinner');
    if (settings.appearance.autoHeight) {
      // 内层不受 flex 拉伸，offsetHeight 即真实内容高；+6 是 #list 的上下 padding
      const natural = app.offsetHeight - list.clientHeight + inner.offsetHeight + 6;
      const h = Math.max(240, Math.round(natural));
      widget.invoke('app:win:height', { height: h }).catch(() => {});
    }
    if (settings.appearance.autoWidth) {
      // max-content 下 inner.offsetWidth = 最宽一行的内容宽；+4 = 边框/滚动条余量
      const w = Math.max(210, Math.min(1200, Math.round(inner.offsetWidth) + 4));
      widget.invoke('app:win:width', { width: w }).catch(() => {});
    }
    // 滚动条占位：写入 --sbw，让表头/状态条扣掉同样宽度，与数据列严格对齐
    const sbw = Math.max(0, list.offsetWidth - list.clientWidth);
    // +4 = #list 右缘留白（margin-right，避开缩放条），表头/状态条随之内收对齐
    app.style.setProperty('--sbw', (sbw + 4) + 'px');
    syncPopExpand();
    autoScroll.sync();
  }, 120);
}

/* ---------------- 列表滚动（手动触发） ---------------- */
/* 默认不滚；右键空白处「启动滚动」或眼睛面板启动后，列表缓慢下滚、到底停 2 秒回顶循环；
   鼠标悬停立即暂停、移开继续。速度按行高自适应（约 1.5 秒一行），各字号档观感一致。 */
const autoScroll = (() => {
  const list = $('#list');
  const POP_IDS = ['#vispop', '#grouppop', '#addpop', '#alertpop', '#newspanel', '#onboard'];
  const ROW_SECONDS = 1;    // 每滚一行的秒数
  const MANUAL_HOLD = 4000; // 手动滚动（滚轮/键盘）后暂停多久再续
  const DWELL_MS = 2000;    // 滚到底部的停留时长

  let raf = 0;
  let lastT = 0;
  let dwellAt = 0;      // 到达底部的时刻（rAF 时间戳）
  let hover = false;    // 鼠标悬停在列表上
  let manualUntil = 0;  // 手动滚动暂停截止时刻
  let sparkOpen = false;
  let running = false; // 运行态：仅用户显式启动；不跨重启记忆
  let need = false;
  // 子像素累计：Chromium 会把 scrollTop 赋值向下取整，每帧 0.x px 的增量直接赋值永远被
  // 取整成 0（滚动永远动不了），所以虚拟位置在 JS 里小数累加、每帧只写整数部分
  let pos = 0;
  let written = -1;     // 上次由本循环写入的 scrollTop，用于识别外部滚动（拖滑块/键盘/滚轮）

  const rowH = () => {
    const row = list.querySelector('.row');
    return (row && row.offsetHeight) || 36;
  };
  const paused = () => {
    if (hover || sparkOpen || dragging) return true;
    if (Date.now() < manualUntil) return true;
    if (settings && settings.window.form === 'mini') return true;
    for (const id of POP_IDS) {
      const el = $(id);
      if (el && !el.hidden) return true;
    }
    return false;
  };

  function frame(t) {
    raf = 0;
    if (!need) return;
    if (!paused()) {
      // 隐藏窗口会让 rAF 停摆，dt 钳制避免恢复瞬跳
      const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
      const max = list.scrollHeight - list.clientHeight;
      if (max > 1) {
        if (list.scrollTop >= max - 0.5) {
          if (!dwellAt) dwellAt = t;
          if (t - dwellAt >= DWELL_MS) { list.scrollTop = 0; pos = 0; written = 0; dwellAt = 0; }
        } else {
          dwellAt = 0;
          // 位置被外部改变（用户拖滑块/翻页/scrollIntoView）→ 以实际位置为准接着滚
          if (list.scrollTop !== written) pos = list.scrollTop;
          pos = Math.min(max, pos + (rowH() / ROW_SECONDS) * dt);
          const target = Math.floor(pos);
          if (target > list.scrollTop) list.scrollTop = Math.min(max, target);
          written = list.scrollTop;
        }
      }
    }
    lastT = t;
    raf = requestAnimationFrame(frame);
  }

  /** 重新评估是否需要滚动（启动/停止、渲染后、窗口尺寸变化时调用） */
  function sync() {
    need = !!(running && list.scrollHeight > list.clientHeight + 2);
    if (need && !raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!need && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  list.addEventListener('mouseenter', () => { hover = true; });
  list.addEventListener('mouseleave', () => { hover = false; });
  list.addEventListener('wheel', () => { manualUntil = Date.now() + MANUAL_HOLD; }, { passive: true });
  // 外部滚动（拖滑块/键盘翻行/scrollIntoView，这些不触发 wheel）→ 暂停几秒再续；
  // 本循环自己的写入不触发（written 刚同步为最新值）
  list.addEventListener('scroll', () => {
    if (written >= 0 && list.scrollTop !== written) {
      pos = list.scrollTop;
      manualUntil = Date.now() + MANUAL_HOLD;
    }
  });
  window.addEventListener('resize', () => setTimeout(sync, 150));

  const mirror = () => {
    try { widget.invoke('app:autoscroll:set', { on: running }).catch(() => {}); } catch (e) { /* widget 未就绪 */ }
  };

  function setRunning(v) {
    running = !!v;
    if (running) {
      // 启动瞬间清掉悬停/手动滚动暂停：右键菜单就开在列表上，光标多半还悬在原地，
      // 不清的话「启动了却不动」，要等鼠标离再进列表才恢复
      hover = false;
      manualUntil = 0;
      pos = list.scrollTop; // 从当前位置接着滚
      written = pos;
    }
    sync();
    mirror();
    // 启动了但一屏装得下：提示而非静默无反应
    if (running && !need && settings && settings.window.form !== 'mini') {
      toast('当前列表一屏装得下，无需滚动');
    }
  }

  return {
    sync,
    isRunning: () => running,
    toggle: () => setRunning(!running),
    setRunning,
    nudge: () => { manualUntil = Date.now() + MANUAL_HOLD; },
    setSparkOpen: (v) => { sparkOpen = !!v; },
    /** 排查用：app:debug 通道可见的暂停原因快照 */
    debug: () => ({
      running, need, hover, sparkOpen, dragging: !!dragging,
      manualPause: Date.now() < manualUntil, mini: !!(settings && settings.window.form === 'mini'),
      pops: POP_IDS.filter((id) => { const el = $(id); return el && !el.hidden; }),
      scrollTop: list.scrollTop, max: list.scrollHeight - list.clientHeight,
    }),
  };
})();

/** 弹层撑高：弹层底部超出窗口时临时把窗口拉高到能完整显示（关闭后自动还原） */
function syncPopExpand() {
  if (!settings) return;
  let need = 0;
  for (const id of ['#vispop', '#grouppop', '#addpop', '#alertpop']) {
    const el = $(id);
    if (!el || el.hidden) continue;
    if (getComputedStyle(el).display === 'none') continue;
    need = Math.max(need, Math.round(el.offsetTop + el.offsetHeight + 10));
  }
  widget.invoke('app:win:expand', { height: need }).catch(() => {});
  // 有弹层时开监视：指针离开窗口（= 点到旁边）就自动收起
  widget.invoke('app:popup:watch', { open: need > 0 }).catch(() => {});
  // 弹层打开期间标题栏临时取消拖拽区域：拖拽区域内的点击不会传给页面，
  // 否则点标题栏空白处关不掉弹层面板
  app.classList.toggle('pop-open', need > 0 || settingsVis);
}

/** 收掉所有弹层（点窗口外 / 失焦 / Esc / 隐藏窗口时调用） */
function closeAllPops() {
  let closed = false;
  for (const id of ['#addpop', '#vispop', '#grouppop', '#alertpop']) {
    const el = $(id);
    if (el && !el.hidden) { el.hidden = true; closed = true; }
  }
  if (closed) syncPopExpand();
}

/* 可视控制弹层：同步当前值（拖动滑杆中不回写，避免拇指跳动） */
function syncVis() {
  const pop = $('#vispop');
  if (pop.hidden || !settings) return;
  const v = Math.round(settings.appearance.bgAlpha * 100);
  if (document.activeElement !== $('#visalpha')) {
    $('#visalpha').value = v;
  }
  $('#visalpha-val').textContent = v + '%';
  $('#vform-full').classList.toggle('on', settings.window.form !== 'mini');
  $('#vform-mini').classList.toggle('on', settings.window.form === 'mini');
  $('#vpen').classList.toggle('on', penOn);
  $('#vpen').textContent = penOn ? '已开启' : '开启';
  const sm = normSort(settings.source.sortMode);
  document.querySelectorAll('#vsort .vbtn').forEach((b) => b.classList.toggle('on', b.dataset.v === sm));
  const starOnly = !!settings.source.filterStarred && settings.source.mode === 'manual';
  $('#vstar').classList.toggle('on', starOnly);
  $('#vstar').textContent = starOnly ? '已开启' : '开启';
  $('#vstar').closest('.vrow').hidden = settings.source.mode !== 'manual';
  const prot = meetingOn || !!settings.behavior.contentProtection;
  $('#vprot').classList.toggle('on', prot);
  $('#vprot').textContent = prot ? '已开启' : '开启';
  $('#vmeeting').classList.toggle('on', meetingOn);
  $('#vmeeting').textContent = meetingOn ? '关闭' : '开启';
  const rolling = autoScroll.isRunning();
  $('#vscroll').classList.toggle('on', rolling);
  $('#vscroll').textContent = rolling ? '停止' : '启动';
}

/* ---------------- 设置应用 ---------------- */

function resolvedTheme() {
  if (!settings) return 'dark';
  if (settings.appearance.theme !== 'auto') return settings.appearance.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applySettings(s) {
  const first = !settings;
  settings = s;
  app.dataset.theme = resolvedTheme();
  app.dataset.fsize = s.appearance.fontSize;
  app.dataset.form = s.window.form;
  app.style.setProperty('--bg-alpha', s.appearance.bgAlpha);
  app.classList.toggle('swap', s.appearance.upColor === 'green');
  app.classList.toggle('mono', !!s.appearance.mono);
  app.classList.toggle('hide-code', !s.appearance.showCode);
  app.classList.toggle('no-pulse', !s.appearance.pulse);
  app.classList.toggle('autow', !!s.appearance.autoWidth);
  $('#btn-news').hidden = !s.behavior.newsEnabled;
  if (!first && state) render(state);
  // 股价提醒弹层开着时同步规则列表（如规则被命中移除）
  if (!$('#alertpop').hidden) renderApList();
  // 从迷你条点眼睛回来：直接展开面板（一步到位）
  if (pendingVis && s.window.form === 'full') {
    pendingVis = false;
    const pop = $('#vispop');
    pop.hidden = false;
    syncVis();
  }
  measureSoon();
  syncVis();
}

/* ---------------- 渲染 ---------------- */

function render(st) {
  state = st;
  renderTitle(st);
  rebuildGroupPop(st);
  renderIndex(st);
  renderColHead(st);
  renderRows(st);
  renderStatus(st);
  measureSoon();
}

/** 排序循环：点列头三态循环（默认 → 降序 → 升序 → 默认）；
 *  若当前排的是另一列，则本次从降序开始（不在本列序列里时不要跳回默认） */
function cycleSort(col) {
  const cur = normSort(settings.source.sortMode);
  const seq = col === 'price'
    ? ['default', 'price-desc', 'price-asc']
    : ['default', 'pct-desc', 'pct-asc'];
  const i = seq.indexOf(cur);
  const next = i < 0 ? seq[1] : seq[(i + 1) % seq.length];
  widget.invoke('app:settings:set', { source: { sortMode: next } }).catch(() => {});
}

function renderColHead(st) {
  const head = $('#colhead');
  if (!settings || !st.rows || !st.rows.length) { head.hidden = true; return; }
  head.hidden = false;
  const m = normSort(settings.source.sortMode);
  const price = $('#ch-price'), pct = $('#ch-pct'), name = $('#ch-name');
  const mark = (el, dir) => { el.classList.add('on'); el.textContent = el.dataset.base + ' ' + dir; };
  const clear = (el, base) => { el.classList.remove('on'); el.textContent = base; };
  price.dataset.base = '价格'; pct.dataset.base = '涨跌';
  clear(price, '价格'); clear(pct, '涨跌');
  if (m === 'price-desc') mark(price, '↓');
  else if (m === 'price-asc') mark(price, '↑');
  else if (m === 'pct-desc') mark(pct, '↓');
  else if (m === 'pct-asc') mark(pct, '↑');
  else name.textContent = '名称';
}

function renderTitle(st) {
  // 窄窗检测：<270px 加 narrow 类（列宽/行高收紧）
  app.classList.toggle('narrow', app.offsetWidth < 270);
  const btn = $('#btn-group');
  const el = $('#title');
  if ((settings && settings.window.form) === 'mini' || st.form === 'mini') {
    btn.hidden = true;
    el.hidden = false;
    const sh = (st.indexes || []).find((i) => i.secid === '1.000001');
    const rows = st.rows || [];
    const up = rows.filter((r) => r.pct != null && r.pct > 0).length;
    const dn = rows.filter((r) => r.pct != null && r.pct < 0).length;
    const wide = app.offsetWidth >= 300; // 窄条下只留指数，避免被截成“· …”
    el.textContent = sh && sh.price != null
      ? (wide ? `沪 ${sh.price.toFixed(0)} ${fmtPct(sh.pct)} · 涨${up} 跌${dn}` : `沪 ${sh.price.toFixed(0)} ${fmtPct(sh.pct)}`)
      : '行情小窗';
    return;
  }
  const posCount = st.positionsCount || 0;
  const hasGroups = st.mode === 'cloud' && st.groups && st.groups.length;
  if (hasGroups || posCount > 0) {
    el.hidden = true;
    btn.hidden = false;
    let nm;
    if (st.activeGroup === '__positions__') nm = `持仓 ${posCount}`;
    else if (hasGroups) {
      const g = currentGroup(st);
      nm = g.gid === 'all' ? `全部 · ${st.rows.length}` : `${g.gname} ${g.count != null ? g.count : ''}`.trim();
    } else nm = `自选 · ${st.rows.length}`;
    if (normSort(settings.source.sortMode) !== 'default') nm += ' ⇅';
    $('#btngroup-name').textContent = nm;
  } else {
    btn.hidden = true;
    el.hidden = false;
    el.textContent = `自选 · ${st.rows.length}`;
  }
}

/** 当前分组解析：all=合并 / first=第一个分组（像东财默认落在自选股）/ gid */
function currentGroup(st) {
  if (!st || st.mode !== 'cloud' || !st.groups || !st.groups.length) return null;
  const a = st.activeGroup;
  if (a === 'all') return { gid: 'all', gname: '全部', count: null };
  if (!a || a === 'first') return st.groups[0];
  return st.groups.find((x) => String(x.gid) === String(a)) || st.groups[0];
}

/** 摸鱼排序：涨跌幅模式下按 pct 降序（最涨在前），一眼看异动 */
/** 排序模式归一化（兼容旧值 pct → pct-desc） */
function normSort(m) {
  const v = m || 'default';
  return v === 'pct' ? 'pct-desc' : v;
}

/** 排序：default=原序；其余按涨跌幅（持仓带成本时按盈亏）或价格升降，空值垫底 */
function sortedRows(st) {
  if (!settings || !st.rows) return st.rows || [];
  const m = normSort(settings.source.sortMode);
  if (m === 'default') return st.rows;
  const val = (r) => {
    if (m.startsWith('pct')) {
      const v = r.cost != null && r.pl != null ? r.pl : r.pct;
      return v != null && Number.isFinite(v) ? v : null;
    }
    return r.price != null && Number.isFinite(r.price) ? r.price : null;
  };
  return st.rows.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return m.endsWith('desc') ? vb - va : va - vb;
  });
}

/** 分组下拉列表：云分组 / 自选列表 / 本地持仓 */
function rebuildGroupPop(st) {
  const pop = $('#grouppop');
  const list = $('#grouplist');
  if (!pop || !list) return;
  const posCount = st.positionsCount || 0;
  const hasGroups = st.mode === 'cloud' && st.groups && st.groups.length;
  if (!hasGroups && !posCount) {
    pop.dataset.sig = 'none';
    return;
  }
  const sig = JSON.stringify(st.groups) + '#' + st.activeGroup + '#' + posCount + '#' + st.mode;
  if (pop.dataset.sig === sig) return;
  pop.dataset.sig = sig;
  list.textContent = '';
  const mk = (label, count, gid, on) => {
    const row = document.createElement('div');
    row.className = 'gp-item' + (on ? ' on' : '');
    const nm = document.createElement('span');
    nm.className = 'gp-nm';
    nm.textContent = label;
    const ct = document.createElement('span');
    ct.className = 'gp-ct';
    ct.textContent = count != null ? count : '';
    row.append(nm, ct);
    row.onclick = () => {
      widget.invoke('app:group:select', { gid }).catch(() => {});
      pop.hidden = true;
    };
    list.append(row);
  };
  // 顺序：全部（或自选列表）→ 持仓 → 各云分组（本地持仓跟着「全部」走，常看的分组不用翻到底部）
  const mkPositions = () => {
    if (posCount) mk('持仓', posCount, '__positions__', st.activeGroup === '__positions__');
  };
  if (hasGroups) {
    mk('全部（合并视图）', null, 'all', st.activeGroup === 'all');
    mkPositions();
    for (const g of st.groups) {
      mk(g.gname, g.count, g.gid, String(st.activeGroup) === String(g.gid));
    }
  } else {
    mk('自选列表', st.rows.length, 'default', st.activeGroup !== '__positions__');
    mkPositions();
  }
}

function renderIndex(st) {
  const bar = $('#indexbar');
  if (!settings.appearance.showIndexBar || (st.indexes || []).length === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.textContent = '';
  const narrow = app.classList.contains('narrow');
  for (const ix of st.indexes) {
    if (narrow && ix.secid === '0.399001') continue; // 窄窗隐藏深成指，保沪创
    const span = document.createElement('span');
    span.className = 'ix';
    const b = document.createElement('b');
    b.textContent = (narrow ? '' : ix.short + ' ') + (ix.price != null ? ix.price.toFixed(ix.price >= 10000 ? 0 : 1) : '—');
    const i = document.createElement('i');
    if (ix.pct == null) { i.className = 'fl'; i.textContent = '—'; }
    else {
      i.className = ix.pct > 0 ? 'up' : ix.pct < 0 ? 'dn' : 'fl';
      i.textContent = (ix.pct > 0 ? '+' : '') + ix.pct.toFixed(1) + '%';
      i.style.fontStyle = 'normal';
    }
    span.append(b, i);
    bar.append(span);
  }
}

function renderRows(st) {
  const list = $('#list');
  const empty = $('#empty');
  const cloudno = $('#cloudno');
  const loggedOut = st.mode === 'cloud' && !st.loggedIn;

  if (loggedOut) {
    list.style.display = 'none';
    empty.hidden = true;
    cloudno.hidden = false;
    for (const [, el] of rowEls) el.remove();
    rowEls.clear();
    return;
  }
  cloudno.hidden = true;
  if (!st.rows.length) {
    list.style.display = 'none';
    empty.hidden = false;
    $('#empty .big').textContent = '还没有自选';
    return;
  }
  // 仅看置顶（手动模式）：自选几百只时快速聚焦到重点
  const starOnly = !!settings.source.filterStarred && st.mode === 'manual';
  const rows = starOnly ? sortedRows(st).filter((r) => r.star) : sortedRows(st);
  if (!rows.length) {
    list.style.display = 'none';
    empty.hidden = false;
    $('#empty .big').textContent = '没有置顶的自选';
    $('#empty .dim').textContent = '眼睛面板 → 关闭「仅看置顶」即可恢复全部';
    return;
  }
  if (starOnly) {
    // 过滤态下的空态文案复用后要还原默认提示
    $('#empty .big').textContent = '还没有自选';
    $('#empty .dim').textContent = '点右上角 ＋ 搜索添加，或到设置里粘贴导入';
  }
  empty.hidden = true;
  list.style.display = '';

  const seen = new Set();
  let prev = null;
  const inner = $('#listinner');
  for (const r of rows) {
    const key = r.market + r.code;
    seen.add(key);
    let el = rowEls.get(key);
    if (!el) { el = buildRow(r); rowEls.set(key, el); }
    el.dataset.key = key;
    updateRow(el, r);
    const expect = prev ? prev.nextSibling : inner.firstChild;
    if (expect !== el) inner.insertBefore(el, expect);
    prev = el;
  }
  for (const [key, el] of [...rowEls]) {
    if (!seen.has(key)) { el.remove(); rowEls.delete(key); }
  }
}

function buildRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.draggable = true;

  const pulse = document.createElement('div');
  pulse.className = 'pulse';

  const main = document.createElement('div');
  main.className = 'rmain';
  const star = document.createElement('span');
  star.className = 'star';
  star.innerHTML = SVG.star;
  const nm = document.createElement('span'); nm.className = 'nm';
  const cd = document.createElement('span'); cd.className = 'cd';
  const grow = document.createElement('span'); grow.className = 'grow';
  const px = document.createElement('span'); px.className = 'px';
  const pct = document.createElement('span'); pct.className = 'pct';
  main.append(star, nm, cd, grow, px, pct);

  const spark = document.createElement('div');
  spark.className = 'spark';
  spark.hidden = true;

  el.append(pulse, main, spark);

  el.addEventListener('click', () => {
    if (suppressClick) return;
    toggleSpark(el);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    widget.invoke('app:ctx:menu', { key: el.dataset.key }).catch(() => {});
  });
  el.addEventListener('dragstart', (e) => {
    if (settings && normSort(settings.source.sortMode) !== 'default') return; // 排序模式下禁拖拽
    dragging = el;
    el.classList.add('dragging');
    e.dataTransfer.setData('text/plain', el.dataset.key);
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.classList.remove('dragging');
    clearInsertMarks();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragging || dragging === el) return;
    lastDragY = e.clientY;
    const rect = el.getBoundingClientRect();
    clearInsertMarks();
    el.classList.add(lastDragY < rect.top + rect.height / 2 ? 'ins-top' : 'ins-bottom');
  });
  el.addEventListener('dragleave', () => el.classList.remove('ins-top', 'ins-bottom'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragging || dragging === el) return;
    const rect = el.getBoundingClientRect();
    const before = lastDragY < rect.top + rect.height / 2;
    if (before) el.parentNode.insertBefore(dragging, el);
    else el.parentNode.insertBefore(dragging, el.nextSibling);
    clearInsertMarks();
    const keys = [...$('#listinner').children].map((x) => x.dataset.key).filter(Boolean);
    widget.invoke('app:list:reorder', { keys }).catch(() => {});
  });
  return el;
}

function clearInsertMarks() {
  document.querySelectorAll('.row.ins-top, .row.ins-bottom')
    .forEach((el) => el.classList.remove('ins-top', 'ins-bottom'));
}

function updateRow(el, r) {
  try {
  const key = el.dataset.key;
  el.classList.toggle('sus', !!r.suspended);
  el.classList.toggle('invalid', !!r.invalid);
  const main = el.querySelector('.rmain');
  main.querySelector('.star').style.display = r.star ? '' : 'none';
  main.querySelector('.nm').textContent = r.name || r.code;
  main.querySelector('.cd').textContent = r.code;

  const px = main.querySelector('.px');
  const pct = main.querySelector('.pct');
  if (r.suspended) {
    px.textContent = '—';
    pct.textContent = '停牌';
    pct.className = 'pct badge fl';
  } else if (r.price == null) {
    px.textContent = '—';
    pct.textContent = r.invalid ? '无数据' : '—';
    pct.className = 'pct fl';
  } else {
    px.textContent = r.price.toFixed(2);
    const pv = r.cost != null && r.pl != null ? r.pl : r.pct;
    pct.textContent = fmtPct(pv);
    pct.className = 'pct ' + (pv > 0 ? 'up' : pv < 0 ? 'dn' : 'fl');
  }

  const prev = prevPrices.get(key);
  if (r.price != null && prev != null && prev !== r.price) {
    el.classList.remove('anim', 'pu', 'pd');
    void el.offsetWidth;
    el.classList.add(r.price > prev ? 'pu' : 'pd');
    el.classList.add('anim');
  }
  prevPrices.set(key, r.price);
  }
  catch (e) {
    try { widget.invoke('app:debug', { msg: 'updateRow异常 ' + (e && e.message) + ' row=' + JSON.stringify(r).slice(0, 150) }); } catch (e2) {}
  }
}

/* ---------------- 分时 ---------------- */

async function toggleSpark(el) {
  const spark = el.querySelector('.spark');
  const key = el.dataset.key;
  if (!spark.hidden) {
    spark.hidden = true;
    el.classList.remove('open');
    autoScroll.setSparkOpen(false);
    measureSoon();
    return;
  }
  spark.hidden = false;
  el.classList.add('open');
  autoScroll.setSparkOpen(true);
  const r = state && state.rows.find((x) => x.market + x.code === key);
  if (!r || !r.secid) { spark.textContent = ''; measureSoon(); return; }

  let data = sparkCache.get(key);
  if (!data || Date.now() - data.ts > 60000) {
    spark.textContent = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '分时加载中…';
    spark.append(meta);
    const res = await widget.invoke('app:trends', { secid: r.secid }).catch(() => null);
    if (!res || !res.ok || !res.points || !res.points.length) {
      spark.textContent = '';
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = '分时获取失败 · 双源均无响应';
      spark.append(m);
      revealRow(el);
      measureSoon();
      return;
    }
    data = { ts: Date.now(), points: res.points, preClose: res.preClose };
    sparkCache.set(key, data);
  }
  drawSpark(spark, data, r);
  revealRow(el);
  measureSoon();
}

/** 展开分时后把整行（含图表）滚进可视区：窗口高度固定时，点靠下的行不会"点了没反应" */
function revealRow(el) {
  try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
}

function drawSpark(spark, data, r) {
  spark.textContent = '';
  const NS = 'http://www.w3.org/2000/svg';
  const W = 300, H = 44;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const prices = data.points.map((p) => p.p);
  const avgs = data.points.map((p) => p.avg).filter((v) => v != null);
  const all = data.preClose != null ? prices.concat([data.preClose]) : prices;
  if (avgs.length) all.push(...avgs);
  let min = Math.min(...all), max = Math.max(...all);
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;
  const x = (i) => (i / Math.max(1, data.points.length - 1)) * W;
  const y = (p) => H - ((p - min) / (max - min)) * H;

  if (data.preClose != null && data.preClose >= min && data.preClose <= max) {
    const base = document.createElementNS(NS, 'line');
    base.setAttribute('x1', 0); base.setAttribute('x2', W);
    base.setAttribute('y1', y(data.preClose)); base.setAttribute('y2', y(data.preClose));
    base.setAttribute('class', 'base');
    svg.append(base);
  }
  const up = r.prevClose != null
    ? data.points[data.points.length - 1].p >= r.prevClose
    : (r.pct || 0) >= 0;
  const cls = up ? 'up' : 'dn';
  const poly = document.createElementNS(NS, 'polyline');
  poly.setAttribute('class', cls);
  poly.setAttribute('points', data.points.map((p, i) => `${x(i).toFixed(1)},${y(p.p).toFixed(1)}`).join(' '));
  svg.append(poly);
  // 均价线（黄虚线）：盘口分水岭，现价在上方=强
  if (avgs.length > 1) {
    const avgPts = data.points
      .map((p, i) => (p.avg != null ? `${x(i).toFixed(1)},${y(p.avg).toFixed(1)}` : null))
      .filter(Boolean);
    const avgLine = document.createElementNS(NS, 'polyline');
    avgLine.setAttribute('class', 'avg');
    avgLine.setAttribute('points', avgPts.join(' '));
    svg.append(avgLine);
  }
  const lastP = data.points[data.points.length - 1];
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', cls);
  dot.setAttribute('cx', W - 1.5);
  dot.setAttribute('cy', y(lastP.p).toFixed(1));
  dot.setAttribute('r', 1.7);
  svg.append(dot);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.textContent = `分时 ${data.points[0].t || ''} — ${lastP.t || ''}`;
  const right = document.createElement('span');
  const lastAvg = data.points.map((p) => p.avg).filter((v) => v != null).pop();
  right.textContent = `昨收 ${data.preClose != null ? data.preClose.toFixed(2) : '—'}${lastAvg != null ? ' · 均价 ' + lastAvg.toFixed(2) : ''}`;
  meta.append(left, right);
  spark.append(svg, meta);
}

/* ---------------- 状态 ---------------- */

function renderStatus(st) {
  const s = st.status || {};
  const dot = $('#dot');
  // 只有"数据真的变旧"（超过 20s 没有新数据）才算异常；东财在坏窗口里失败一两次时数据还很新，
  // 不该弹"网络异常"（这正是之前反复刷屏的根源）
  const stale = !s.lastUpdate || Date.now() - s.lastUpdate > 20000;
  const dotCls = {
    ok: 'dot-ok', 'net-error': stale ? 'dot-err' : 'dot-warn', degraded: 'dot-warn', backup: 'dot-warn',
    'logged-out': 'dot-idle', 'api-changed': 'dot-err',
  }[s.code] || 'dot-ok';
  dot.className = 'dot ' + dotCls;

  let label;
  if (s.code === 'logged-out') label = '云端未登录';
  else if (s.code === 'net-error') label = stale ? `网络异常 · 第 ${s.retryCount || 1} 次重试` : '重试中…';
  else if (s.code === 'backup') label = '腾讯备源 · 数据正常'; // 备源在正常供数，不是异常
  else if (s.code === 'degraded') label = '腾讯备源 · 重试中';
  else if (s.code === 'api-changed') label = '接口异常';
  else if (st.mode === 'cloud') label = st.loggedIn ? '云端 · 已同步 ' + hhmmss(s.lastUpdate) : '云端 · 未登录';
  else label = '手动 · ' + hhmmss(s.lastUpdate);
  $('#statustext').textContent = label;
  $('#statusright').textContent =
    `${s.phaseLabel || ''} · ${s.source === 'eastmoney' ? '东财' : '腾讯'}${s.adaptive ? ' · 静默' : ''}`;

  const banner = $('#banner');
  const showBanner = penOn || (s.code === 'net-error' && stale) || s.code === 'logged-out';
  banner.hidden = !showBanner;
  if (showBanner) {
    if (penOn) {
      $('#bannertext').textContent = '鼠标穿透中 · ⌥⇧X 恢复 · 或 ⌘Tab 切回本应用后按 Esc · 或右键 Dock 图标';
      $('#banner-login').hidden = true;
      $('#banner-manual').hidden = true;
    } else if (s.code === 'logged-out') {
      $('#bannertext').textContent = '云端自选未登录 · 行情不受影响';
      $('#banner-login').hidden = false;
      $('#banner-manual').hidden = false;
    } else {
      $('#bannertext').textContent = `网络异常 · 第 ${s.retryCount || 1} 次重试 · 数据为 ${hhmm(s.lastUpdate)} 快照`;
      $('#banner-login').hidden = true;
      $('#banner-manual').hidden = true;
    }
  }
}

/* 状态变化时重绘提示条（穿透开关不触发 render，单独监听） */
function refreshBanner() {
  if (state) renderStatus(state);
  else if (penOn) {
    $('#banner').hidden = false;
    $('#bannertext').textContent = '鼠标穿透中 · ⌥⇧X 恢复 · 或 ⌘Tab 切回本应用后按 Esc · 或右键 Dock 图标';
  }
}

/* ---------------- 搜索添加（主窗 + 引导共用） ---------------- */

function attachSearch(inputEl, resultsEl, onDone) {
  let seq = 0;
  let timer = null;
  let active = -1;
  let rows = [];

  const renderResults = () => {
    resultsEl.textContent = '';
    active = rows.length ? 0 : -1;
    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'sr-none';
      none.textContent = inputEl.value.trim() ? '无匹配结果' : '输入名称 / 拼音 / 代码搜索';
      resultsEl.append(none);
      return;
    }
    rows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'sr' + (i === active ? ' on' : '');
      const nm = document.createElement('span'); nm.className = 'nm2'; nm.textContent = r.name;
      const cd = document.createElement('span'); cd.className = 'cd2'; cd.textContent = r.code;
      const mk = document.createElement('span'); mk.className = 'mkt'; mk.textContent = r.tag || r.market;
      el.append(nm, cd, mk);
      el.onclick = () => pick(r);
      resultsEl.append(el);
    });
  };

  const pick = async (r) => {
    const res = await widget.invoke('app:list:add', {
      market: r.market, code: r.code, secid: r.secid,
    }).catch(() => null);
    if (res && res.dup) toast('已在自选列表中');
    else if (res && res.ok) toast('已添加 ' + r.name);
    inputEl.value = '';
    rows = [];
    renderResults();
    if (onDone) onDone(r);
  };

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = inputEl.value.trim();
      const mySeq = ++seq;
      if (!q) { rows = []; renderResults(); return; }
      const res = await widget.invoke('app:search', { q }).catch(() => null);
      if (mySeq !== seq) return;
      rows = (res && res.ok && res.rows) || [];
      // 裸代码兜底：搜索接口失败时仍可加
      if (!rows.length && /^\d{6}$/.test(q)) {
        rows = [{ market: guessMarket(q), code: q, name: '代码 ' + q, secid: null, tag: '码' }];
      }
      renderResults();
    }, 240);
  });

  inputEl.addEventListener('keydown', async (e) => {
    const items = resultsEl.querySelectorAll('.sr');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('on', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (rows[active]) await pick(rows[active]);
    } else if (e.key === 'Escape') {
      inputEl.value = ''; rows = []; renderResults();
    }
  });

  renderResults();
  return { refreshCount: () => {} };
}

/* ---------------- 股价提醒弹层 ---------------- */

let apCtx = null; // 正在设置提醒的股票 {market, code, name, price}

function openPriceAlert(info) {
  apCtx = {
    market: String((info && info.market) || ''),
    code: String((info && info.code) || ''),
    name: (info && info.name) || (info && info.code) || '—',
    price: info && Number.isFinite(info.price) ? info.price : null,
  };
  $('#ap-name').textContent = apCtx.name;
  $('#ap-price').textContent = apCtx.price != null ? '现价 ' + apCtx.price.toFixed(2) : '现价 —';
  $('#ap-gte').value = '';
  $('#ap-lte').value = '';
  renderApList();
  $('#alertpop').hidden = false;
  syncPopExpand();
  setTimeout(() => { $('#ap-gte').focus(); }, 30);
}

function renderApList() {
  const box = $('#ap-list');
  box.textContent = '';
  if (!apCtx || !settings) return;
  const rules = ((settings.alerts || {}).priceRules || [])
    .filter((r) => r.m === apCtx.market && r.c === apCtx.code);
  for (const r of rules) {
    const item = document.createElement('div');
    item.className = 'apitem';
    const txt = document.createElement('span');
    txt.textContent = (r.op === 'lte' ? '跌到 ≤ ' : '涨到 ≥ ') + r.price.toFixed(2) + (r.hit ? '（已触发）' : '');
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除该提醒';
    del.dataset.del = r.id;
    item.append(txt, del);
    box.append(item);
  }
}

/* ---------------- 引导 ---------------- */

function showOnboarding() {
  const ob = $('#onboard');
  ob.hidden = false;
  let step = 1;
  const steps = [...ob.querySelectorAll('.step')];
  const dots = [...ob.querySelectorAll('.ob-dot')];

  const go = (n) => {
    step = n;
    steps.forEach((el) => { el.hidden = Number(el.dataset.step) !== n; });
    dots.forEach((d, i) => d.classList.toggle('on', i < n));
    if (n === 2) setTimeout(() => $('#obsearch').focus(), 50);
  };

  ob.querySelectorAll('.optcard').forEach((card) => {
    card.onclick = () => {
      ob.querySelectorAll('.optcard').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      obMode = card.dataset.mode;
    };
  });
  $('#ob1next').onclick = async () => {
    await widget.invoke('app:settings:set', { source: { mode: obMode } }).catch(() => {});
    if (obMode === 'cloud') widget.invoke('app:login:open').catch(() => {});
    go(2);
  };
  $('#ob2back').onclick = () => go(1);
  $('#ob2next').onclick = () => go(3);
  $('#ob3back').onclick = () => go(2);
  $('#ob-skip').onclick = async () => {
    await widget.invoke('app:settings:set', { source: { mode: obMode }, onboarded: true }).catch(() => {});
    ob.hidden = true;
  };
  $('#obdone').onclick = async () => {
    await widget.invoke('app:settings:set', {
      appearance: {
        theme: $('#obtheme').value,
        fontSize: $('#obfsize').value,
        bgAlpha: Number($('#obalpha').value) / 100,
        mono: $('#obmono').checked,
        showCode: !$('#obcode').checked,
      },
      onboarded: true,
    }).catch(() => {});
    ob.hidden = true;
    toast('设置完成 · ⌥⇧H 老板键隐身 · ⌥⇧M 会议模式', 6000);
  };

  // 步骤 2 的搜索
  attachSearch($('#obsearch'), $('#obresults'));
  $('#ob-demo').onclick = async () => { await addDemo(); };
  $('#obcount').textContent = '当前 0 只';

  // 步骤 3 实时预览
  let t = null;
  $('#obtheme').onchange = () => widget.invoke('app:settings:set', { appearance: { theme: $('#obtheme').value } }).catch(() => {});
  $('#obfsize').onchange = () => widget.invoke('app:settings:set', { appearance: { fontSize: $('#obfsize').value } }).catch(() => {});
  $('#obalpha').oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => widget.invoke('app:settings:set', { appearance: { bgAlpha: Number($('#obalpha').value) / 100 } }).catch(() => {}), 60);
  };

  go(1);
}

async function addDemo() {
  for (const [market, code] of [['SH', '600519'], ['SH', '510300'], ['SH', '000001']]) {
    await widget.invoke('app:list:add', { market, code }).catch(() => {});
  }
  toast('已添加示例组合');
}

/* ---------------- 快讯 ---------------- */

async function loadNews() {
  const res = await widget.invoke('app:news').catch(() => null);
  if (!res || !res.ok) return;
  const box = $('#newslist');
  box.textContent = '';
  for (const n of res.items) {
    const item = document.createElement('div');
    item.className = 'nitem';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = n.title;
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = n.time;
    item.append(t, time);
    item.onclick = () => widget.invoke('app:open-external', { url: n.url }).catch(() => {});
    box.append(item);
  }
  $('#newstime').textContent = '更新 ' + hhmm(Date.now());
}

function toggleNews() {
  newsOpen = !newsOpen;
  const p = $('#newspanel');
  p.hidden = !newsOpen;
  if (newsOpen) {
    loadNews();
    clearInterval(newsTimer);
    newsTimer = setInterval(loadNews, 60000);
  } else {
    clearInterval(newsTimer);
  }
}

/* ---------------- 启动 ---------------- */

async function boot() {
  if (typeof widget === 'undefined') return;
  const data = await widget.invoke('app:boot').catch(() => null);
  if (!data) return;
  applySettings(data.settings);
  penOn = !!data.penetrate;
  if (data.state) render(data.state);
  if (!data.settings.onboarded) showOnboarding();

  widget.on('evt:state', render);
  widget.on('evt:settings', applySettings);
  widget.on('evt:popup:close', () => closeAllPops());
  widget.on('evt:win:settings-vis', (p) => { settingsVis = !!(p && p.visible); syncPopExpand(); });
  widget.on('evt:notice', (n) => toast(n && n.text, n && n.ms));
  widget.on('evt:penetrate', (on) => {
    penOn = !!on;
    syncVis();
    refreshBanner();
  });
  widget.on('evt:meeting', (on) => {
    meetingOn = !!on;
    syncVis();
  });
  widget.on('evt:focus-search', () => openAddPop());
  widget.on('evt:pricealert', openPriceAlert);
  widget.on('evt:autoscroll', (p) => { autoScroll.setRunning(!!(p && p.on)); syncVis(); });

  // 图标
  $('#btn-min').innerHTML = SVG.minus;
  $('#btn-quit').innerHTML = SVG.close;
  $('#btn-add').innerHTML = SVG.magnifier;
  $('#btn-news').innerHTML = SVG.news;
  $('#btn-eye').innerHTML = SVG.eye;
  $('#btn-set').innerHTML = SVG.set;
  $('#news-close').innerHTML = SVG.close;

  // 头部按钮
  $('#btn-min').onclick = () => widget.invoke('app:hide').catch(() => {});
  // 退出需二次确认：误点 ✕ = 杀进程（托盘/Dock 全关），摸鱼场景代价太大
  let quitArm = null;
  const quitBtn = $('#btn-quit');
  quitBtn.onclick = () => {
    if (quitBtn.classList.contains('armed')) {
      clearTimeout(quitArm);
      quitBtn.classList.remove('armed');
      widget.invoke('app:quit').catch(() => {});
      return;
    }
    quitBtn.classList.add('armed');
    quitBtn.title = '再点一次确认退出（3 秒内）';
    quitArm = setTimeout(() => {
      quitBtn.classList.remove('armed');
      quitBtn.title = '退出应用（需二次确认）：结束行情刷新，托盘一并关闭';
    }, 3000);
  };
  $('#btn-set').onclick = () => widget.invoke('app:settings:open').catch(() => {});
  $('#btn-news').onclick = toggleNews;
  $('#news-close').onclick = toggleNews;

  // 可视控制弹层（迷你条下眼睛按钮 = 一步回到完整形态并展开面板）
  $('#btn-eye').onclick = () => {
    if (settings.window.form === 'mini') {
      pendingVis = true;
      widget.invoke('app:win:form', { form: 'full' }).catch(() => {});
      return;
    }
    const pop = $('#vispop');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) syncVis();
    syncPopExpand();
  };

  // 分组下拉
  $('#btn-group').onclick = () => {
    const pop = $('#grouppop');
    pop.hidden = !pop.hidden;
    syncPopExpand();
  };
  $('#visalpha').addEventListener('input', () => {
    const v = Number($('#visalpha').value);
    $('#visalpha-val').textContent = v + '%';
    clearTimeout(alphaT);
    alphaT = setTimeout(() => {
      widget.invoke('app:settings:set', { appearance: { bgAlpha: v / 100 } }).catch(() => {});
    }, 60);
  });
  $('#vform-full').onclick = () => widget.invoke('app:win:form', { form: 'full' }).catch(() => {});
  $('#vform-mini').onclick = () => widget.invoke('app:win:form', { form: 'mini' }).catch(() => {});
  $('#vpen').onclick = () => widget.invoke('app:penetrate').catch(() => {});
  $('#vstar').onclick = () =>
    widget.invoke('app:settings:set', { source: { filterStarred: !settings.source.filterStarred } }).catch(() => {});
  $('#vprot').onclick = () =>
    widget.invoke('app:settings:set', { behavior: { contentProtection: !(meetingOn || settings.behavior.contentProtection) } }).catch(() => {});
  $('#vmeeting').onclick = () => widget.invoke('app:meeting').catch(() => {});
  $('#vsort').onclick = (e) => {
    const btn = e.target.closest('.vbtn');
    if (!btn) return;
    widget.invoke('app:settings:set', { source: { sortMode: btn.dataset.v } }).catch(() => {});
  };
  $('#vscroll').onclick = () => {
    autoScroll.toggle();
    // 启动后收起面板：面板开着时列表是暂停的，收起立刻能看到滚起来
    if (autoScroll.isRunning()) { $('#vispop').hidden = true; syncPopExpand(); }
    syncVis();
  };

  // 股价提醒弹层（列表右键 → 股价提醒…）：涨到/跌到可同时各设一个，持续有效
  for (const id of ['#ap-gte', '#ap-lte']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ap-add').click(); });
  }
  $('#ap-add').onclick = async () => {
    if (!apCtx) return;
    const adds = [];
    for (const [id, op] of [['#ap-gte', 'gte'], ['#ap-lte', 'lte']]) {
      const raw = $(id).value.trim();
      if (raw === '') continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) {
        toast(op === 'gte' ? '「涨到 ≥」请输入有效价格' : '「跌到 ≤」请输入有效价格');
        return;
      }
      adds.push({ op, price: v });
    }
    if (!adds.length) { toast('至少填一个目标价格'); return; }
    if (adds.length === 2 && adds[0].price <= adds[1].price) { toast('「涨到 ≥」应高于「跌到 ≤」'); return; }
    let okN = 0, dupN = 0;
    for (const a of adds) {
      const res = await widget.invoke('app:pricealert:add', {
        market: apCtx.market, code: apCtx.code, op: a.op, price: a.price,
      }).catch(() => null);
      if (res && res.ok && !res.dup) okN += 1;
      else if (res && res.dup) dupN += 1;
    }
    if (okN) {
      const label = adds.map((a) => (a.op === 'lte' ? '跌到 ≤ ' : '涨到 ≥ ') + a.price.toFixed(2)).join(' · ');
      toast(`已设置 ${apCtx.name} ${label} · 持续有效，到价弹通知`);
      $('#alertpop').hidden = true;
      syncPopExpand();
    } else if (dupN === adds.length) toast('该提醒已存在');
    else toast('设置失败，请重试');
  };
  $('#ap-list').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    await widget.invoke('app:pricealert:remove', { id: del.dataset.del }).catch(() => {});
  };
  $('#ap-preview').onclick = () => widget.invoke('app:pricetoast:preview').catch(() => {});
  $('#vboss').onclick = () => {
    $('#vispop').hidden = true;
    syncPopExpand();
    widget.invoke('app:boss').catch(() => {});
  };
  $('#btn-add').onclick = () => openAddPop();

  // ⌘F / 搜索按钮共用：打开添加弹层并聚焦
  function openAddPop() {
    const pop = $('#addpop');
    if (pop.hidden) {
      pop.hidden = false;
      $('#addinput').value = '';
      $('#addinput').focus();
    } else {
      pop.hidden = true;
    }
    syncPopExpand();
  }

  // 添加弹层
  attachSearch($('#addinput'), $('#addresults'), () => { $('#addpop').hidden = true; syncPopExpand(); });

  // 状态框按钮
  $('#demo-btn').onclick = addDemo;
  $('#login-btn').onclick = () => widget.invoke('app:login:open').catch(() => {});
  $('#banner-login').onclick = () => widget.invoke('app:login:open').catch(() => {});
  $('#use-manual').onclick = $('#banner-manual').onclick = () =>
    widget.invoke('app:settings:set', { source: { mode: 'manual' } }).catch(() => {});

  // 双击标题栏 → 迷你/完整切换
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.ib') || e.target.closest('.gbtn') || e.target.closest('#grouppop')) return;
    widget.invoke('app:win:form', {
      form: settings.window.form === 'full' ? 'mini' : 'full',
    }).catch(() => {});
  });

  // 键盘导航：↑↓ 选行、Enter 展开分时（鼠标不用挪过去）；输入框聚焦时让位。
  // 注：⌘F 由主进程 before-input-event 捕获后广播 evt:focus-search（面板窗口非 key 时键盘事件进不来）
  let kSel = null;
  const keyRows = () => [...$('#listinner').children].filter((x) => x.dataset.key);
  const applyK = () => {
    for (const x of keyRows()) x.classList.toggle('kfocus', x.dataset.key === kSel);
  };
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = keyRows();
      if (!rows.length) return;
      e.preventDefault();
      let i = rows.findIndex((x) => x.dataset.key === kSel);
      i = i < 0
        ? (e.key === 'ArrowDown' ? 0 : rows.length - 1)
        : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      kSel = rows[i].dataset.key;
      applyK();
      rows[i].scrollIntoView({ block: 'nearest' });
      autoScroll.nudge(); // 键盘翻行时暂停轮播几秒，避免抢滚动
    } else if (e.key === 'Enter' && kSel) {
      const el = keyRows().find((x) => x.dataset.key === kSel);
      if (el) toggleSpark(el);
    }
  });

  // Esc：穿透状态下第一优先级是恢复可点击（此时鼠标已不可用，键盘是唯一窗口内通道）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (penOn) {
      $('#addpop').hidden = true;
      $('#vispop').hidden = true;
      $('#grouppop').hidden = true;
      syncPopExpand();
      if (newsOpen) toggleNews();
      widget.invoke('app:penetrate').catch(() => {});
      return;
    }
    if (!$('#addpop').hidden) { $('#addpop').hidden = true; syncPopExpand(); return; }
    if (!$('#vispop').hidden) { $('#vispop').hidden = true; syncPopExpand(); return; }
    if (!$('#grouppop').hidden) { $('#grouppop').hidden = true; syncPopExpand(); return; }
    if (!$('#alertpop').hidden) { $('#alertpop').hidden = true; syncPopExpand(); return; }
    if (newsOpen) toggleNews();
  });

  // 点击弹层外关闭（添加 / 可视控制 / 分组）；同时清除键盘选中态（点鼠标即放弃键选）
  document.addEventListener('mousedown', (e) => {
    if (kSel != null) { kSel = null; applyK(); }
    let closed = false;
    const pop = $('#addpop');
    if (!pop.hidden && !pop.contains(e.target) && !$('#btn-add').contains(e.target)) {
      pop.hidden = true; closed = true;
    }
    const vp = $('#vispop');
    if (!vp.hidden && !vp.contains(e.target) && !$('#btn-eye').contains(e.target)) {
      vp.hidden = true; closed = true;
    }
    const gp = $('#grouppop');
    if (!gp.hidden && !gp.contains(e.target) && !$('#btn-group').contains(e.target)) {
      gp.hidden = true; closed = true;
    }
    const ap = $('#alertpop');
    if (!ap.hidden && !ap.contains(e.target)) {
      ap.hidden = true; closed = true;
    }
    if (closed) syncPopExpand();
    // 窗口内任意点击也收起设置窗（非激活面板不夺焦点，失焦事件不一定触发）
    widget.invoke('app:settings:hide').catch(() => {});
  });

  // 空白处右键：浓度/排序/形态/隐身快捷菜单
  const bgCtx = (e) => { e.preventDefault(); widget.invoke('app:bg:ctx').catch(() => {}); };
  $('#list').addEventListener('contextmenu', (e) => { if (e.target.closest('.row')) return; bgCtx(e); });
  $('#indexbar').addEventListener('contextmenu', bgCtx);
  $('#statusbar').addEventListener('contextmenu', bgCtx);

  // 冒烟模式：截图前展开可视控制面板供检查
  if (IS_SMOKE) { $('#vispop').hidden = false; syncVis(); }

  // 表头点击排序（三态循环）
  $('#ch-price').onclick = () => cycleSort('price');
  $('#ch-pct').onclick = () => cycleSort('pct');
  $('#ch-name').onclick = () => widget.invoke('app:settings:set', { source: { sortMode: 'default' } }).catch(() => {});

  // 边缘缩放条：免激活直接拖（点边缘即开始，松开结束）
  for (const [id, dir] of [['#rz-e', 'e'], ['#rz-s', 's'], ['#rz-se', 'se']]) {
    const el = $(id);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      widget.invoke('app:resize:start', { dir }).catch(() => {});
      const onUp = () => {
        widget.invoke('app:resize:end').catch(() => {});
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mouseup', onUp);
    });
  }

  // 主题跟随系统
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings && settings.appearance.theme === 'auto') {
      app.dataset.theme = resolvedTheme();
    }
  });
}

boot();


