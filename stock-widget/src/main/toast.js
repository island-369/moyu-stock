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
const DEFAULT_MS = 10000;

/** 显示时长（可设置）：alerts.toastMs。0=不自动消失（点 × 关）；异常值回退默认 10s */
function autoHideMs() {
  let v = DEFAULT_MS;
  try { v = Number((deps.settings.get().alerts || {}).toastMs); } catch (e) { /* 忽略 */ }
  if (!Number.isFinite(v)) return DEFAULT_MS;
  if (v === 0) return 0;
  return Math.max(1000, Math.min(v, 3600000)); // 钳到 1s–1h，防手改配置写进离谱值
}

let win = null;
let hideTimer = null;
let dragTimer = null;
let drag = null;          // { sx, sy, wx, wy } 按下时的屏幕坐标与窗口位置
let deps = null;          // { settings, log, showMainWindow }
let pageReady = false;    // alert.html 是否加载完成（未完成时 webContents.send 会丢消息）
let pendingShow = null;   // 加载完成前积压的显示内容（冷启动第一声预警）

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W, height: H,
    frame: false, transparent: true, resizable: false,
    show: false, skipTaskbar: true, hasShadow: false,
    fullscreenable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(ROOT, 'src/renderer/alert.html'));
  // 冷启动竞态（2026-10 实测确认）：窗口惰性创建，loadFile 未完成时 send 会被丢弃，
  // 第一声预警曾显示成静态占位（正文「—」、提示写死「10 秒后自动消失」，与设置的时长文案不符）。
  // 改为加载完成后补发积压内容。
  win.webContents.once('did-finish-load', () => {
    pageReady = true;
    if (pendingShow && win && !win.isDestroyed()) {
      try { win.webContents.send('evt:toast:show', pendingShow); } catch (e) { /* 窗口刚关 */ }
    }
    pendingShow = null;
  });
  win.on('closed', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    pageReady = false;
    win = null;
  });
  return win;
}

function clampToScreen(x, y) {
  // 多屏（2026-10 审查 A7）：按目标点所在屏钳制，不再强制拉回主屏
  const d = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: W, height: H });
  const b = d.bounds;
  return {
    x: Math.round(Math.max(b.x + 8, Math.min(x, b.x + b.width - W - 8))),
    y: Math.round(Math.max(b.y + 8, Math.min(y, b.y + b.height - H - 8))),
  };
}

/** 显示前定位：优先记忆位置（换屏后拉回屏内），否则默认底部居中 */
function place() {
  const w = ensure();
  const saved = (deps.settings.get().alerts || {}).toastPos;
  let pos;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    pos = clampToScreen(saved.x, saved.y);
  } else {
    // 默认底部居中：跟随光标所在屏（外接屏办公时不再跑到主屏）
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
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
    const ms = autoHideMs();
    const payload = {
      title: title || '股价提醒', body: body || '', accent,
      secs: ms > 0 ? Math.round(ms / 1000) : 0, // 提示行用：0 = 不自动消失
    };
    if (pageReady) w.webContents.send('evt:toast:show', payload);
    else pendingShow = payload; // 页面未就绪：先积压，did-finish-load 后补发
    if (!w.isVisible()) w.showInactive(); // 不夺焦点：弹窗不该抢走正在打字的窗口
    clearTimeout(hideTimer);
    if (ms > 0) hideTimer = setTimeout(hide, ms);
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
    deps.settings.setSoon({ alerts: { toastPos: pos } }); // 松手即记忆（防抖落盘，D12）
    clearTimeout(hideTimer);
    const ms = autoHideMs();
    if (ms > 0) hideTimer = setTimeout(hide, ms); // 0=不自动消失：拖完也留着，等 × / 点击关闭
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
