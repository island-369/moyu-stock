'use strict';
/**
 * 代码解析器：把用户各种写法统一成 { market, code, secid }。
 * 覆盖：裸代码 / SH600519 / 600519.SH / sh.600519 / secid(1.600519) /
 *       北交所 / 港股(5位) / 美股(字母，可带 .O/.N/.A 交易所后缀)
 * 纯函数，零依赖，单元测试覆盖（tests/run.js）。
 */

const MARKET_SECID = { SH: '1', SZ: '0', BJ: '0', HK: '116' };
// 美股交易所后缀 → 东财 secid 市场号
const US_EXCHANGE = { O: '105', N: '106', A: '107' };

function mk(market, code, secidMarket) {
  const sm = secidMarket || MARKET_SECID[market];
  if (!sm) return null;
  return { market, code, secid: sm + '.' + code };
}

/**
 * @param {string} raw 用户输入
 * @returns {{market:string, code:string, secid:string}|null}
 */
function parse(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s.length > 12) return null;
  let m;

  // secid 直写：1.600519 / 0.000001 / 116.00700 / 105.AAPL
  m = s.match(/^([012])\.(\d{6})$/);
  if (m) return mk(m[1] === '1' ? 'SH' : m[1] === '0' ? 'SZ' : 'BJ', m[2], m[1]);
  m = s.match(/^116\.(\d{4,5})$/);
  if (m) return mk('HK', m[1]);
  m = s.match(/^10[567]\.([A-Z.]{1,10})$/);
  if (m) return mk('US', m[1]);

  // 前缀写法：SH600519 / SH.600519 / BJ833171
  m = s.match(/^(SH|SZ|BJ)\.(\d{6})$/) || s.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (m) return mk(m[1], m[2]);
  // 后缀写法：600519.SH / 000001.SZ / 833171.BJ
  m = s.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (m) return mk(m[2], m[1]);

  // 港股：00700 / 00700.HK / HK00700
  m = s.match(/^(\d{5})\.HK$/) || s.match(/^HK(\d{4,5})$/) || s.match(/^\d{5}$/);
  if (m) return mk('HK', m[1] || m[2] || s);

  // 美股：AAPL.O / AAPL.N / AAPL.A
  m = s.match(/^([A-Z.]{1,10})\.(O|N|A)$/);
  if (m) return mk('US', m[1], US_EXCHANGE[m[2]]);
  // 美股裸 ticker：1-5 个字母（排除市场前缀本身）
  m = s.match(/^[A-Z]{1,5}$/);
  if (m && !['SH', 'SZ', 'BJ', 'HK'].includes(s)) return mk('US', s, '105');

  // 裸 6 位数字：按号段判市场
  m = s.match(/^(\d{6})$/);
  if (m) {
    const code = m[1];
    if (code.startsWith('6') || code.startsWith('5')) return mk('SH', code);   // 沪主板/科创板/沪基金
    if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) return mk('SZ', code); // 深主板/创业板/深基金
    if (code.startsWith('92')) return mk('BJ', code);                           // 北交所新号段
    if (code.startsWith('4') || code.startsWith('8')) return mk('BJ', code);    // 北交所/三板
    if (code.startsWith('9')) return mk('SH', code);                            // 沪 B 股
    return mk('SZ', code);
  }
  return null;
}

/** market+code → "SH600519" 形式的行键 */
function keyOf(entry) {
  return entry.market + entry.code;
}

/** 从行键还原 */
function fromKey(key) {
  if (typeof key !== 'string' || key.length < 7) return null;
  return parse(key);
}

module.exports = { parse, keyOf, fromKey, MARKET_SECID, US_EXCHANGE };
