'use strict';
/**
 * 托盘：穿透/隐身后的兜底全量入口（方案表 4-1）。
 * 模板图标（assets/ 由 tools/gen-icon.js 生成）+ 指数标题常驻。
 */
const { Tray, Menu, nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../shared/constants');

function loadIcon() {
  try {
    const p16 = path.join(ROOT, 'assets', 'tray-icon.png');
    const p32 = path.join(ROOT, 'assets', 'tray-icon@2x.png');
    if (!fs.existsSync(p16)) return null;
    const img = nativeImage.createFromPath(p16);
    if (fs.existsSync(p32)) {
      img.addRepresentation({ scaleFactor: 2.0, buffer: fs.readFileSync(p32) });
    }
    img.setTemplateImage(true);
    return img;
  } catch (e) {
    return null;
  }
}

class TrayMgr {
  constructor() {
    this.tray = null;
    this.ctx = null;
  }

  init(ctx, log) {
    this.ctx = ctx;
    this.log = log || { info() {}, warn() {}, error() {} };
    const icon = loadIcon();
    try {
      this.tray = new Tray(icon || nativeImage.createEmpty());
      this.log.info('托盘已创建 icon=' + (icon ? icon.getSize().width + 'px' : 'empty'));
    } catch (e) {
      this.log.error('托盘创建失败: ' + e.message);
      throw e;
    }
    this.tray.setToolTip('行情小窗');
    this.rebuild();
    this.tray.on('click', () => ctx.onShowHide());
    return this.tray;
  }

  rebuild() {
    if (!this.tray || !this.ctx) return;
    const c = this.ctx;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: c.isVisible ? '隐藏小窗（退到后台）' : '显示小窗', click: c.onShowHide },
      { type: 'separator' },
      {
        label: '鼠标穿透', type: 'checkbox', checked: c.penetrate,
        click: (item) => c.onPenetrate(item.checked),
      },
      {
        label: '形态',
        submenu: [
          { label: '完整', type: 'radio', checked: c.form === 'full', click: () => c.onForm('full') },
          { label: '迷你条', type: 'radio', checked: c.form === 'mini', click: () => c.onForm('mini') },
        ],
      },
      {
        label: '在 Dock 显示图标（像普通应用）', type: 'checkbox', checked: c.dock,
        click: (item) => c.onDock(item.checked),
      },
      { type: 'separator' },
      {
        label: '会议模式（隐身 + 防录屏 + 静默）', type: 'checkbox', checked: !!c.meeting,
        click: (item) => c.onMeeting(item.checked),
      },
      {
        label: '防录屏保护（截屏/共享/录屏不可见）', type: 'checkbox', checked: !!c.contentProt,
        click: (item) => c.onContentProt(item.checked),
      },
      { label: '刷新自选', click: c.onRefresh },
      { label: '设置…', click: c.onSettings },
      { type: 'separator' },
      { label: c.loggedIn ? '重新扫码登录' : '扫码登录（云端自选）', click: c.onLogin },
      { label: '退出登录', click: c.onLogout },
      { type: 'separator' },
      { label: '退出行情小窗', click: () => app.quit() },
    ]));
  }

  /** 指数标题：紧凑格式（菜单栏拥挤时更容得下）；tooltip 保留完整精度。
   *  hide=true 完全隐匿（title/tooltip 一起清，共享屏幕时菜单栏也不暴露）；
   *  signal: 1=有向上异动 ▲ / -1=有向下异动 ▼（菜单栏信号提醒，最低调） */
  setIndexTitle(indexes, hide, signal) {
    if (!this.tray) return;
    const sh = (indexes || []).find((i) => i.secid === '1.000001');
    if (hide || !sh || sh.price == null) {
      this.tray.setTitle('');
      this.tray.setToolTip('行情小窗');
      return;
    }
    const sign = (sh.pct || 0) >= 0 ? '+' : '';
    const sig = signal === 1 ? ' ▲' : signal === -1 ? ' ▼' : '';
    const title = `沪${sh.price.toFixed(0)} ${sign}${(sh.pct || 0).toFixed(1)}%${sig}`;
    try {
      this.tray.setTitle(title);
      if (!this._titleLogged) {
        this.log.info('菜单栏标题已设置: ' + title);
        this._titleLogged = true;
      }
    } catch (e) {
      this.log.error('菜单栏标题设置失败: ' + e.message);
    }
    this.tray.setToolTip(`行情小窗 · 上证 ${sh.price.toFixed(2)} ${sign}${(sh.pct || 0).toFixed(2)}%`);
  }

  destroy() {
    if (this.tray) { this.tray.destroy(); this.tray = null; }
  }
}

module.exports = { TrayMgr };
