'use strict';
/**
 * 主入口：生命周期、单实例锁、崩溃恢复、冒烟模式（--smoke）。
 */
const { app, session, nativeTheme, Notification, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('../store/settings');
const { ROOT, DEFAULT_SHORTCUTS, SMOKE_LIST } = require('../shared/constants');
const { Logger } = require('./logger');
const { createMainWindow, createOrShowSettingsWindow, getSettingsWindow, setQuitting, setSettingsVisHook } = require('./window');
const { sessionFetcher, attachRefererFix, openLoginWindow, logout } = require('./login-window');
const { TrayMgr } = require('./tray');
const { registerAll } = require('./shortcuts');
const { Orchestrator } = require('./orchestrator');
const toast = require('./toast');
const { setupIpc } = require('./ipc');

const SMOKE = process.argv.includes('--smoke');

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
const trayMgr = new TrayMgr();
let penetrate = false;
let bossHidden = false;
let loginWin = null;
let meetingMode = false;   // 会议模式：隐身 + 防录屏 + 提醒静默（⌥⇧M 一键切换，散会原样恢复）
let preMeeting = null;     // 进会议前的窗口可见性（退出时恢复）
let missedAlerts = [];     // 隐身/会议期间静默累积的提醒 [{key?, text}]，唤回时一次性展示
let alertSignal = 0;       // 菜单栏异动信号：0 无 / 1 有向上异动 ▲ / -1 有向下异动 ▼
let lastProgSize = null; // 最近一次程序化设置的窗口尺寸（用于区分用户手动拖拽）
let preMiniSize = null;  // 进入迷你条前的窗口尺寸（退出时恢复）
let popExpandHeight = 0; // 弹层临时撑高前的窗口高度（0 = 未撑高）
let resizeSession = null; // 自定义边缘缩放会话（光标追踪）

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
  onMeeting: (on) => setMeetingMode(!!on),
  onContentProt: (on) => {
    settings.set({ behavior: { contentProtection: !!on } });
    applyContentProtection();
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
  trayCtx.meeting = meetingMode;
  trayCtx.contentProt = meetingMode || !!(settings && settings.get().behavior.contentProtection);
  trayMgr.rebuild();
  buildDockMenu();
}

function broadcast(ch, data) {
  const settingsWin = getSettingsWindow();
  for (const w of [mainWin, loginWin, settingsWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(ch, data); } catch (e) { /* 忽略 */ }
    }
  }
}

function settingsWindowRef() {
  return getSettingsWindow();
}

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (!meetingMode) bossHidden = false; // 会议模式中呼出：保持静默/菜单栏清空，散会后自动恢复
  settings.data.window.startHidden = false; // 已唤回：下次启动正常显示
  settings.saveSoon();
  mainWin.show();
  syncTray();
  alertSignal = 0; // 已看过，菜单栏信号清除
  updateTrayTitle();
  flushMissedAlerts();
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

function bossAction() {
  if (!mainWin || mainWin.isDestroyed()) return;
  stopPopupWatch();
  broadcast('evt:popup:close', {});
  const s = settings.get();
  if (mainWin.isVisible()) {
    mainWin.hide();
    hideAuxWindows();
    if (s.behavior.bossKeyAction === 'hide') {
      bossHidden = true;
      trayMgr.setIndexTitle([], true); // 连菜单栏文字一起隐匿
      settings.data.window.startHidden = true; // 冷启动/崩溃重建后仍保持隐身
      settings.saveSoon();
    }
    syncTray();
  } else {
    const sw = getSettingsWindow();
    const auxOpen = (sw && sw.isVisible())
      || !!(loginWin && !loginWin.isDestroyed() && loginWin.isVisible());
    if (auxOpen) {
      // 主窗已藏但设置窗/登录窗开着：继续藏辅助窗，而不是把主窗唤回
      hideAuxWindows();
      syncTray();
    } else {
      showMainWindow();
    }
  }
}

/** 隐身/会议中：提醒静默（弹系统通知等于告诉老板你在看盘） */
function alertsPaused() {
  return bossHidden || meetingMode;
}

/** 菜单栏信号：非隐身时任何异动都在「沪…」旁标 ▲/▼（提醒方式=menubar 时的核心出口） */
function setAlertSignal(dir) {
  alertSignal = dir;
  updateTrayTitle();
}

