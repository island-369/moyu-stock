'use strict';
/**
 * 个股分时：东财 trends2 为主源，腾讯分钟线兜底。
 *
 * 2026-10-12 实测东财 fields2 顺序："时间,开盘,现价,最高,最低,成交量,成交额,均价"
 *   → 现价取第 3 段（idx 2），均价 idx 7。
 * 2026-10-14 实测该接口与批量行情同一套风控（时间窗式：好窗口连续 200、坏窗口直接断），
 *   成功率约 1/3 → 与行情一样：单轮内先重试 2 次，仍失败则切腾讯分钟线
 *   （web.ifzq.gtimg.cn/appstock/app/minute/query，实测 10/10 可用）。
 *
 * 返回降采样后的点位（含均价，供分时图叠画）+ 昨收基线，两个源的数据形状一致。
 */
const { EM, UA } = require('../../shared/constants');
const { toTencentSymbol } = require('./tencent');

const TIMEOUT = 8000;
const MAX_POINTS = 160;
const ATTEMPTS = 3;
const RETRY_GAPS_MS = [300, 900];
const TX_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 均匀降采样（导出便于单测） */
function samplePoints(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** 东财分时（主源） */
async function fromEastmoney(secid, opts = {}) {
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
  if (!points.length) throw new Error('no points');
  return {
    points: samplePoints(points),
    preClose: Number.isFinite(Number(d.preClose)) ? Number(d.preClose) : null,
    name: d.name || '',
    source: 'eastmoney',
  };
}

/**
 * 腾讯分钟线（兜底）。返回行形如 "0931 22.60 28994 65398256.00"
 *   = 时间 / 现价 / 累计成交量(手) / 累计成交额(元)；昨收取 qt[sym][4]。
 * 腾讯不给均价，用 VWAP = 成交额 / (累计手数 × 100) 还原，口径与东财均价线一致。
 */
async function fromTencent(secid, opts = {}) {
  const sym = toTencentSymbol(secid);
  if (!sym) throw new Error('no tencent symbol');
  const doFetch = opts.fetchImpl || fetch;
  const res = await doFetch(TX_MINUTE + sym, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const d = j && j.data && j.data[sym];
  const arr = d && d.data && d.data.data;
  if (!Array.isArray(arr) || !arr.length) throw new Error('bad response shape');
  const qt = (d.qt && d.qt[sym]) || [];
  const points = [];
  for (const line of arr) {
    const f = String(line).split(/\s+/);
    const p = Number(f[1]);
    if (!Number.isFinite(p) || p <= 0) continue; // 集合竞价前 / 停牌：价格为 0
    const vol = Number(f[2]);
    const amt = Number(f[3]);
    const avg = Number.isFinite(vol) && vol > 0 && Number.isFinite(amt) ? +(amt / (vol * 100)).toFixed(3) : null;
    const t = f[0] && f[0].length === 4 ? f[0].slice(0, 2) + ':' + f[0].slice(2) : f[0];
    points.push({ t, p, avg });
  }
  if (!points.length) throw new Error('no points');
  return {
    points: samplePoints(points),
    preClose: Number.isFinite(Number(qt[4])) ? Number(qt[4]) : null,
    name: qt[1] || '',
    source: 'tencent',
  };
}

/**
 * 拉分时：东财重试 3 次 → 仍失败则腾讯兜底。
 * 两个源都失败才抛错（此时小窗才会显示"分时数据获取失败"）。
 * @param {string} secid 如 '1.600519'
 * @param {{fetchImpl?:function, timeout?:number, sleepFn?:function}} opts
 */
async function fetchTrends(secid, opts = {}) {
  const doSleep = opts.sleepFn || sleep;
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await fromEastmoney(secid, opts);
    } catch (e) {
      lastErr = e;
      if (i < ATTEMPTS - 1) await doSleep(RETRY_GAPS_MS[Math.min(i, RETRY_GAPS_MS.length - 1)]);
    }
  }
  try {
    return await fromTencent(secid, opts);
  } catch (e) {
    throw lastErr || e;
  }
}

module.exports = { fetchTrends, fromEastmoney, fromTencent, samplePoints, MAX_POINTS };
