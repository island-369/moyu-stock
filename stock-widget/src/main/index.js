'use strict';
/**
 * 主入口（D1 拆分后）：生命周期、单实例锁、托盘/快捷键接线、崩溃恢复、冒烟模式（--smoke）。
 * 尺寸/弹层/缩放会话 → window-sizing.js；老板键/会议/提醒静默/防录屏/Dock 联动 → stealth.js；
 * 配置迁移 → migrations.js；冒烟 → smoke.js。
 */
const { app, session, nativeTheme, Notification, Menu } = require('electron');
const path = require('path');

const { Store } = require('../store/settings');
const { ROOT, DEFAULT_SHORTCUTS, SMOKE_LIST } = require('../shared/constants');
const { Logger } = require('./logger');
const { createMainWindow, createOrShowSettingsWindow, getSettingsWindow, setQuitting, setSettingsVisHook } = require('./window');
const { sessionFetcher, attachRefererFix, openLoginWindow, logout } = require('./login-window');
const { TrayMgr } = require('./tray');
const { registerAll } = require('./shortcuts');
const { Orchestrator } = require('./orchestrator');
const { runMigrations } = require('./migrations');
const { createSizing } = require('./window-sizing');
const { createStealth } = require('./stealth');
const { runSmoke } = require('./smoke');
const { validateAndExit } = require('./validate-write');
const toast = require('./toast');
const { setupIpc } = require('./ipc');

const SMOKE = process.argv.includes('--smoke');
const VALIDATE_WRITE = process.argv.includes('--validate-write');

if (SMOKE) {
  // 冒烟模式用独立 profile，绝不污染真实设置
  app.setPath('userData', path.join(ROOT, '.smoke-profile'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(main).catch((e) => {
    console.error('FATAL', e);
    app.exit(1);
  });
}

let mainWin = null;
let settings = null;
let orch = null;
let log = null;
let loginSes = null;
let sizing = null;   // 尺寸/弹层/缩放会话（main() 里创建，依赖 settings/broadcast）
let stealth = null;  // 隐蔽状态机（main() 里创建，依赖 tray/sizing/回调）
const trayMgr = new TrayMgr();
let penetrate = false;
let loginWin = null;
let pendingNotice = null; // 窗口隐藏期间产生的小窗内提示，唤回时以黄条补发（不再走系统通知）
let pauseTimer = null;    // pauseWhenHidden：隐藏满 5 分钟的暂停定时器
let crashTimes = [];      // 渲染进程崩溃时间戳（熔断用，A3）
let autoscrollOn = false; // 列表滚动运行态（渲染层为源头，经 app:autoscroll:set 镜像，供右键菜单显示标签）

const trayCtx = {
  isVisible: false,
  penetrate: false,
  form: 'full',
  loggedIn: false,
  dock: false,
  meeting: false,
  contentProt: false,
  onShowHide: () => toggleMainWindow(),
  onPenetrate: (on) => setPenetrate(on),
  onForm: (f) => setForm(f),
  onDock: (on) => {
    settings.set({ behavior: { dockIcon: !!on } });
    setDockIcon(!!on);
  },
  onMeeting: (on) => stealth.setMeetingMode(!!on),
  onContentProt: (on) => {
    settings.set({ behavior: { contentProtection: !!on } });
    stealth.applyContentProtection();
  },
  onRefresh: () => orch && orch.force(),
  onSettings: () => createOrShowSettingsWindow(),
  onLogin: () => openLogin(),
  onLogout: () => doLogout(),
};

function syncTray() {
  trayCtx.isVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
  trayCtx.penetrate = penetrate;
  trayCtx.form = settings ? settings.get().window.form : 'full';
  trayCtx.loggedIn = !!(orch && orch.loggedIn);
  trayCtx.dock = settings ? !!settings.get().behavior.dockIcon : false;
  trayCtx.meeting = !!(stealth && stealth.isMeeting());
  trayCtx.contentProt = !!(stealth && stealth.isMeeting()) || !!(settings && settings.get().behavior.contentProtection);
  trayMgr.rebuild();
  buildDockMenu();
}

/** 统一广播（主窗 + 设置窗）。登录窗加载的是东财网页、没有我们的监听器，
 *  不再向它发送（此前每 5s 的全量 state 也发给它，纯浪费）；ipc.js 复用同一实现（D4）。 */
function broadcast(ch, data) {
  const settingsWin = getSettingsWindow();
  for (const w of [mainWin, settingsWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(ch, data); } catch (e) { /* 忽略 */ }
    }
  }
}

/** 只发主窗（轻量状态补丁用：设置窗需要完整结构） */
function sendToMain(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send(ch, data); } catch (e) { /* 忽略 */ }
  }
}