/** 隐身/会议期间的异动静默累积（同股同方向去重，保留最新），唤回时一次性展示 */
function pushMissed(a) {
  const key = a.market + a.code + (a.pct > 0 ? '+' : '-');
  missedAlerts = missedAlerts.filter((m) => m.key !== key);
  missedAlerts.push({
    key,
    text: `${a.name} ${a.pct > 0 ? '+' : ''}${a.pct.toFixed(1)}%`,
  });
  if (missedAlerts.length > 20) missedAlerts.shift();
}

function pushMissedText(text) {
  missedAlerts.push({ text });
  if (missedAlerts.length > 20) missedAlerts.shift();
}

/** 唤回小窗时展示隐身期间错过的提醒（黄条在小窗内，零暴露） */
function flushMissedAlerts() {
  if (!missedAlerts.length) return;
  const head = missedAlerts.slice(-4).map((m) => m.text).join('、');
  const more = missedAlerts.length > 4 ? ` 等共 ${missedAlerts.length} 条` : '';
  broadcast('evt:notice', { text: `隐身期间错过：${head}${more}`, ms: 8000 });
  missedAlerts = [];
}

/** 防录屏（macOS 内容保护）：开启后窗口不出现在截屏/录屏/屏幕共享里。
 *  会议模式强制开启，退出恢复用户设置。 */
function applyContentProtection() {
  const on = meetingMode || !!(settings && settings.get().behavior.contentProtection);
  for (const w of [mainWin, getSettingsWindow(), loginWin]) {
    if (w && !w.isDestroyed()) {
      try { w.setContentProtection(on); } catch (e) { /* 旧系统无此 API */ }
    }
  }
}

/** 会议模式：一键隐身 + 防录屏 + 提醒静默（含菜单栏文字清空）；散会再按一次原样恢复。
 *  与老板键的区别：菜单栏必清（共享屏幕连菜单栏一起被录）、窗口防录屏、退出恢复原状。 */
function setMeetingMode(on) {
  if (on === meetingMode) return;
  meetingMode = !!on;
  if (meetingMode) {
    preMeeting = { wasVisible: !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) };
    stopPopupWatch();
    broadcast('evt:popup:close', {});
    if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
    hideAuxWindows();
    bossHidden = true; // 复用隐身语义：updateTrayTitle 清空菜单栏 + 提醒暂停
    applyContentProtection();
    log.info('会议模式开启：隐身 + 防录屏 + 提醒静默');
  } else {
    const wasVisible = preMeeting ? preMeeting.wasVisible : true;
    bossHidden = false;
    preMeeting = null;
    applyContentProtection();
    updateTrayTitle();
    log.info('会议模式关闭');
    if (wasVisible) showMainWindow(); // 散会恢复进会前状态（showMainWindow 顺带 flush 错过提醒）
  }
  broadcast('evt:meeting', meetingMode); // 渲染层眼睛面板按钮状态
  syncTray();
}

/** 退到后台：窗口隐藏，行情继续刷新，菜单栏/托盘常驻 */
function hideToBackground() {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return;
  stopPopupWatch();
  broadcast('evt:popup:close', {});
  mainWin.hide();
  syncTray();
  log.info('窗口退到后台（行情继续，托盘常驻）');
  const s = settings.get();
  if (!s.behavior.hideHintShown) {
    settings.set({ behavior: { hideHintShown: true } });
    try {
      new Notification({
        title: '行情小窗已退到后台',
        body: s.behavior.dockIcon
          ? '行情继续刷新。点 Dock 上的图标，或屏幕右上角菜单栏的「沪 3809」文字即可恢复。'
          : '行情继续刷新，菜单栏仍显示上证指数。点屏幕右上角菜单栏的「沪 3809」文字即可恢复。',
      }).show();
    } catch (e) { /* 忽略 */ }
  }
}

/** Dock 图标开关：开启后与普通应用一致（最小化/点击 Dock 恢复）；设专属彩色图标 */
function setDockIcon(on) {
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
      // 记住进入迷你条前的尺寸（而非迷你尺寸），退出时原样恢复
      if (!preMiniSize) preMiniSize = [width, height];
      popExpandHeight = 0;
      try { mainWin.setResizable(false); mainWin.setMinimumSize(210, 30); } catch (e) { /* 忽略 */ }
      applySize(width, 40); // 先用保守值，渲染层量测标题栏后回设精确高度
    } else {
      const target = preMiniSize && preMiniSize[1] >= 120 ? preMiniSize[1] : Math.max(260, height);
      preMiniSize = null;
      try { mainWin.setResizable(true); mainWin.setMinimumSize(210, 220); } catch (e) { /* 忽略 */ }
      applySize(width, target);
    }
  }
  syncTray();
}

