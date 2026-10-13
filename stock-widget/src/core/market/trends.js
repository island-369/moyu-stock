'use strict';
/**
 * 个股分时（东财 trends2）。2026-10-12 实测 fields2 顺序：
 *   "时间,开盘,现价,最高,最低,成交量,成交额,均价" → 现价取第 3 段（idx 2），均价 idx 7。
 * 返回降采样后的点位（含均价，供分时图叠画）+ 昨收基线。
 */
const { EM, UA } = require('../../shared/constants');

const TIMEOUT = 8000;
const MAX_POINTS = 160;

/**
 * @param {string} secid 如 '1.600519'
 * @returns {Promise<{points:Array<{t:string,p:number,avg:number|null}>, preClose:number|null, name:string}>}
 */
async function fetchTrends(secid, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const res = await doFetch(EM.trends + encodeURIComponent(secid), {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const d = j && j.data;
  if (!d || !Array.isArray(d.trends)) throw new Error('bad response shape');
  const points = [];
  for (const line of d.trends) {
    const f = line.split(',');
    const p = Number(f[2]);
    if (!Number.isFinite(p)) continue;
    const avg = Number(f[7]);
    points.push({ t: (f[0] || '').slice(11), p, avg: Number.isFinite(avg) ? avg : null });
  }
  // 降采样：均匀抽取
  let sampled = points;
  if (points.length > MAX_POINTS) {
    sampled = [];
    const step = (points.length - 1) / (MAX_POINTS - 1);
    for (let i = 0; i < MAX_POINTS; i++) sampled.push(points[Math.round(i * step)]);
  }
  return {
    points: sampled,
    preClose: Number.isFinite(Number(d.preClose)) ? Number(d.preClose) : null,
    name: d.name || '',
  };
}

module.exports = { fetchTrends };