function settingsWindowRef() {
  return getSettingsWindow();
}

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (!stealth.isMeeting()) stealth.setBossHidden(false); // 会议模式中呼出：保持静默/菜单栏清空，散会后自动恢复
  stealth.stealthDock(false); // 隐身时临时藏掉的 Dock 图标，按用户设置恢复
  settings.data.window.startHidden = false; // 已唤回：下次启动正常显示
  settings.saveSoon();
  mainWin.show();
  syncTray();
  stealth.setAlertSignal(0); // 已看过，菜单栏信号清除（顺带刷新标题）
  stealth.flushMissedAlerts();
  if (pendingNotice) { // 隐藏期间积累的小窗内提示，唤回时补发（P0-2：不再弹系统通知）
    broadcast('evt:notice', { text: pendingNotice, ms: 6000 });
    pendingNotice = null;
  }
}

function toggleMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isVisible()) {
    mainWin.hide();
    syncTray();
  } else {
    showMainWindow();
  }
}

/** 老板键隐身时联动隐藏辅助窗：只藏主窗，设置窗/登录窗留在屏上等于白按 */
function hideAuxWindows() {
  const sw = getSettingsWindow();
  if (sw && !sw.isDestroyed() && sw.isVisible()) sw.hide();
  if (loginWin && !loginWin.isDestroyed() && loginWin.isVisible()) loginWin.hide();
}

/** 退到后台：窗口隐藏，行情继续刷新，菜单栏/托盘常驻 */
function hideToBackground() {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return;
  sizing.stopPopupWatch();
  broadcast('evt:popup:close', {});
  mainWin.hide();
  syncTray();
  log.info('窗口退到后台（行情继续，托盘常驻）');
  const s = settings.get();
  if (!s.behavior.hideHintShown) {
    settings.set({ behavior: { hideHintShown: true } });
    // 不再弹系统通知（首次弹通知会触发 macOS 授权框，E4）：改为小窗内黄条，下次唤回时补发
    pendingNotice = s.behavior.dockIcon
      ? '小窗已退到后台 · 行情继续刷新：点 Dock 图标或菜单栏「沪 …」即可唤回'
      : '小窗已退到后台 · 行情继续刷新：点菜单栏「沪 …」即可唤回';
  }
}

/** Dock 图标开关：开启后与普通应用一致（最小化/点击 Dock 恢复）；设专属彩色图标 */
function setDockIcon(on) {
  if (on && stealth && stealth.isDockHidden()) { syncTray(); return; } // 隐身中：恢复交给唤回流程统一处理
  try {
    if (on) {
      // 无条件 show 自愈：历史状态可能卡在 UIElement/accessory，isVisible 不可信
      Promise.resolve(app.dock.show()).then(
        (ok) => log.info('dock show: ' + ok),
        (e) => log.warn('dock show 失败: ' + (e && e.message)),
      );
      try {
        app.dock.setIcon(path.join(ROOT, 'assets', 'app-icon.png'));
      } catch (e) { /* 图标失败不影响功能 */ }
      if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) app.dock.activate();
    } else {
      app.dock.hide();
    }
  } catch (e) {
    log.warn('dock 切换失败: ' + e.message);
  }
  syncTray();
}

function setPenetrate(on) {
  penetrate = !!on;
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setIgnoreMouseEvents(penetrate, { forward: true });
  }
  syncTray();
  broadcast('evt:penetrate', penetrate);
  broadcast('evt:notice', {
    text: penetrate
      ? '鼠标穿透已开启 · 按 ⌥⇧X / ⌘Tab 后按 Esc / 右键 Dock 图标 均可恢复'
      : '鼠标穿透已关闭',
  });
}

/** Dock 图标右键菜单：穿透/隐藏状态的额外恢复通道（不依赖菜单栏和快捷键） */
function buildDockMenu() {
  if (!settings || !settings.get().behavior.dockIcon) return;
  const tpl = [
    { label: mainWin && mainWin.isVisible() ? '隐藏小窗（退到后台）' : '显示小窗', click: () => toggleMainWindow() },
    { label: penetrate ? '✓ 关闭鼠标穿透（恢复可点击）' : '开启鼠标穿透', click: () => setPenetrate(!penetrate) },
    { label: '设置…', click: () => createOrShowSettingsWindow() },
    { type: 'separator' },
    { label: '退出行情小窗', click: () => app.quit() },
  ];
  try { app.dock.setMenu(Menu.buildFromTemplate(tpl)); } catch (e) { /* 忽略 */ }
}