/** 程序化设置尺寸（记录 lastProgSize，避免被当作手动拖拽写进 bounds） */
function applySize(width, height) {
  if (!mainWin || mainWin.isDestroyed()) return;
  const [w, cur] = mainWin.getSize();
  const h = Math.round(height);
  if (w === Math.round(width) && Math.abs(cur - h) <= 1) return;
  lastProgSize = [Math.round(width), h];
  mainWin.setSize(Math.round(width), h);
}

/** 弹层临时撑高：h>0 需要的高度；h=0 恢复（不写入 settings，退出弹层即还原） */
function expandForPopup(h) {
  if (!mainWin || mainWin.isDestroyed() || resizeSession) return;
  const [w, cur] = mainWin.getSize();
  if (h > 0) {
    const need = Math.max(120, Math.round(h));
    if (need > cur + 2) {
      if (popExpandHeight === 0) popExpandHeight = cur;
      applySize(w, need);
    }
  } else if (popExpandHeight > 0) {
    applySize(w, popExpandHeight);
    popExpandHeight = 0;
  }
}

/**
 * 弹层监视：主窗是非激活面板，点到窗口外面（别的应用/桌面）时收不到点击事件，
 * 因此用光标位置判断——指针持续在窗口外即视为“点到旁边”，通知渲染层收掉弹层。
 */
let popupWatch = null;

function setPopupWatch(open) {
  if (!open) { stopPopupWatch(); return; }
  if (popupWatch) return;
  popupWatch = {
    outsideSince: 0,
    timer: setInterval(() => {
      if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) { stopPopupWatch(); return; }
      const b = mainWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= b.x - 10 && p.x <= b.x + b.width + 10
        && p.y >= b.y - 10 && p.y <= b.y + b.height + 10;
      if (inside) { popupWatch.outsideSince = 0; return; }
      if (!popupWatch.outsideSince) { popupWatch.outsideSince = Date.now(); return; }
      if (Date.now() - popupWatch.outsideSince >= 800) {
        broadcast('evt:popup:close', {});
        stopPopupWatch();
      }
    }, 220),
  };
}

function stopPopupWatch() {
  if (popupWatch) { clearInterval(popupWatch.timer); popupWatch = null; }
}

function setHeight(h) {
  if (!mainWin || mainWin.isDestroyed() || resizeSession) return;
  const s = settings.get();
  const mini = s.window.form === 'mini';
  // 迷你条：高度由渲染层实测标题栏回设；完整形态：仅 autoHeight 开启时自动量高
  if (!mini && !s.appearance.autoHeight) return;
  const [width, cur] = mainWin.getSize();
  const clamped = mini
    ? Math.max(30, Math.min(120, Math.round(h)))
    : Math.max(260, Math.min(820, Math.round(h)));
  if (Math.abs(cur - clamped) > 2) {
    lastProgSize = [width, clamped];
    mainWin.setSize(width, clamped);
  }
}

/** 毛玻璃与浓度联动：浓度 ≥55% 才开（低浓度下 blur 层会盖住浓度变化） */
/** 自定义边缘缩放：应用不在前台也能用（光标追踪 + 实时 setSize） */
function startResizeSession(dir) {
  if (!mainWin || mainWin.isDestroyed() || resizeSession) return;
  const b = mainWin.getBounds();
  resizeSession = {
    dir, startX: b.x, startY: b.y, startW: b.width, startH: b.height,
  };
  const c0 = screen.getCursorScreenPoint();
  resizeSession.curX = c0.x; resizeSession.curY = c0.y;
  resizeSession.timer = setInterval(() => {
    if (!mainWin || mainWin.isDestroyed()) { stopResizeSession(); return; }
    const p = screen.getCursorScreenPoint();
    let width = resizeSession.startW;
    let height = resizeSession.startH;
    if (resizeSession.dir.includes('e')) width = Math.max(210, Math.min(1200, resizeSession.startW + (p.x - resizeSession.curX)));
    if (resizeSession.dir.includes('s')) height = Math.max(220, Math.min(940, resizeSession.startH + (p.y - resizeSession.curY)));
    mainWin.setSize(width, height);
    lastProgSize = [width, height];
  }, 16);
}

