'use strict';
/**
 * 个股预警纯逻辑（主进程用，可单测）：
 *  - alertFormDefaults：预警设置弹层打开时的表单回填值（同方向多条取最近一条）
 *  - upsertAlertRule：同方向改值即更新——同一股票同一类别同一方向只保留一条规则
 * 渲染层不直接 require（沙箱），由 ipc.js 算好随 evt:pricealert 带过去。
 */

/** 同 (m,c,op) 的一条规则（多条时取 ts 最大） */
function latestRule(list, m, c, op) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.m === m && r.c === c && r.op === op)
    .reduce((best, r) => (!best || (r.ts || 0) >= (best.ts || 0) ? r : best), null);
}

/** 表单回填：值为输入框字符串（'' = 未设）。键与渲染层 #ap-* / #sw-* 输入一一对应 */
function alertFormDefaults(alerts, m, c) {
  const a = alerts || {};
  const pxG = latestRule(a.priceRules, m, c, 'gte');
  const pxL = latestRule(a.priceRules, m, c, 'lte');
  const pcG = latestRule(a.pctRules, m, c, 'gte');
  const pcL = latestRule(a.pctRules, m, c, 'lte');
  const swG = latestRule(a.swRules, m, c, 'gte');
  const swL = latestRule(a.swRules, m, c, 'lte');
  return {
    gte: pxG ? String(pxG.price) : '',      // 到价 涨到 ≥
    lte: pxL ? String(pxL.price) : '',      // 到价 跌到 ≤
    up: pcG ? String(pcG.pct) : '',         // 异动 涨幅超过 %
    dn: pcL ? String(pcL.pct) : '',         // 异动 跌幅超过 %
    swUp: swG ? String(swG.pct) : '',       // 急涨 N 分钟内涨超 %
    swUpMins: swG ? String(swG.mins || 5) : '',
    swDn: swL ? String(swL.pct) : '',       // 急跌 N 分钟内跌超 %
    swDnMins: swL ? String(swL.mins || 5) : '',
  };
}

/** 同方向 upsert：去掉旧的同 (m,c,op) 规则后追加新规则（调用方先做同值 dup 判断） */
function upsertAlertRule(list, rule) {
  const cur = Array.isArray(list) ? list.filter(Boolean) : [];
  return [...cur.filter((r) => !(r.m === rule.m && r.c === rule.c && r.op === rule.op)), rule];
}

module.exports = { alertFormDefaults, upsertAlertRule };
