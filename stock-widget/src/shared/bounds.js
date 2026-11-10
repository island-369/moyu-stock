'use strict';
/**
 * 记忆窗口位置校验（纯函数、零依赖，可单测）。
 * 从 window.js 抽出：原来直接依赖 Electron 的 screen，测不了多显示器容差。
 * 四边都须落在某个显示器工作区内（含 60px 容差）——只查左上角会让
 * 右半截窗口整个伸出屏外，数据列全部不可见。
 */

/** @returns {null|{x,y,width,height}} 无效返回 null；有效时顺带钳制宽高到允许区间 */
function validBounds(bounds, displays) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  const visible = (displays || []).some((d) => {
    const a = d.workArea || d;
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

module.exports = { validBounds };