function stopResizeSession() {
  if (!resizeSession) return;
  clearInterval(resizeSession.timer);
  resizeSession = null;
  if (settings && (settings.get().appearance.autoHeight || settings.get().appearance.autoWidth)) {
    settings.set({ appearance: { autoHeight: false, autoWidth: false } });
    broadcast('evt:settings', settings.get());
  }
  if (mainWin && !mainWin.isDestroyed()) lastProgSize = mainWin.getSize();
}

function setWidth(w) {
  if (!mainWin || mainWin.isDestroyed() || resizeSession) return;
  const s = settings.get();
  if (!s.appearance.autoWidth || s.window.form !== 'full') return;
  const [, cur] = mainWin.getSize();
  const clamped = Math.max(210, Math.min(1200, Math.round(w)));
  if (Math.abs(cur - clamped) > 2) {
    lastProgSize = [clamped, cur];
    mainWin.setSize(clamped, cur);
  }
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
  trayMgr.setIndexTitle(st ? st.indexes : [], bossHidden, alertSignal);
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
      try {
        new Notification({ title: '行情小窗', body: '登录成功，云端自选开始同步' }).show();
      } catch (e) { /* 忽略 */ }
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
    boss: bossAction,
    showhide: toggleMainWindow,
    penetrate: () => setPenetrate(!penetrate),
    alphaUp: () => nudgeAlpha(+0.05),
    alphaDown: () => nudgeAlpha(-0.05),
    meeting: () => setMeetingMode(!meetingMode),
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
  settings.set({ appearance: { bgAlpha: next } });
  broadcast('evt:settings', settings.get());
}

let autoscrollOn = false; // 列表滚动运行态（渲染层为源头，经 app:autoscroll:set 镜像，供右键菜单显示标签）

/** 空白处右键快捷菜单：浓度/排序/形态/隐身/设置（不依赖找到眼睛按钮） */
/** 排序模式归一化（兼容旧值 pct → pct-desc） */
function normSort(m) {
  const v = m || 'default';
  return v === 'pct' ? 'pct-desc' : v;
}

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
        { label: '默认（自选顺序）', type: 'radio', checked: normSort(s.source.sortMode) === 'default', click: () => setSort('default') },
        { label: '涨幅 ↓', type: 'radio', checked: normSort(s.source.sortMode) === 'pct-desc', click: () => setSort('pct-desc') },
        { label: '跌幅 ↓', type: 'radio', checked: normSort(s.source.sortMode) === 'pct-asc', click: () => setSort('pct-asc') },
        { label: '价格 高→低', type: 'radio', checked: normSort(s.source.sortMode) === 'price-desc', click: () => setSort('price-desc') },
        { label: '价格 低→高', type: 'radio', checked: normSort(s.source.sortMode) === 'price-asc', click: () => setSort('price-asc') },
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
      label: '会议模式（隐身 + 防录屏 + 静默）', type: 'checkbox', checked: meetingMode,
      click: () => setMeetingMode(!meetingMode),
    },
    {
      label: '防录屏保护（共享/录屏/截屏不可见）', type: 'checkbox', checked: !!s.behavior.contentProtection,
      click: (it) => {
        settings.set({ behavior: { contentProtection: it.checked } });
        applyContentProtection();
      },
    },
    { type: 'separator' },
    { label: '立即隐身', click: bossAction },
    { label: '设置…', click: () => createOrShowSettingsWindow() },
  ];
  const w = mainWin;
  if (w && !w.isDestroyed()) {
    try { Menu.buildFromTemplate(tpl).popup({ window: w }); } catch (e) { /* 忽略 */ }
  }
}

/* ---------------- 冒烟模式 ---------------- */

function runSmoke() {
  let done = false;
  const finish = async (why) => {
    if (done) return;
    done = true;
    log.info('smoke finish: ' + why);
    console.log('SMOKE_FINISH(' + why + ') data=' + (orch && orch.lastUpdate ? 'yes' : 'no'));
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const img = await mainWin.webContents.capturePage();
      const out = path.join(ROOT, 'smoke-screenshot.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SMOKE_OK ' + out);
    } catch (e) {
      console.error('SMOKE_CAPTURE_FAIL ' + (e && e.message));
    }
    setTimeout(() => app.exit(0), 300);
  };
  orch.on('state', () => { if (orch.lastUpdate) finish('data'); });
  setTimeout(() => finish('timeout'), 25000);
}

