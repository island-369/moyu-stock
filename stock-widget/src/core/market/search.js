'use strict';
/**
 * 股票搜索（东财搜索建议，网页版搜索框同源）。2026-10-12 实测：
 *   返回 QuotationCodeTable.Data[]：Code/Name/MktNum/QuoteID/Classify/SecurityTypeName。
 *   QuoteID 即 secid（如 "1.600519"），直接可用。
 */
const { EM, UA } = require('../../shared/constants');

const TIMEOUT = 6000;
const MARKET_NAME = { SH: '沪', SZ: '深', BJ: '北', HK: '港', US: '美' };

function mktNumToMarket(n) {
  return { 1: 'SH', 0: 'SZ', 116: 'HK', 105: 'US', 106: 'US', 107: 'US' }[Number(n)] || null;
}

/**
 * @param {string} q 关键词（中文名 / 拼音 / 代码 / 英文 ticker）
 * @returns {Promise<Array<{market,code,name,secid,tag}>>}
 */
async function search(q, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const kw = String(q || '').trim();
  if (!kw) return [];
  const url = EM.search + encodeURIComponent(kw);
  const res = await doFetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const rows = (j && j.QuotationCodeTable && Array.isArray(j.QuotationCodeTable.Data))
    ? j.QuotationCodeTable.Data : [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.Code || !r.Name) continue;
    let market = mktNumToMarket(r.MktNum);
    // MktNum=0 时北交所会被误判为深：按号段修正（4/8/92 开头为北交所）
    if (market === 'SZ' && /^(4|8|92)/.test(String(r.Code))) market = 'BJ';
    const secid = r.QuoteID || (r.MktNum + '.' + r.Code);
    out.push({
      market: market || '??',
      code: String(r.Code),
      name: r.Name,
      secid,
      tag: MARKET_NAME[market] || String(r.SecurityTypeName || '').slice(0, 2),
    });
  }
  return out;
}

module.exports = { search };
