'use strict';
/* 股价提醒屏上弹窗：内容渲染 + 拖动/点击上报（拖动数学与光标轮询在主进程 toast.js） */

const $ = (s) => document.querySelector(s);

if (typeof widget !== 'undefined') {
  widget.on('evt:toast:show', (p) => {
    p = p || {};
    $('#t-title').textContent = p.title || '股价提醒';
    $('#t-body').textContent = p.body || '';
    document.documentElement.style.setProperty('--accent', p.accent || '#E5C24F');
  });

  let downPt = null;
  let movedFar = false;

  // 关闭按钮：不参与拖动/点击打开
  $('#t-close').addEventListener('mousedown', (e) => e.stopPropagation());
  $('#t-close').addEventListener('click', (e) => {
    e.stopPropagation();
    widget.invoke('app:toast:cmd', { cmd: 'hide' }).catch(() => {});
  });

  document.addEventListener('mousedown', (e) => {
    downPt = { x: e.screenX, y: e.screenY };
    movedFar = false;
    widget.invoke('app:toast:cmd', { cmd: 'drag-start', sx: e.screenX, sy: e.screenY }).catch(() => {});
  });
  document.addEventListener('mousemove', (e) => {
    if (!downPt) return;
    if (Math.hypot(e.screenX - downPt.x, e.screenY - downPt.y) > 5) movedFar = true;
  });
  document.addEventListener('mouseup', () => {
    if (!downPt) return;
    widget.invoke('app:toast:cmd', { cmd: 'drag-end' }).catch(() => {});
    if (!movedFar) widget.invoke('app:toast:cmd', { cmd: 'open' }).catch(() => {});
    downPt = null;
  });
}
