'use strict';
/**
 * 隐蔽状态机（从 index.js 拆出，D1）：老板键 / 会议模式 / 提醒静默累积 /
 * 菜单栏异动信号 / 防录屏 / Dock 隐身联动。相关可变状态全部收拢于此，
 * index.js 只持有实例做接线（此前 6 个模块级状态散在入口文件里）。
 */
const { app } = require('electron');

function createStealth(deps) {
  const {
    getMainWin, getAuxWindows, hideAuxWindows, settings, tray, log, broadcast,
    sizing, syncTray, showMainWindow, setDockIcon, updateTrayTitle,
  } = deps;

  let bossHidden = false;
  let meetingMode = false; // 会议模式：隐身 + 防录屏 + 提醒静默（⌥⇧M 一键切换，散会原样恢复）
  let preMeeting = null;   // 进会议前的窗口可见性（退出时恢复）
  let missedAlerts = [];   // 隐身/会议期间静默累积的提醒 [{key?, text}]，唤回时一次性展示
  let alertSignal = 0;     // 菜单栏异动信号：0 无 / ±1 个股 ▲▼ / ±2 大盘 ▲▲▼▼
  let dockHiddenByStealth = false; // 隐身/会议临时藏的 Dock（与用户设置的 dockIcon 区分，P0-1）

  const mainWin = () => {
    const w = getMainWin();
    return w && !w.isDestroyed() ? w : null;
  };

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
    for (const w of [getMainWin(), ...getAuxWindows()]) {
      if (w && !w.isDestroyed()) {
        try { w.setContentProtection(on); } catch (e) { /* 旧系统无此 API */ }
      }
    }
  }

  /** 隐身联动 Dock/⌘Tab（P0-1）：老板键/会议模式进入隐身时，临时藏掉 Dock 图标
   *  （⌘Tab 里也不再出现「行情小窗」）；唤回时按用户设置恢复。
   *  dockHiddenByStealth 区分「用户设置关的」与「隐身临时关的」，避免退出隐身时误开。 */
  function stealthDock(on) {
    try {
      if (on) {
        if (!dockHiddenByStealth && settings && settings.get().behavior.dockIcon) {
          app.dock.hide();
          dockHiddenByStealth = true;
          log.info('隐身联动：Dock 图标已临时隐藏（⌘Tab 不再可见）');
        }
      } else if (dockHiddenByStealth) {
        dockHiddenByStealth = false;
        if (settings && settings.get().behavior.dockIcon) setDockIcon(true); // 复用无条件 show 自愈
        log.info('隐身联动：Dock 图标已恢复');
      }
    } catch (e) { log.warn('dock 隐身联动失败: ' + e.message); }
  }

  function bossAction() {
    if (meetingMode) return; // 会议模式中老板键保持隐藏：把窗口翻出来反而暴露（防录屏不挡肉眼，A4）
    const w = mainWin();
    if (!w) return;
    sizing.stopPopupWatch();
    broadcast('evt:popup:close', {});
    const s = settings.get();
    if (w.isVisible()) {
      w.hide();
      hideAuxWindows();
      stealthDock(true); // ⌘Tab/Dock 里也不留「行情小窗」（E2）
      if (s.behavior.bossKeyAction === 'hide') {
        bossHidden = true;
        tray.setIndexTitle([], true); // 连菜单栏文字一起隐匿
        settings.data.window.startHidden = true; // 冷启动/崩溃重建后仍保持隐身
        settings.saveSoon();
      }
      syncTray();
    } else {
      const auxOpen = getAuxWindows().some((x) => x && !x.isDestroyed() && x.isVisible());
      if (auxOpen) {
        // 主窗已藏但设置窗/登录窗开着：继续藏辅助窗，而不是把主窗唤回
        hideAuxWindows();
        syncTray();
      } else {
        showMainWindow();
      }
    }
  }

  /** 会议模式：一键隐身 + 防录屏 + 提醒静默（含菜单栏文字清空）；散会再按一次原样恢复。
   *  与老板键的区别：菜单栏必清（共享屏幕连菜单栏一起被录）、窗口防录屏、退出恢复原状。 */
  function setMeetingMode(on) {
    if (on === meetingMode) return;
    meetingMode = !!on;
    if (meetingMode) {
      const w0 = mainWin();
      preMeeting = { wasVisible: !!w0 && w0.isVisible() };
      sizing.stopPopupWatch();
      broadcast('evt:popup:close', {});
      if (w0) w0.hide();
      hideAuxWindows();
      bossHidden = true; // 复用隐身语义：updateTrayTitle 清空菜单栏 + 提醒暂停
      stealthDock(true); // 共享屏幕连 Dock/⌘Tab 一起藏（P0-1）
      applyContentProtection();
      log.info('会议模式开启：隐身 + 防录屏 + 提醒静默');
    } else {
      const wasVisible = preMeeting ? preMeeting.wasVisible : true;
      bossHidden = false;
      preMeeting = null;
      stealthDock(false);
      applyContentProtection();
      updateTrayTitle();
      log.info('会议模式关闭');
      if (wasVisible) showMainWindow(); // 散会恢复进会前状态（showMainWindow 顺带 flush 错过提醒）
    }
    broadcast('evt:meeting', meetingMode); // 渲染层眼睛面板按钮状态
    syncTray();
  }

  return {
    bossAction, setMeetingMode, alertsPaused, pushMissed, pushMissedText,
    flushMissedAlerts, setAlertSignal, applyContentProtection, stealthDock,
    isBossHidden: () => bossHidden,
    isMeeting: () => meetingMode,
    isDockHidden: () => dockHiddenByStealth,
    getAlertSignal: () => alertSignal,
    /** 隐身态冷启动恢复（index.js main() 用）：上次完全隐身后退出 → 本次启动保持隐身 */
    setBossHidden: (v) => { bossHidden = !!v; },
  };
}

module.exports = { createStealth };