/** 主窗事件集中接线（含崩溃重建后的复接） */
function wireMainWindow(win) {
  win.on('show', syncTray);
  win.on('hide', syncTray);
  // 用户拖边调整尺寸 → 自动切手动尺寸模式（关闭高度自适应，可随时在设置重开）
  win.on('resized', () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getSize();
    if (lastProgSize && Math.abs(lastProgSize[0] - w) <= 2 && Math.abs(lastProgSize[1] - h) <= 2) return;
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
  // 一次性迁移：v0.1.0 早期默认 dockIcon=false 已随旧配置持久化在磁盘上，
  // 新默认是 true（正常应用行为）。只翻转一次，之后用户可自由开关。
  if (!settings.get().behavior.dockMigrated) {
    settings.set({ behavior: { dockIcon: true, dockMigrated: true } });
    log.info('配置迁移：dockIcon 旧默认 false → 新默认 true');
  }
  // 分组默认值迁移：旧默认 all（合并 422 只）→ first（像东财默认落在自选股）
  if (!settings.get().source.activeGroupMigrated) {
    const patch = { source: { activeGroupMigrated: true } };
    if (settings.get().source.activeGroup === 'all') patch.source.activeGroup = 'first';
    settings.set(patch);
    log.info('配置迁移：activeGroup all → first');
  }
  // 脉冲迁移：旧默认 true → false（办公室红绿闪烁太显眼，静默优先；需要可在设置开）
  if (!settings.get().appearance.pulseMigrated) {
    const patch = { appearance: { pulseMigrated: true } };
    if (settings.get().appearance.pulse === true) patch.appearance.pulse = false;
    settings.set(patch);
    log.info('配置迁移：变动脉冲默认关闭（静默优先）');
  }
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
  if (!settings.get().shortcuts) {
    settings.data.shortcuts = { ...DEFAULT_SHORTCUTS };
    settings.save();
  }
  // 老配置补齐新增快捷键（会议模式 / 分组切换；新配置由 DEFAULT_SHORTCUTS 直接带上）
  const sc = settings.get().shortcuts;
  const scPatch = {};
  for (const k of ['meeting', 'groupPrev', 'groupNext']) {
    if (!sc[k]) scPatch[k] = DEFAULT_SHORTCUTS[k];
  }
  if (Object.keys(scPatch).length) {
    settings.data.shortcuts = { ...sc, ...scPatch };
    settings.save();
    log.info('配置迁移：补充新快捷键 ' + Object.keys(scPatch).join('/'));
  }
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

  orch = new Orchestrator({
    settings,
    log,
    makeFetcher: () => sessionFetcher(loginSes),
    snapshotFile: path.join(userData, 'snapshot.json'),
  });
  toast.init({ settings, log, showMainWindow });
  orch.on('state', (st) => {
    broadcast('evt:state', st);
    updateTrayTitle();
  });
  orch.on('login', (ok) => {
    broadcast('evt:login', ok);
    syncTray();
  });
  orch.on('api-changed', () => {
    broadcast('evt:notice', { text: '云端自选接口疑似变更，已切换手动模式兜底' });
  });
  // 摸鱼核心：异动找你，不用盯。
  // 分发优先级：窗口可见 → 小窗内黄条（零暴露）→ 隐身/会议 → 静默累积 → 否则按提醒方式分发。
  orch.on('alert', (a) => {
    try {
      const s = settings.get();
      setAlertSignal(a.pct > 0 ? 1 : -1); // 菜单栏 ▲/▼ 信号任何模式都更新（menubar 风格的出口）
      const winVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
      if (winVisible) {
        // 窗口开着：黄条提示即可，弹系统通知反而多余且显眼
        broadcast('evt:notice', {
          text: `${a.name} ${a.pct > 0 ? '+' : ''}${a.pct.toFixed(2)}% · 越过 ±${s.alerts.threshold}% 阈值`,
          ms: 5000,
        });
        return;
      }
      if (alertsPaused()) { pushMissed(a); return; } // 隐身/会议：静默累积，唤回后展示
      const style = (s.alerts && s.alerts.style) || 'banner';
      if (style === 'silent' || style === 'menubar') return; // 只靠信号/黄条，不弹横幅
      const lowKey = !!s.alerts.lowKey;
      const n = new Notification(lowKey
        ? {
            title: '行情提醒',
            body: `有自选越过 ±${s.alerts.threshold}% 阈值 · 点击查看`, // 不出现股票名与价格
          }
        : {
            title: `${a.name} ${a.pct > 0 ? '+' : ''}${a.pct.toFixed(2)}%`,
            body: `现价 ${a.price != null ? a.price.toFixed(2) : '—'} · 越过 ±${s.alerts.threshold}% 阈值 · 点击查看`,
          });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (e) { log.warn('异动提醒失败: ' + e.message); }
  });
  // 个股股价提醒（列表右键 → 股价提醒）：用户预设的到价通知，持续有效；隐身/会议期间静默累积。
  // 到价用屏上弹窗（屏幕底部居中、可拖动记忆位置、不夺焦点），不用右上角系统通知。
  orch.on('pricealert', (a) => {
    try {
      const dir = a.op === 'lte' ? '≤' : '≥';
      const text = `${a.name} 现价 ${a.price.toFixed(2)} · 已${a.op === 'lte' ? '跌' : '涨'}到 ${dir} ${a.target.toFixed(2)}`;
      setAlertSignal(a.op === 'lte' ? -1 : 1);
      const winVisible = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
      if (winVisible) broadcast('evt:notice', { text: text + ' · 提醒已生效', ms: 6000 });
      if (alertsPaused()) { pushMissedText(text); return; }
      toast.showAlertToast({
        title: `股价提醒 · ${a.name}`,
        body: `现价 ${a.price.toFixed(2)}，已${a.op === 'lte' ? '跌到' : '涨到'} ${a.target.toFixed(2)}`,
        accent: a.op === 'lte' ? fallColor() : riseColor(),
      });
    } catch (e) { log.warn('股价提醒通知失败: ' + e.message); }
  });
  // orchestrator 自己改了设置（如命中后移除规则）→ 同步给两个窗口
  orch.on('settings-changed', () => broadcast('evt:settings', settings.get()));
  orch.on('summary', (s) => {
    try {
      if (alertsPaused()) {
        // 隐身/会议中战报也静默：文本累积，唤回时随异动一起展示
        pushMissedText(`收盘战报：平均 ${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}% 涨${s.up} 跌${s.dn}`);
        return;
      }
      const n = new Notification({
        title: `收盘 · 自选战报（${s.count} 只）`,
        body: `平均 ${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}% · 涨${s.up} 跌${s.dn} 平${s.flat}\n领涨 ${s.top.name} ${s.top.pct > 0 ? '+' : ''}${s.top.pct.toFixed(2)}% · 领跌 ${s.bot.name} ${s.bot.pct.toFixed(2)}%`,
      });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (e) { log.warn('战报通知失败: ' + e.message); }
  });

  // 隐身态冷启动：上次完全隐身后退出 → 本次启动保持隐身（不弹窗），菜单栏快捷键唤回。
  const startHidden = !!settings.get().window.startHidden && !!settings.get().onboarded;
  if (startHidden) bossHidden = true;
  const mainWinOpts = SMOKE ? { query: { smoke: '1' } } : undefined;
  mainWin = createMainWindow(settings, log, { ...mainWinOpts, startHidden });
  wireMainWindow(mainWin);
  applyContentProtection(); // 恢复用户设置的防录屏状态（新窗口默认关闭）
  // 窗口失焦（若面板可激活）也收掉弹层；光标监视是兼底手段
  mainWin.on('blur', () => { stopPopupWatch(); broadcast('evt:popup:close', {}); });
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程崩溃: ' + details.reason + '，自动重建');
    const bounds = mainWin ? mainWin.getBounds() : null;
    // 隐身/退后台中崩溃 → 重建后保持隐藏（自动弹出等于暴露）；会议模式中同理
    const startHidden = !(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
    if (mainWin && !mainWin.isDestroyed()) mainWin.destroy();
    mainWin = createMainWindow(settings, log, { ...(SMOKE ? { query: { smoke: '1' } } : {}), startHidden });
    if (bounds) { try { mainWin.setBounds(bounds); } catch (e) { /* 忽略 */ } }
    wireMainWindow(mainWin);
    applyContentProtection();
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
    setHeight,
    setWidth,
    expandForPopup,
    setPopupWatch,
    startResizeSession,
    stopResizeSession,
    openExternalUrl,
    setStar,
    removeStock,
    togglePenetrate: () => setPenetrate(!penetrate),
    bossAction,
    toggleMeeting: () => setMeetingMode(!meetingMode),
    applyLoginItem,
    hideToBackground,
    setDockIcon,
    applyContentProtection,
    bgContextMenu,
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
    trayMgr.destroy();
  });

  if (SMOKE) runSmoke();
}