function setForm(form) {
  settings.set({ window: { form } });
  const next = settings.get();
  broadcast('evt:settings', next);
  if (mainWin && !mainWin.isDestroyed()) {
    const [width, height] = mainWin.getSize();
    if (form === 'mini') {
      // 进入迷你条：记住完整形态尺寸（而非迷你尺寸），退出时原样恢复；
      // 先用保守高度，渲染层量测标题栏后回设精确值
      const h = sizing.beginMini(width, height);
      try { mainWin.setResizable(false); mainWin.setMinimumSize(210, 30); } catch (e) { /* 忽略 */ }
      sizing.applySize(width, h);
    } else {
      const target = sizing.endMiniTarget(height);
      try { mainWin.setResizable(true); mainWin.setMinimumSize(210, 220); } catch (e) { /* 忽略 */ }
      sizing.applySize(width, target);
    }
  }
  syncTray();
}

function applyVibrancy() {
  if (mainWin && !mainWin.isDestroyed()) {
    const s = settings.get();
    const on = !!s.appearance.vibrancy && s.appearance.bgAlpha >= 0.55;
    try { mainWin.setVibrancy(on ? 'under-window' : null); } catch (e) { /* 忽略 */ }
  }
}

function updateTrayTitle() {
  const st = orch && orch.currentState();
  if (!st || !stealth) { trayMgr.setIndexTitle([], !!(stealth && stealth.isBossHidden()), 0, false); return; }
  // 数据滞后标记（3.2）：轮询暂停中，或拉取持续失败超 5 分钟 → 菜单栏尾部加中性「·」，
  // 避免把旧数字误读成实时（收盘后的自然滞后不算，那本来就是收盘价）
  const stale = (orch.isPaused && orch.isPaused())
    || (st.status && st.status.code === 'net-error' && Date.now() - (st.status.lastUpdate || 0) > 5 * 60 * 1000);
  trayMgr.setIndexTitle(st.indexes, stealth.isBossHidden(), stealth.getAlertSignal(), stale);
}

/** pauseWhenHidden（P0-5）：窗口隐藏超 5 分钟 → 暂停行情/云同步轮询（省电省流量，
 *  网关侧也少一条稳定特征）；唤回立即恢复并刷新。托盘「刷新自选」始终可用（force 解除暂停）。 */
function applyPausePolicy() {
  if (!orch) return;
  const on = !!settings.get().behavior.pauseWhenHidden;
  const visible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
  if (!on || visible) {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    orch.resume();
    return;
  }
  if (!pauseTimer && !orch.isPaused()) {
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
        orch.pause();
        updateTrayTitle(); // 菜单栏补「数据滞后」标记
      }
    }, 5 * 60 * 1000);
  }
}

/** ⌥⇧←/→ 循环切换分组：全部 → 持仓 → 各云分组（manual：自选 → 持仓）；顺序与分组下拉一致 */
function cycleGroup(dir) {
  if (!orch) return;
  const st = orch.currentState();
  if (!st) return;
  const seq = [];
  const hasGroups = st.mode === 'cloud' && st.groups && st.groups.length;
  const hasPositions = (st.positionsCount || 0) > 0;
  if (hasGroups) {
    seq.push('all');
    if (hasPositions) seq.push('__positions__');
    for (const g of st.groups) seq.push(String(g.gid));
  } else {
    seq.push('default');
    if (hasPositions) seq.push('__positions__');
  }
  let cur = st.activeGroup || 'first';
  if (cur === 'first') cur = hasGroups ? String(st.groups[0].gid) : 'default';
  const i = seq.indexOf(String(cur));
  const next = seq[((i < 0 ? 0 : i) + dir + seq.length) % seq.length];
  // 切分组时恢复该分组自己上次的排序（没用过 = 默认原序）
  settings.set({ source: { activeGroup: next, sortMode: orch.sortForGroup(next) } });
  broadcast('evt:settings', settings.get()); // 排序随分组变了，界面要跟上
  orch.scheduleQuote(0);
  log.info('快捷键切换分组 → ' + next + ' · 排序 ' + settings.get().source.sortMode);
}

/** 开机自启：上班开机即有，省掉"手动开应用"这个暴露动作。冒烟模式绝不触碰登录项。 */
function applyLoginItem() {
  if (SMOKE) return;
  try {
    const on = !!settings.get().behavior.launchAtLogin;
    if (app.getLoginItemSettings().openAtLogin !== on) {
      app.setLoginItemSettings({ openAtLogin: on });
      log.info('开机自启 → ' + on);
    }
  } catch (e) { log.warn('登录项设置失败: ' + e.message); }
}

function openExternalUrl(url) {
  if (!/^https?:\/\/[a-zA-Z0-9.-]*\.eastmoney\.com(\/|$)/.test(url)) return { ok: false };
  require('electron').shell.openExternal(url);
  return { ok: true };
}

function setStar(key, on) {
  const stars = { ...(settings.get().source.manualStars || {}) };
  if (on) stars[key] = true; else delete stars[key];
  settings.set({ source: { manualStars: stars } });
  orch.scheduleQuote(0);
}

