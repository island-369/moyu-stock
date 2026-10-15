'use strict';
/**
 * 股价提醒屏上弹窗：无边框透明小窗，默认屏幕底部居中（Dock/任务栏上方一点）。
 * 不夺焦点（showInactive）；整卡可拖动、松手记忆位置；10 秒自动消失，点击打开主窗。
 * 置于 screen-saver 层：不会被 Dock/菜单栏等系统层盖住。
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { ROOT } = require('../shared/constants');

const W = 400, H = 96;
const BOTTOM_MARGIN = 90; // 默认位置距屏幕底边的留白（覆盖常见 Dock 高度 + 间隙）
const AUTO_HIDE_MS = 10000;

let win = null;
let hideTimer = null;
let dragTimer = null;
let drag = null;          // { sx, sy, wx, wy } 按下时的屏幕坐标与窗口位置
let deps = null;          // { settings, log, showMainWindow }

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W, height: H,
    frame: false, transparent: true, resizable: false,
    show: false, skipTaskbar: true, hasShadow: false,
    fullscreenable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(ROOT, 'src/renderer/alert.html'));
  win.on('closed', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    win = null;
  });
  return win;
}

function clampToScreen(x, y) {
  const b = screen.getPrimaryDisplay().bounds;
  return {
    x: Math.round(Math.max(b.x + 8, Math.min(x, b.x + b.width - W - 8))),
    y: Math.round(Math.max(b.y + 8, Math.min(y, b.y + b.height - H - 8))),
  };
}

/** 显示前定位：优先记忆位置（换屏后拉回屏内），否则默认底部居中 */
function place() {
  const w = ensure();
  const saved = (deps.settings.get().alerts || {}).toastPos;
  const d = screen.getPrimaryDisplay();
  let pos;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    pos = clampToScreen(saved.x, saved.y);
  } else {
    pos = {
      x: Math.round(d.workArea.x + (d.workArea.width - W) / 2),
      y: Math.round(d.bounds.y + d.bounds.height - H - BOTTOM_MARGIN),
    };
  }
  w.setPosition(pos.x, pos.y);
}

function hide() {
  try { if (win && !win.isDestroyed()) win.hide(); } catch (e) { /* 忽略 */ }
}

function stopDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  drag = null;
}

function showAlertToast({ title, body, accent } = {}) {
  if (!deps) return;
  try {
    const w = ensure();
    place();
    w.webContents.send('evt:toast:show', { title: title || '股价提醒', body: body || '', accent });
    if (!w.isVisible()) w.showInactive(); // 不夺焦点：弹窗不该抢走正在打字的窗口
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, AUTO_HIDE_MS);
  } catch (e) { if (deps.log) deps.log.warn('股价提醒弹窗失败: ' + e.message); }
}

/** 渲染层命令：拖动用主进程轮询光标实现（小窗口拖快了 mousemove 会出窗，轮询不受影响） */
function handleCommand(p = {}) {
  if (!win || win.isDestroyed()) return;
  const cmd = p.cmd;
  if (cmd === 'drag-start') {
    const [x, y] = win.getPosition();
    drag = { sx: Number(p.sx) || 0, sy: Number(p.sy) || 0, wx: x, wy: y };
    clearTimeout(hideTimer); // 拖动期间不自动消失
    stopDragTimerOnly();
    dragTimer = setInterval(() => {
      try {
        const cur = screen.getCursorScreenPoint();
        const pos = clampToScreen(drag.wx + (cur.x - drag.sx), drag.wy + (cur.y - drag.sy));
        win.setPosition(pos.x, pos.y);
      } catch (e) { stopDrag(); }
    }, 16);
  } else if (cmd === 'drag-end') {
    const [x, y] = win.getPosition();
    const pos = clampToScreen(x, y);
    win.setPosition(pos.x, pos.y);
    stopDrag();
    deps.settings.set({ alerts: { toastPos: pos } }); // 松手即记忆
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, AUTO_HIDE_MS);
  } else if (cmd === 'open') {
    hide();
    if (deps.showMainWindow) deps.showMainWindow();
  } else if (cmd === 'hide') {
    hide();
  }
}

function stopDragTimerOnly() {
  clearInterval(dragTimer);
  dragTimer = null;
}

function init(d) { deps = d; }

module.exports = { init, showAlertToast, handleCommand, hide };
