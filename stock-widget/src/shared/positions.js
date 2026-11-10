'use strict';
/**
 * 本地持仓纯逻辑（主进程用，可单测）：
 *  - upsertPosition：同 (m,c) 整体替换（成本/数量来自表单，空 = null）；未带的 secid 保留旧值
 *  - positionDefaults：编辑弹窗的回填值
 * 与设置窗批量导入（app:positions:import，逐行整体替换）语义一致。
 * 注意：单条加入/编辑不自动切换分组视图（右键加入时用户正看着别的分组，硬切突兀）。
 */

/** upsert：新条目追加到尾部；已有则整体替换（secid 未提供时保留旧值） */
function upsertPosition(list, entry) {
  const cur = Array.isArray(list) ? list.filter(Boolean) : [];
  const idx = cur.findIndex((e) => e.m === entry.m && e.c === entry.c);
  if (idx < 0) return [...cur, entry];
  const next = [...cur];
  const merged = { ...entry };
  if (merged.s == null && cur[idx].s != null) merged.s = cur[idx].s;
  next[idx] = merged;
  return next;
}

/** 表单回填值：{cost, qty}（null = 未设，渲染层转空字符串） */
function positionDefaults(list, m, c) {
  const e = (Array.isArray(list) ? list : []).find((x) => x && x.m === m && x.c === c);
  return {
    cost: e && e.cost != null ? e.cost : null,
    qty: e && e.qty != null ? e.qty : null,
  };
}

module.exports = { upsertPosition, positionDefaults };