function removeStock(row) {
  const key = row.market + row.code;
  const list = (settings.get().source.manualList || []).filter((e) => (e.m + e.c) !== key);
  const stars = { ...(settings.get().source.manualStars || {}) };
  delete stars[key];
  settings.set({ source: { manualList: list, manualStars: stars } });
  orch.scheduleQuote(0);
}

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    if (!loginWin.isVisible()) loginWin.show(); // 被老板键藏过后再点「扫码登录」要能重新唤起
    loginWin.focus();
    return;
  }
  loginWin = openLoginWindow({
    ses: loginSes,
    log: (m) => log.info(m),
    onSuccess: () => {
      loginWin = null;
      orch.onLoginSuccess();
      syncTray();
      // 不再弹系统通知（E4：避免触发 macOS 授权弹窗）：小窗内黄条即达意
      broadcast('evt:notice', { text: '登录成功，云端自选开始同步', ms: 5000 });
    },
    onCancelled: () => { loginWin = null; },
  });
}

async function doLogout() {
  await logout(loginSes);
  orch.onLogout();
  syncTray();
  broadcast('evt:notice', { text: '已退出登录，本地 Cookie 已清除' });
}

function reregisterShortcuts() {
  const sc = settings.get().shortcuts || DEFAULT_SHORTCUTS;
  const handlers = {
    boss: () => stealth.bossAction(),
    showhide: toggleMainWindow,
    penetrate: () => setPenetrate(!penetrate),
    alphaUp: () => nudgeAlpha(+0.05),
    alphaDown: () => nudgeAlpha(-0.05),
    meeting: () => stealth.setMeetingMode(!stealth.isMeeting()),
    groupPrev: () => cycleGroup(-1),
    groupNext: () => cycleGroup(+1),
  };
  registerAll(sc, handlers, (name, acc) => {
    log.warn('快捷键注册失败（可能冲突）: ' + name + ' = ' + acc);
    broadcast('evt:notice', { text: `快捷键 ${acc} 注册失败（与其他应用冲突），请在设置中改绑` });
  });
}

function nudgeAlpha(delta) {
  const s = settings.get();
  const next = Math.max(0.35, Math.min(1, +(s.appearance.bgAlpha + delta).toFixed(2)));
  settings.setSoon({ appearance: { bgAlpha: next } }); // 高频按键：防抖落盘（D12）
  broadcast('evt:settings', settings.get());
}

/** 空白处右键快捷菜单：浓度/排序/形态/隐身/设置（不依赖找到眼睛按钮）。
 *  注：sortMode 归一化已收口到 Store（load/set 写入时归一），读侧直接用原始值。 */
function setSort(m) {
  const patch = { source: { sortMode: m } };
  if (orch && orch.rememberSort) patch.source.groupSorts = orch.rememberSort(m); // 记到当前分组名下
  settings.set(patch);
  broadcast('evt:settings', settings.get());
}

/** 提醒弹窗色条颜色：跟随红涨绿跌/单色设置 */
function riseColor() {
  const s = settings.get().appearance;
  return s.mono ? '#9BA1A8' : (s.upColor === 'green' ? '#30A46C' : '#E5484D');
}
function fallColor() {
  const s = settings.get().appearance;
  return s.mono ? '#9BA1A8' : (s.upColor === 'green' ? '#E5484D' : '#30A46C');
}

