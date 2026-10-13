'use strict';
/**
 * 腾讯行情备源（qt.gtimg.cn）。2026-10-12 实测：
 *   GBK 编码；~ 分隔；3=现价 4=昨收 31=涨跌 32=涨跌幅；现价 0 视为停牌。
 * 备源仅覆盖 A 股/指数/ETF/港股；美股缺交易所后缀，跳过。
 */
const { TX, UA } = require('../../shared/constants');

const TIMEOUT = 6000;

function toTencentSymbol(secid) {
  const [num, code] = secid.split('.');
  switch (num) {
    case '1': return 'sh' + code;
    case '0': return 'sz' + code;
    case '116': return 'hk' + code;
    default: return null; // 美股等无稳定映射，备源跳过
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string[]} secids
 * @returns {Promise<Map<string, quote>>}
 */
async function fetchQuotes(secids, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const timeout = opts.timeout || TIMEOUT;
  const want = new Map();
  const symbols = [];
  for (const secid of secids) {
    const sym = toTencentSymbol(secid);
    if (sym) { symbols.push(sym); want.set(sym, secid); }
  }
  if (!symbols.length) return new Map();

  const out = new Map();
  // 每批 30 个
  for (let i = 0; i < symbols.length; i += 30) {
    const batch = symbols.slice(i, i + 30);
    const res = await doFetch(TX.quote + batch.join(','), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const re = /v_([A-Za-z0-9]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const sym = m[1];
      const secid = want.get(sym);
      if (!secid) continue;
      const f = m[2].split('~');
      if (f.length < 33) continue;
      const price = num(f[3]);
      const prevClose = num(f[4]);
      out.set(secid, {
        secid,
        market: secid.split('.')[0] === '1' ? 'SH' : secid.split('.')[0] === '116' ? 'HK' : 'SZ',
        marketNum: secid.split('.')[0],
        code: f[2],
        name: f[1] || f[2],
        price,
        prevClose,
        pct: num(f[32]),
        chg: num(f[31]),
        suspended: price === null || price === 0,
      });
    }
  }
  return out;
}

module.exports = { fetchQuotes, toTencentSymbol };
