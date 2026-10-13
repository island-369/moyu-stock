'use strict';
/**
 * 东方财富批量行情（主源）。端点与参数 2026-10-12 实测：
 *   ulist.np 已失效（连接被掐断）；ulist/get 必须带 pn/pz/po/np/fid，否则 rc:102。
 *   fltt=2 使 f2/f3/f4/f18 直接返回浮点；停牌股 f2 为 "-"。
 * 市场字母由调用方（列表条目）关联，本模块只按 secid 返回数据。
 */
const { EM, UA } = require('../../shared/constants');

const TIMEOUT = 6000;

function num(v) {
  if (v === '-' || v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 批量拉行情。secids 形如 ['1.600519','0.000001',...]，>50 自动分批。
 * @param {string[]} secids
 * @param {{fetchImpl?:function, timeout?:number}} opts
 * @returns {Promise<Map<string, {secid, code, name, price, prevClose, pct, chg, suspended}>>}
 */
async function fetchQuotes(secids, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const timeout = opts.timeout || TIMEOUT;
  if (!secids.length) return new Map();
  const out = new Map();
  const batches = [];
  for (let i = 0; i < secids.length; i += 50) batches.push(secids.slice(i, i + 50));

  for (const batch of batches) {
    const url = EM.quoteList + encodeURIComponent(batch.join(','));
    const res = await doFetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const diff = j && j.data && Array.isArray(j.data.diff) ? j.data.diff : null;
    if (!diff) throw new Error('bad response shape');
    for (const d of diff) {
      const code = String(d.f12);
      const secid = String(d.f13) + '.' + code;
      out.set(secid, {
        secid,
        code,
        name: d.f14 || code,
        price: num(d.f2),
        prevClose: num(d.f18),
        pct: num(d.f3),
        chg: num(d.f4),
        suspended: d.f2 === '-' || d.f2 === undefined || d.f2 === null,
      });
    }
  }
  return out;
}

module.exports = { fetchQuotes };