function bgContextMenu() {
  const s = settings.get();
  const cur = Math.round(s.appearance.bgAlpha * 100);
  const alphaItem = (v) => ({
    label: v + '%', type: 'radio', checked: Math.abs(cur - v) < 3,
    click: () => {
      settings.set({ appearance: { bgAlpha: v / 100 } });
      broadcast('evt:settings', settings.get());
      applyVibrancy();
    },
  });
  const tpl = [
    { label: '背景浓度', submenu: [35, 50, 65, 80, 100].map(alphaItem) },
    {
      label: '单色模式（去红绿）', type: 'checkbox', checked: !!s.appearance.mono,
      click: (it) => {
        settings.set({ appearance: { mono: it.checked } });
        broadcast('evt:settings', settings.get());
      },
    },
    {
      label: '显示股票代码', type: 'checkbox', checked: !!s.appearance.showCode,
      click: (it) => {
        settings.set({ appearance: { showCode: it.checked } });
        broadcast('evt:settings', settings.get());
      },
    },
    {
      label: '仅看置顶', type: 'checkbox', checked: !!s.source.filterStarred,
      click: (it) => {
        settings.set({ source: { filterStarred: it.checked } });
        broadcast('evt:settings', settings.get());
      },
    },
    {
      label: '排序',
      submenu: [
        { label: '默认（自选顺序）', type: 'radio', checked: (s.source.sortMode || 'default') === 'default', click: () => setSort('default') },
        { label: '涨幅 ↓', type: 'radio', checked: s.source.sortMode === 'pct-desc', click: () => setSort('pct-desc') },
        { label: '跌幅 ↓', type: 'radio', checked: s.source.sortMode === 'pct-asc', click: () => setSort('pct-asc') },
        { label: '价格 高→低', type: 'radio', checked: s.source.sortMode === 'price-desc', click: () => setSort('price-desc') },
        { label: '价格 低→高', type: 'radio', checked: s.source.sortMode === 'price-asc', click: () => setSort('price-asc') },
      ],
    },
    {
      label: autoscrollOn ? '停止滚动' : '启动滚动',
      click: () => broadcast('evt:autoscroll', { on: !autoscrollOn }),
    },
    {
      label: '迷你条', type: 'checkbox', checked: s.window.form === 'mini',
      click: () => setForm(s.window.form === 'mini' ? 'full' : 'mini'),
    },
    {
      label: '会议模式（隐身 + 防录屏 + 静默）', type: 'checkbox', checked: stealth.isMeeting(),
      click: () => stealth.setMeetingMode(!stealth.isMeeting()),
    },
    {
      label: '防录屏保护（共享/录屏/截屏不可见）', type: 'checkbox', checked: !!s.behavior.contentProtection,
      click: (it) => {
        settings.set({ behavior: { contentProtection: it.checked } });
        stealth.applyContentProtection();
      },
    },
    { type: 'separator' },
    { label: '立即隐身', click: () => stealth.bossAction() },
    { label: '设置…', click: () => createOrShowSettingsWindow() },
  ];
  const w = mainWin;
  if (w && !w.isDestroyed()) {
    try { Menu.buildFromTemplate(tpl).popup({ window: w }); } catch (e) { /* 忽略 */ }
  }
}

/** 主窗事件集中接线（含崩溃重建后的复接） */
function wireMainWindow(win) {
  win.on('show', () => { syncTray(); applyPausePolicy(); });
  win.on('hide', () => { syncTray(); applyPausePolicy(); });
  // 失焦收弹层：非激活面板不一定收得到点击，blur 是第一道、光标监视是兜底。
  // （2026-10 修复 A3：此前只挂在 main() 里，崩溃重建后的窗口没有这条接线）
  win.on('blur', () => { sizing.stopPopupWatch(); broadcast('evt:popup:close', {}); });
  // 穿透重放（A3）：重建的新窗口要恢复 ignoreMouseEvents，否则黄条提示与实际行为相反
  if (penetrate) {
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { /* 忽略 */ }
  }
  // 用户拖边调整尺寸 → 自动切手动尺寸模式（关闭高度自适应，可随时在设置重开）
  win.on('resized', () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getSize();
    if (sizing.isProgSize(w, h)) return; // 本模块刚程序化设置的，不是用户拖拽
    if (settings.get().appearance.autoHeight || settings.get().appearance.autoWidth) {
      settings.set({ appearance: { autoHeight: false, autoWidth: false } });
      broadcast('evt:settings', settings.get());
      broadcast('evt:notice', { text: '已切换为手动尺寸（自适应关闭，设置里可重新开启）' });
      log.info('用户手动调整窗口尺寸 → 自适应关闭');
    }
  });
  wireWindowKeys(win);
}

/** 普通应用式快捷键：⌘M/⌘W 退到后台，⌘, 打开设置，⌘F 聚焦搜索 */
function wireWindowKeys(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('before-input-event', (e, input) => {
    if (!input || input.type !== 'keyDown' || !(input.meta || input.control)) return;
    if (input.alt) return;
    const k = (input.key || '').toLowerCase();
    if (k === 'm' || k === 'w') {
      e.preventDefault();
      hideToBackground();
    } else if (k === ',') {
      e.preventDefault();
      createOrShowSettingsWindow();
    } else if (k === 'f') {
      e.preventDefault();
      broadcast('evt:focus-search', {}); // 面板窗口非 key 时键盘事件进不来，由主进程转发
    }
  });
}

/* ---------------- 主流程 ---------------- */

