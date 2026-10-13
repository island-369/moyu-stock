'use strict';
/**
 * 东方财富云端自选（myfavor.eastmoney.com/v4）。契约于 2026-10-12 从生产前端
 * 静态逆向 + 游客态在线探测确认：
 *   ggdefstkindexinfos → 全部分组（ginfolist: gid/gname + webindex 自定义排序）
 *   gstkinfos?g=<gid>  → 组内股票（stkinfolist: security/star/note/price/updatetime）
 *   登录态走 webouter/ 前缀，纯 Cookie 鉴权 + 固定 appkey，无加密参数。
 *   游客态缺设备指纹返回 state:-12「BID解析失败」。
 * fetcher 由主进程注入（绑定登录会话的 net.request），本模块零 Electron 依赖。
 */
const { FAVOR, UA } = require('../../shared/constants');
const parser = require('../code-parser');

/**
 * security 字段容忍解析。2026-10-12 实测真实格式（优先）：
 *   "{市场号}${代码}${时间戳}"，如 0$001216$17285020557739、1$603986$47148602949877
 * 兼容旧形态：SH.600519$600519 / SH600519$... / 1.600519$... / HK.00700$... / US.AAPL$...
 * @returns {{market,code,secid}|null}
 */
function parseSecurity(sec) {
  let s = String(sec || '').toUpperCase().trim();
  if (!s) return null;

  // 主格式：M$CODE$TIMESTAMP
  const parts = s.split('$');
  if (parts.length >= 2 && parts[0] && /^\d+$/.test(parts[0]) && parts[1]) {
    const mkt = parts[0];
    const code = parts[1];
    if (mkt === '1') return { market: 'SH', code, secid: '1.' + code };
    if (mkt === '0') {
      const market = /^(4|8|92)/.test(code) ? 'BJ' : 'SZ';
      return { market, code, secid: '0.' + code };
    }
    if (mkt === '116') return { market: 'HK', code, secid: '116.' + code };
    if (mkt === '105' || mkt === '106' || mkt === '107') {
      return { market: 'US', code, secid: mkt + '.' + code };
    }
  }

  // 兼容旧格式：截掉 $ 后缀后交给通用解析
  const cut = s.lastIndexOf('$');
  if (cut > 0) s = s.slice(0, cut);
  let m = s.match(/^(SH|SZ|BJ)\.?(\d{6})$/) || s.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (m) return m.length === 3 && /^\d+$/.test(m[1])
    ? parser.parse(m[2] + m[1]) : parser.parse(m[1] + m[2]);
  m = s.match(/^HK\.?(\d{4,5})$/);
  if (m) return { market: 'HK', code: m[1], secid: '116.' + m[1] };
  m = s.match(/^US\.?(.+)$/);
  if (m) return parser.parse(m[1]);
  m = s.match(/^([012])\.(\d{6})$/);
  if (m) {
    const market = m[1] === '1' ? 'SH' : /^(4|8|92)/.test(m[2]) ? 'BJ' : 'SZ';
    return { market, code: m[2], secid: m[1] + '.' + m[2] };
  }
  return parser.parse(s);
}

/** JSONP 容忍解析 */
function parseBody(body) {
  const text = String(body || '').trim();
  try { return JSON.parse(text); } catch (e) { /* 继续 */ }
  const m = text.match(/^[\w$]+\(([\s\S]*)\);?$/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) { /* 继续 */ } }
  throw Object.assign(new Error('unparseable body'), { kind: 'api' });
}

/** 错误分类：state!=0 → auth（连测两次才定性）；HTTP/网络 → network */
function classifyError(err) {
  if (err && (err.kind === 'network' || err.kind === 'auth' || err.kind === 'api')) return err;
  return Object.assign(err || new Error('unknown'), { kind: 'network' });
}

async function request(fetcher, path) {
  let body;
  try {
    body = await fetcher(FAVOR.base + path);
  } catch (e) {
    throw Object.assign(e, { kind: 'network' });
  }
  return parseBody(body);
}

/** 接口路径：必须带 cb（JSONP 回调）——不带时服务端返回空 body */
function apiPath(endpoint, extra) {
  return endpoint + '?appkey=' + FAVOR.appkey + '&cb=jsonpcb' + (extra || '');
}

/**
 * 分组列表。
 * @returns {Promise<Array<{gid:string, gname:string}>>}
 */
async function groupList(fetcher) {
  const j = await request(fetcher, apiPath('ggdefstkindexinfos'));
  if (j.state !== 0 || !j.data || !Array.isArray(j.data.ginfolist)) {
    throw Object.assign(new Error('state ' + j.state + ': ' + (j.message || '')), { kind: 'auth' });
  }
  return j.data.ginfolist.map((g) => ({ gid: String(g.gid), gname: String(g.gname || '分组') }));
}

/**
 * 组内股票。
 * @returns {Promise<Array<{market,code,secid,star:boolean}>>}
 */
async function groupStocks(fetcher, gid) {
  const j = await request(fetcher, apiPath('gstkinfos', '&g=' + encodeURIComponent(gid)));
  if (j.state !== 0 || !j.data || !Array.isArray(j.data.stkinfolist)) {
    throw Object.assign(new Error('state ' + j.state + ': ' + (j.message || '')), { kind: 'auth' });
  }
  const out = [];
  for (const s of j.data.stkinfolist) {
    const parsed = parseSecurity(s.security);
    if (!parsed) continue;
    out.push({ ...parsed, star: s.star != null && s.star !== '' });
  }
  return out;
}

/** 登录探测：state==0 即已登录 */
async function probeLogin(fetcher, log) {
  try {
    const j = await request(fetcher, apiPath('ggdefstkindexinfos'));
    return j.state === 0;
  } catch (e) {
    if (log) log('登录探测失败: ' + (e && e.message));
    return false;
  }
}

/** 会话 fetcher 的请求头（主进程注入时使用）。
 *  注意：Referer 不能作为 header 手动设置（Chromium 会以 invalid referrer 为由取消请求），
 *  必须通过 net.request 的 referrer 选项传入 —— 见 login-window.js。 */
const HEADERS = { 'User-Agent': UA };
const REFERER = 'https://quote.eastmoney.com/zixuan/';

module.exports = { groupList, groupStocks, probeLogin, parseSecurity, HEADERS, REFERER };
