'use strict';
/**
 * 7×24 财经快讯（东财 np-listapi）。2026-10-12 实测：
 *   必须带 req_trace 参数（任意时间戳即可），否则报缺失参数。
 */
const { NEWS, UA } = require('../../shared/constants');

const TIMEOUT = 8000;

/**
 * @returns {Promise<Array<{time:string, title:string, url:string, summary:string}>>}
 */
async function fetchNews(opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const url = NEWS + Date.now() + '123';
  const res = await doFetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://kuaixun.eastmoney.com/' },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const list = j && j.data && Array.isArray(j.data.list) ? j.data.list : [];
  return list
    .filter((n) => n && n.title)
    .map((n) => ({
      time: n.showTime || '',
      title: n.title,
      summary: (n.summary || '').slice(0, 120),
      url: n.uniqueUrl || n.url || '',
    }));
}

module.exports = { fetchNews };
