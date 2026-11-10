'use strict';
/**
 * 主窗尺寸与会话（从 index.js 拆出，D1）：
 *  - 程序化尺寸（autoHeight/autoWidth 量测回设）与「用户手动拖拽」的区分（lastProgSize）
 *  - 迷你条进出（记住/恢复完整形态尺寸）
 *  - 弹层临时撑高 + 弹层监视（光标在窗外 800ms 即收弹层）
 *  - 自定义边缘缩放会话（免激活拖边，光标追踪 + 实时 setSize）
 * 状态全部收拢在本闭包内，index.js 只持有实例做接线。
 */
const { screen } = require('electron');

function createSizing({ getMainWin, settings, broadcast }) {
  let lastProgSize = null;  // 最近一次程序化设置的窗口尺寸（用于区分用户手动拖拽）
  let preMiniSize = null;   // 进入迷你条前的窗口尺寸（退出时恢复）
  let popExpandHeight = 0;  // 弹层临时撑高前的窗口高度（0 = 未撑高）
  let resizeSession = null; // 自定义边缘缩放会话（光标追踪）
  let popupWatch = null;    // 弹层监视（光标在窗外 → 收弹层）

  const win = () => {
    const w = getMainWin();
    return w && !w.isDestroyed() ? w : null;
  };

  /** 程序化设置尺寸（记录 lastProgSize，避免被当作手动拖拽写进 bounds） */
  function applySize(width, height) {
    const w = win();
    if (!w) return;
    const [cw, cur] = w.getSize();
    const h = Math.round(height);
    if (cw === Math.round(width) && Math.abs(cur - h) <= 1) return;
    lastProgSize = [Math.round(width), h];
    w.setSize(Math.round(width), h);
  }

  /** 弹层临时撑高：h>0 需要的高度；h=0 恢复（不写入 settings，退出弹层即还原） */
  function expandForPopup(h) {
    const w = win();
    if (!w || resizeSession) return;
    const [cw, cur] = w.getSize();
    if (h > 0) {
      const need = Math.max(120, Math.round(h));
      if (need > cur + 2) {
        if (popExpandHeight === 0) popExpandHeight = cur;
        applySize(cw, need);
      }
    } else if (popExpandHeight > 0) {
      applySize(cw, popExpandHeight);
      popExpandHeight = 0;
    }
  }

  function stopPopupWatch() {
    if (popupWatch) { clearInterval(popupWatch.timer); popupWatch = null; }
  }

  /**
   * 弹层监视：主窗是非激活面板，点到窗口外面（别的应用/桌面）时收不到点击事件，
   * 因此用光标位置判断——指针持续在窗口外即视为“点到旁边”，通知渲染层收掉弹层。
   * 窗口是焦点时不收（2026-10 修复）：用户正在弹层输入框里打字时，光标常停在窗外
   * （点完输入框手移回键盘、触控板被手掌砸到），只看光标会把填到一半的表单收掉；
   * 真正点到别处时窗口必然失焦，由 index.js 的 blur 兜底关闭。
   */
  function setPopupWatch(open) {
    if (!open) { stopPopupWatch(); return; }
    if (popupWatch) return;
    popupWatch = {
      outsideSince: 0,
      timer: setInterval(() => {
        const w = win();
        if (!w || !w.isVisible()) { stopPopupWatch(); return; }
        const b = w.getBounds();
        const p = screen.getCursorScreenPoint();
        const inside = p.x >= b.x - 10 && p.x <= b.x + b.width + 10
          && p.y >= b.y - 10 && p.y <= b.y + b.height + 10;
        if (inside || w.isFocused()) { popupWatch.outsideSince = 0; return; }
        if (!popupWatch.outsideSince) { popupWatch.outsideSince = Date.now(); return; }
        if (Date.now() - popupWatch.outsideSince >= 800) {
          broadcast('evt:popup:close', {});
          stopPopupWatch();
        }
      }, 220),
    };
  }

  /** 高度自适应回设：迷你条按实测标题栏；完整形态仅 autoHeight 开启时生效 */
  function setHeight(h) {
    const w = win();
    if (!w || resizeSession) return;
    const s = settings.get();
    const mini = s.window.form === 'mini';
    if (!mini && !s.appearance.autoHeight) return;
    const [width, cur] = w.getSize();
    const clamped = mini
      ? Math.max(30, Math.min(120, Math.round(h)))
      : Math.max(260, Math.min(820, Math.round(h)));
    if (Math.abs(cur - clamped) > 2) {
      lastProgSize = [width, clamped];
      w.setSize(width, clamped);
    }
  }

  /** 宽度自适应回设：仅完整形态且 autoWidth 开启时生效 */
  function setWidth(wv) {
    const w = win();
    if (!w || resizeSession) return;
    const s = settings.get();
    if (!s.appearance.autoWidth || s.window.form !== 'full') return;
    const [, cur] = w.getSize();
    const clamped = Math.max(210, Math.min(1200, Math.round(wv)));
    if (Math.abs(cur - clamped) > 2) {
      lastProgSize = [clamped, cur];
      w.setSize(clamped, cur);
    }
  }

  /** 自定义边缘缩放：应用不在前台也能用（光标追踪 + 实时 setSize） */
  function startResizeSession(dir) {
    const w = win();
    if (!w || resizeSession) return;
    const b = w.getBounds();
    resizeSession = {
      dir, startX: b.x, startY: b.y, startW: b.width, startH: b.height,
    };
    const c0 = screen.getCursorScreenPoint();
    resizeSession.curX = c0.x; resizeSession.curY = c0.y;
    resizeSession.timer = setInterval(() => {
      const cw = win();
      if (!cw) { stopResizeSession(); return; }
      const p = screen.getCursorScreenPoint();
      let width = resizeSession.startW;
      let height = resizeSession.startH;
      if (resizeSession.dir.includes('e')) width = Math.max(210, Math.min(1200, resizeSession.startW + (p.x - resizeSession.curX)));
      if (resizeSession.dir.includes('s')) height = Math.max(220, Math.min(940, resizeSession.startH + (p.y - resizeSession.curY)));
      cw.setSize(width, height);
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
    const w = win();
    if (w) lastProgSize = w.getSize();
  }

  /* ---- 迷你条进出（尺寸记忆由本模块保管，setForm 调用） ---- */

  /** 进入迷你条：记住当前完整形态尺寸；返回保守高度（渲染层量测标题栏后回设精确值） */
  function beginMini(width, height) {
    if (!preMiniSize) preMiniSize = [width, height];
    popExpandHeight = 0;
    return 40;
  }

  /** 退出迷你条：应恢复的高度（无记忆或记忆过矮时兜底） */
  function endMiniTarget(height) {
    const target = preMiniSize && preMiniSize[1] >= 120 ? preMiniSize[1] : Math.max(260, height);
    preMiniSize = null;
    return target;
  }

  /* ---- 查询 / 崩溃重建复位 ---- */

  function isResizing() { return !!resizeSession; }

  /** 该尺寸是否本模块刚程序化设置的（是 → 不当作用户手动拖拽） */
  function isProgSize(w, h) {
    return !!lastProgSize && Math.abs(lastProgSize[0] - w) <= 2 && Math.abs(lastProgSize[1] - h) <= 2;
  }

  /** 渲染进程崩溃重建后调用：清掉指向旧窗口的会话/监视与临时撑高状态 */
  function resetForRebuild() {
    stopPopupWatch();
    if (resizeSession) { clearInterval(resizeSession.timer); resizeSession = null; } // 直接清计时器，不触发「手动尺寸」副作用
    popExpandHeight = 0;
    const w = win();
    if (w) lastProgSize = w.getSize();
  }

  return {
    applySize, expandForPopup, setHeight, setWidth,
    setPopupWatch, stopPopupWatch, startResizeSession, stopResizeSession,
    beginMini, endMiniTarget, isResizing, isProgSize, resetForRebuild,
  };
}

module.exports = { createSizing };