function main() {
  const userData = app.getPath('userData');
  log = new Logger(path.join(userData, 'logs'));
  log.info('=== 行情小窗启动 v0.1.0 smoke=' + SMOKE + ' ===');

  settings = new Store(path.join(userData, 'settings.json')).load();
  // 配置迁移（历史布尔标记 + schemaVersion 迁移表，见 migrations.js）
  runMigrations(settings, log);

  // 拆分出的两个状态机（依赖 settings/log，只能在此创建；此后所有调用走实例）
  sizing = createSizing({ getMainWin: () => mainWin, settings, broadcast });
  stealth = createStealth({
    getMainWin: () => mainWin,
    getAuxWindows: () => [getSettingsWindow(), loginWin],
    hideAuxWindows,
    settings,
    tray: trayMgr,
    log,
    broadcast,
    sizing,
    syncTray,
    showMainWindow,
    setDockIcon,
    updateTrayTitle,
  });

  // Dock 策略：Electron 默认就是常规应用（有 Dock 图标）。
  // 只在用户关闭时 hide —— 避免启动时 hide→show 快速切换导致卡在无 Dock 状态。
  if (!settings.get().behavior.dockIcon) {
    app.dock.hide();
  } else {
    // 强制拉回常规应用策略：历史状态可能卡在 UIElement/accessory（此时 isVisible 不可信，
    // 且图标开关切换后 show() 偶发不生效），启动时无条件 show 一次自愈
    Promise.resolve(app.dock.show()).catch((e) => log.warn('dock show 失败: ' + e.message));
    try { app.dock.setIcon(path.join(ROOT, 'assets', 'app-icon.png')); } catch (e) { /* 忽略 */ }
  }
  try { log.info('Dock 可见性: ' + app.dock.isVisible()); } catch (e) { log.warn('Dock 可见性查询失败: ' + e.message); }
  if (SMOKE) {
    settings.data.onboarded = true;
    settings.data.source.manualList = SMOKE_LIST.map((e) => ({ m: e.m, c: e.c }));
    settings.data.appearance.autoHeight = true;
    settings.data.window.bounds = null;
    settings.data.window.startHidden = false; // 冒烟需要窗口可见（截图）
    settings.save();
  }

  loginSes = session.fromPartition('persist:em-login');
  attachRefererFix(loginSes); // myfavor 接口强制要求 Referer（见 login-window.js 注释）

  // 写回链路真机验证：加一只测试股再删掉，验证完直接退出（不进正常启动流程）。
  // 需先退出正在运行的行情小窗（单实例锁）；详见 validate-write.js 头部说明。
  if (VALIDATE_WRITE) {
    log.info('validate-write 模式启动');
    validateAndExit({ fetcher: sessionFetcher(loginSes), log }).catch((e) => {
      log.error('validate-write crash', e && e.message);
      app.exit(1);
    });
    return;
  }

  orch = new Orchestrator({
    settings,
    log,
    makeFetcher: () => sessionFetcher(loginSes),
    snapshotFile: path.join(userData, 'snapshot.json'),
  });
  toast.init({ settings, log, showMainWindow });
  orch.on('state', (st) => {
    if (st && st.light) {
      sendToMain('evt:state', st); // 轻量状态补丁只发主窗（设置窗需要完整结构）
    } else {
      broadcast('evt:state', st);
    }
    updateTrayTitle();
  });
  orch.on('login', (ok) => {
    broadcast('evt:login', ok);
    syncTray();
  });
  orch.on('api-changed', () => {
    broadcast('evt:notice', { text: '云端自选接口疑似变更，已切换手动模式兜底' });
  });
  // 云端写回（双向同步）结果提示：写失败/未同步 → 小窗内黄条，不动登录态
  orch.on('notice', (n) => broadcast('evt:notice', n || {}));
  // 摸鱼核心：异动找你，不用盯。
  // 分发优先级：窗口可见 → 小窗内黄条（零暴露）→ 隐身/会议 → 静默累积 → 否则按提醒方式分发。
  // 系统横幅仅 banner 档弹发且一律 silent（P0-2：不出声、不触发不必要的系统交互）。
  orch.on('alert', (a) => {
    try {
      const s = settings.get();
      // 指数异动用 ▲▲/▼▼ 双符号（与个股 ▲/▼ 区分）；菜单栏信号任何模式都更新
      stealth.setAlertSignal(a.market === 'IX' ? (a.pct > 0 ? 2 : -2) : (a.pct > 0 ? 1 : -1));
      const winVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
      const th = a.market === 'IX' ? (s.alerts && s.alerts.indexThreshold) : s.alerts.threshold;
      if (winVisible) {
        // 窗口开着：黄条提示即可，弹系统通知反而多余且显眼
        broadcast('evt:notice', {
          text: `${a.market === 'IX' ? '大盘 · ' : ''}${a.name} ${a.pct > 0 ? '+' : ''}${a.pct.toFixed(2)}% · 越过 ±${th}% 阈值`,
          ms: 5000,
        });
        return;
      }
      if (stealth.alertsPaused()) { stealth.pushMissed(a); return; } // 隐身/会议：静默累积，唤回后展示
      const style = (s.alerts && s.alerts.style) || 'menubar';
      if (style === 'silent' || style === 'menubar') return; // 只靠信号/黄条，不弹横幅
      const lowKey = !!s.alerts.lowKey;
      const n = new Notification(lowKey
        ? {
            title: '行情提醒',
            body: `有自选越过 ±${th}% 阈值 · 点击查看`, // 不出现股票名与价格
            silent: true,
          }
        : {
            title: `${a.name} ${a.pct > 0 ? '+' : ''}${a.pct.toFixed(2)}%`,
            body: `现价 ${a.price != null ? a.price.toFixed(2) : '—'} · 越过 ±${th}% 阈值 · 点击查看`,
            silent: true,
          });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (e) { log.warn('异动提醒失败: ' + e.message); }
  });
  // 个股预警（列表右键 → 预警设置）：到价 + 异动（涨/跌幅越过专属阈值），持续有效；隐身/会议期间静默累积。
  // 命中用屏上弹窗（屏幕底部居中、可拖动记忆位置、不夺焦点），不用右上角系统通知。
  orch.on('pricealert', (a) => {
    try {
      const dir = a.op === 'lte' ? '≤' : '≥';
      const px = a.price != null ? a.price.toFixed(2) : '—';
      const kindTxt = a.kind === 'sw' ? '急涨急跌' : a.kind === 'pct' ? '异动预警' : '股价提醒';
      // sw=时间窗急涨急跌；pct=当日涨/跌幅异动；默认=到价提醒
      const text = a.kind === 'sw'
        ? `${a.name} 现价 ${px} · ${a.mins} 分钟内${a.op === 'lte' ? '跌' : '涨'}幅 ${Math.abs(a.pct).toFixed(2)}% 已超过 ${a.target}%`
        : a.kind === 'pct'
          ? `${a.name} 现价 ${px} · 今日${a.op === 'lte' ? '跌' : '涨'}幅 ${Math.abs(a.pct).toFixed(2)}% 已越过 ${dir}${a.target}%`
          : `${a.name} 现价 ${px} · 已${a.op === 'lte' ? '跌' : '涨'}到 ${dir} ${a.target.toFixed(2)}`;
      stealth.setAlertSignal(a.op === 'lte' ? -1 : 1);
      const winVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
      if (winVisible) broadcast('evt:notice', { text: text + ' · 提醒已生效', ms: 6000 });
      if (stealth.alertsPaused()) { stealth.pushMissedText(text); return; }
      toast.showAlertToast({
        title: `${kindTxt} · ${a.name}`,
        body: a.kind === 'sw'
          ? `现价 ${px}，${a.mins} 分钟内${a.op === 'lte' ? '跌幅' : '涨幅'} ${Math.abs(a.pct).toFixed(2)}% 已超过 ${a.target}%`
          : a.kind === 'pct'
            ? `现价 ${px}，今日${a.op === 'lte' ? '跌幅' : '涨幅'} ${Math.abs(a.pct).toFixed(2)}% 已越过 ${dir}${a.target}%`
            : `现价 ${px}，已${a.op === 'lte' ? '跌到' : '涨到'} ${dir} ${a.target.toFixed(2)}`,
        accent: a.op === 'lte' ? fallColor() : riseColor(),
      });
    } catch (e) { log.warn('个股预警通知失败: ' + e.message); }
  });
  // orchestrator 自己改了设置（如命中后移除规则）→ 同步给两个窗口
  orch.on('settings-changed', () => broadcast('evt:settings', settings.get()));
  orch.on('summary', (s) => {
    try {
      const st = settings.get();
      if (stealth.alertsPaused()) {
        // 隐身/会议中战报也静默：文本累积，唤回时随异动一起展示
        stealth.pushMissedText(`收盘战报：平均 ${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}% 涨${s.up} 跌${s.dn}`);
        return;
      }
      const avgTxt = `${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}%`;
      const style = (st.alerts && st.alerts.style) || 'menubar';
      const winVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
      if (style === 'silent' || style === 'menubar') {
        // 不弹横幅（P0-2 / E3：战报不再无视提醒方式设置）：菜单栏方向信号 + 窗口开着时黄条
        stealth.setAlertSignal(s.avg >= 0 ? 1 : -1);
        if (winVisible) {
          broadcast('evt:notice', { text: `收盘战报 · 平均 ${avgTxt} · 涨${s.up} 跌${s.dn} 平${s.flat}`, ms: 8000 });
        }
        return;
      }
      const lowKey = !!st.alerts.lowKey;
      const body = lowKey
        ? `平均 ${avgTxt} · 涨${s.up} 跌${s.dn} 平${s.flat}` // 低调模式：不出现股票名
        : `平均 ${avgTxt} · 涨${s.up} 跌${s.dn} 平${s.flat}\n领涨 ${s.top.name} ${s.top.pct > 0 ? '+' : ''}${s.top.pct.toFixed(2)}% · 领跌 ${s.bot.name} ${s.bot.pct.toFixed(2)}%`;
      const n = new Notification({ title: `收盘 · 自选战报（${s.count} 只）`, body, silent: true });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (e) { log.warn('战报通知失败: ' + e.message); }
  });

  // 隐身态冷启动：上次完全隐身后退出 → 本次启动保持隐身（不弹窗），菜单栏快捷键唤回。
  const startHidden = !!settings.get().window.startHidden && !!settings.get().onboarded;
  if (startHidden) stealth.setBossHidden(true);
  const mainWinOpts = SMOKE ? { query: { smoke: '1' } } : undefined;
  mainWin = createMainWindow(settings, log, { ...mainWinOpts, startHidden });
  wireMainWindow(mainWin);
  stealth.applyContentProtection(); // 恢复用户设置的防录屏状态（新窗口默认关闭）
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程崩溃: ' + details.reason + '，自动重建');
    // 熔断（A3）：60 秒内 3 次崩溃 → 不再无限 destroy/create 循环，退出留日志
    crashTimes.push(Date.now());
    crashTimes = crashTimes.filter((t) => Date.now() - t < 60000);
    if (crashTimes.length >= 3) {
      log.error('渲染进程 60 秒内崩溃 3 次，熔断退出');
      app.quit();
      return;
    }
    sizing.resetForRebuild(); // 清掉指向旧窗口的弹层监视/缩放会话/临时撑高状态
    const bounds = mainWin ? mainWin.getBounds() : null;
    // 隐身/退后台中崩溃 → 重建后保持隐藏（自动弹出等于暴露）；会议模式中同理
    const startHidden = !(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
    if (mainWin && !mainWin.isDestroyed()) mainWin.destroy();
    mainWin = createMainWindow(settings, log, { ...(SMOKE ? { query: { smoke: '1' } } : {}), startHidden });
    if (bounds) { try { mainWin.setBounds(bounds); } catch (e) { /* 忽略 */ } }
    wireMainWindow(mainWin);
    stealth.applyContentProtection();
  });
  if (process.env.WIDGET_DEV) {
    mainWin.webContents.openDevTools({ mode: 'detach' });
  }

  const ctx = {
    getMainWin: () => mainWin,
    getSettingsWin: () => settingsWindowRef(),
    settings,
    orch,
    log,
    reregisterShortcuts,
    applyVibrancy,
    syncTray,
    openLogin,
    doLogout,
    setForm,
    setHeight: (h) => sizing.setHeight(h),
    setWidth: (w) => sizing.setWidth(w),
    expandForPopup: (h) => sizing.expandForPopup(h),
    setPopupWatch: (open) => sizing.setPopupWatch(open),
    startResizeSession: (dir) => sizing.startResizeSession(dir),
    stopResizeSession: () => sizing.stopResizeSession(),
    openExternalUrl,
    setStar,
    removeStock,
    togglePenetrate: () => setPenetrate(!penetrate),
    bossAction: () => stealth.bossAction(),
    toggleMeeting: () => stealth.setMeetingMode(!stealth.isMeeting()),
    applyLoginItem,
    hideToBackground,
    setDockIcon,
    applyContentProtection: () => stealth.applyContentProtection(),
    bgContextMenu,
    broadcast,           // ipc.js 复用同一广播实现（D4：此前两处实现覆盖的窗口集合不同）
    applyPausePolicy,    // 设置里改 pauseWhenHidden 后即时生效
    getPenetrate: () => penetrate,
    setAutoscrollOn: (v) => { autoscrollOn = !!v; },
    toast,
    openSettingsWin: () => createOrShowSettingsWindow(),
  };
  setupIpc(ctx);
  setSettingsVisHook((v) => broadcast('evt:win:settings-vis', { visible: !!v }));

  try { trayMgr.init(trayCtx, log); } catch (e) { log.warn('托盘初始化失败: ' + e.message); }
  syncTray();

  applyLoginItem(); // 开机自启（按设置同步系统登录项；仅状态变化时写）

  reregisterShortcuts();

  orch.start();

  // 隐身态冷启动：连 Dock 也不出现（用户开着 dockIcon 时临时藏，P0-1）
  if (stealth.isBossHidden()) stealth.stealthDock(true);
  applyPausePolicy(); // pauseWhenHidden 初始评估（含隐身冷启动场景）

  nativeTheme.on('updated', () => {
    if (settings.get().appearance.theme === 'auto') {
      broadcast('evt:settings', settings.get());
    }
  });

  app.on('second-instance', () => showMainWindow());
  app.on('activate', () => showMainWindow()); // Dock 模式下点图标恢复
  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
  app.on('before-quit', () => {
    setQuitting(true); // 放行主窗 close（否则 preventDefault 会中止 app.quit，托盘/Dock/界面退出全部失效）
    try { require('electron').globalShortcut.unregisterAll(); } catch (e) { /* 忽略 */ }
    if (orch) orch.stop();
    try { settings.flush(); } catch (e) { /* 忽略 */ } // 防抖中的设置改动（浓度等）退出前落盘
    trayMgr.destroy();
  });

  if (SMOKE) runSmoke({ orch, getMainWin: () => mainWin, log });
}
