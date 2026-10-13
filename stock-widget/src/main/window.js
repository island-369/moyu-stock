'use strict';
/**
 * 窗口管理：主窗（透明分离/置顶/穿透/位置记忆）+ 设置窗。
 */
const { BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../shared/constants');

const PRELOAD = path.join(ROOT, 'src/main/preload.js');

/** 校验记忆的位置是否还落在某个屏幕内（防接/拔显示器后跑丢） */
function validBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    // 四边都须在屏幕内（含 60px 容差）—— 只查左上角会让右半截窗口整个伸出屏外，数据列全部不可见
    return bounds.x >= a.x - 60 && bounds.y >= a.y - 60 &&
      bounds.x + (bounds.width || 360) <= a.x + a.width + 60 &&
      bounds.y + (bounds.height || 520) <= a.y + a.height + 60;
  });
  if (!visible) return null;
  return {
    ...bounds,
    width: Math.max(210, Math.min(bounds.width || 360, 1200)),
    height: Math.max(92, Math.min(bounds.height || 520, 940)),
  };
}

function createMainWindow(settings, log, options = {}) {
  const s = settings.get();
  const remembered = validBounds(s.window.bounds);
  const opts = {
    width: (remembered && remembered.width) || 360,
    height: (remembered && remembered.height) || 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    minWidth: 210,
    minHeight: 220,
    show: false,
    // 窗口非 key 时，macOS 会把“第一次点击”吞掉用于激活窗口——
    // 摸鱼场景下常在别的应用与小窗之间切换，会导致“点旁边没反应，再点一次才生效”
    acceptFirstMouse: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  // macOS：非激活面板——应用不在前台时也能直接拖边缩放/点击交互，且不抢工作应用焦点
  if (process.platform === 'darwin') opts.type = 'panel';
  if (remembered) {
    opts.x = remembered.x; opts.y = remembered.y;
    // 宽度钳制：历史遗留的过窄尺寸不再复现（数据列会被挤没）
    opts.width = Math.max(210, remembered.width || 360);
    opts.height = Math.max(92, remembered.height || 520);
  } else if (s.window.bounds) {
    // 记忆位置已失效（如拔掉外接屏后残留坐标超出内屏）→ 放回内屏右上角，完整可见
    const a = screen.getPrimaryDisplay().workArea;
    opts.width = Math.min(360, a.width - 40);
    opts.height = 520;
    opts.x = a.x + a.width - opts.width - 12;
    opts.y = a.y + 40;
  }
  // 毛玻璃与浓度耦合：浓度 <55% 时不开毛玻璃，否则 blur 层会盖住浓度变化、拖滑杆看着没反应
  if (s.appearance.vibrancy && s.appearance.bgAlpha >= 0.55) opts.vibrancy = 'under-window';

  const win = new BrowserWindow(opts);
  win.setAlwaysOnTop(true, 'screen-saver');
  if (log) log.info('主窗实际位置: ' + JSON.stringify(win.getBounds()) + ' 记忆=' + JSON.stringify(s.window.bounds) + ' remembered=' + JSON.stringify(remembered));
  // 摸鱼关键：全屏应用（独立 Space）之上也要可见（v1 方案承诺，此前遗漏）
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) { /* 旧系统无此选项 */ }

  const html = path.join(ROOT, 'src/renderer/index.html');
  // 时间戳破坏缓存：迭代期防止 Chromium 磁盘缓存旧 CSS/JS（file:// 也可能命中缓存）
  const q = Object.assign({}, options.query || {}, { v: String(fs.statSync(html).mtimeMs) });
  win.loadFile(html, { query: q });

  // startHidden：隐身态启动/崩溃重建时不自动弹出（保持隐蔽，菜单栏快捷键唤回）
  win.once('ready-to-show', () => { if (!options.startHidden) win.show(); });

  // 位置记忆（防抖持久化）+ 贴边吸附（靠近屏幕工作区边缘 ≤14px 时磁吸，摸鱼位置永远整齐）
  const saveBounds = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    try {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      settings.data.window.bounds = { x, y, width, height };
      settings.saveSoon();
    } catch (e) { /* 忽略 */ }
  };
  const snapToEdge = () => {
    try {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const a = screen.getDisplayMatching(b).workArea;
      const T = 14;
      let nx = b.x, ny = b.y;
      if (Math.abs(b.x - a.x) <= T) nx = a.x;
      else if (Math.abs(b.x + b.width - (a.x + a.width)) <= T) nx = a.x + a.width - b.width;
      if (Math.abs(b.y - a.y) <= T) ny = a.y;
      else if (Math.abs(b.y + b.height - (a.y + a.height)) <= T) ny = a.y + a.height - b.height;
      if (nx !== b.x || ny !== b.y) win.setPosition(nx, ny); // 吸附后 setPosition 再触发 moved，但坐标已贴边，不再变化
    } catch (e) { /* 忽略 */ }
  };
  win.on('moved', () => { snapToEdge(); saveBounds(); });
  win.on('resized', saveBounds);

  // 托盘常驻应用：点关闭 = 隐藏；真正退出（app.quit 路径）时放行
  win.on('close', (e) => {
    if (!quitting && !win.isDestroyed()) { e.preventDefault(); win.hide(); }
  });

  return win;
}

let settingsWin = null;
let settingsVisHook = null;

/** 设置窗可见性回调（主进程用它通知渲染层，便于临时解除标题栏拖拽区） */
function setSettingsVisHook(fn) { settingsVisHook = fn; }
function notifySettingsVis(v) { try { if (settingsVisHook) settingsVisHook(v); } catch (e) { /* 忽略 */ } }
let quitting = false;

/** 真退出前置位：绕过「点关闭 = 隐藏」的托盘常驻逻辑（app.quit() 会先触发 before-quit） */
function setQuitting(v) { quitting = !!v; }

function getSettingsWindow() {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
}

function createOrShowSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    settingsWin._shownAt = Date.now();
    notifySettingsVis(true);
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 500,
    height: 660,
    // 标题中性化：调度中心/窗口列表里只看到「设置」，不出现应用名
    title: '设置',
    autoHideMenuBar: true,
    skipTaskbar: true, // 不进 ⌘Tab（摸鱼：少一个暴露点）
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.loadFile(path.join(ROOT, 'src/renderer/settings.html'));
  settingsWin.once('ready-to-show', () => { settingsWin._shownAt = Date.now(); settingsWin.show(); notifySettingsVis(true); });
  // 点旁边（窗口失焦）自动收起：摸鱼场景下和主窗弹层行为一致
  settingsWin.on('blur', () => {
    if (!settingsWin || settingsWin.isDestroyed() || settingsWin.isVisible() === false) return;
    if (Date.now() - (settingsWin._shownAt || 0) < 400) return; // 刚打开时不收，避免抢焦点瞬间被吞
    settingsWin.hide();
    notifySettingsVis(false);
  });
  settingsWin.on('hide', () => notifySettingsVis(false));
  settingsWin.on('closed', () => { settingsWin = null; notifySettingsVis(false); });
  return settingsWin;
}

module.exports = { createMainWindow, createOrShowSettingsWindow, getSettingsWindow, validBounds, setQuitting, setSettingsVisHook };
