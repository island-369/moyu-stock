'use strict';
/**
 * 单步拖拽 diff：旧显示序 + 新显示序 → 被拖 key 与其新邻居。
 * 用途：云端模式拖拽后推导 myfavor ss?（排序写回）的参数。
 *
 * 判定规则（保守）：
 *  - 两序元素多重集不一致 → null（云端已变，不写回）；
 *  - 完全相同 → null（原位拖放，无操作）；
 *  - 去掉被拖元素后两序仍不一致 → null（一次拖拽理应只动一个元素）；
 *  - 其余 → {key, before, after}，before/after 为新序中的上下邻居（边界为空串）。
 *
 * 注意：同一结果序列可能有多种等价描述（如相邻互换），任取一种都能让
 * ss? 得到用户拖出的最终顺序——「放到 before 与 after 之间」只看落点。
 * key 假定在视图内唯一（分组内股票天然去重）。
 */

function stripOnce(arr, m) {
  const out = [];
  let removed = false;
  for (const k of arr) {
    if (k === m && !removed) { removed = true; continue; }
    out.push(k);
  }
  return out;
}

function sameSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {string[]} oldKeys 拖拽前的显示序（dragstart 时捕获）
 * @param {string[]} newKeys 拖拽后的显示序（dragend 时从 DOM 收集）
 * @returns {{key:string, before:string, after:string}|null}
 */
function singleMove(oldKeys, newKeys) {
  if (!Array.isArray(oldKeys) || !Array.isArray(newKeys)) return null;
  const n = oldKeys.length;
  if (n === 0 || newKeys.length !== n) return null;
  if (sameSeq(oldKeys, newKeys)) return null;

  // 多重集一致性（含重复次数）
  const cnt = new Map();
  for (const k of oldKeys) cnt.set(k, (cnt.get(k) || 0) + 1);
  for (const k of newKeys) {
    const c = cnt.get(k);
    if (!c) return null;
    cnt.set(k, c - 1);
  }

  // 首个差异位：被拖元素要么是 new[i]（向前拖），要么是 old[i]（向后拖）。
  // 两种候选都试 strip 校验，任一通过即为合法单步描述。
  let i = 0;
  while (i < n && oldKeys[i] === newKeys[i]) i++;
  for (const m of [newKeys[i], oldKeys[i]]) {
    if (m === undefined || m === null) continue;
    if (sameSeq(stripOnce(oldKeys, m), stripOnce(newKeys, m))) {
      const j = newKeys.indexOf(m);
      return {
        key: m,
        before: j > 0 ? newKeys[j - 1] : '',
        after: j < n - 1 ? newKeys[j + 1] : '',
      };
    }
  }
  return null;
}

module.exports = { singleMove };
