'use strict';
/**
 * 全局常量：端点、请求头、默认值。
 * 所有端点均于 2026-10-12 在线实测确认（详见方案文档 §6.4）。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..'); // 项目根目录

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// 东方财富公开行情 ut 令牌（网页版同款，社区通用公开值）
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

const EM = {
  // 批量行情：注意 ulist.np 已失效，必须用 ulist/get 且带分页参数，否则 rc:102
  quoteList:
    'https://push2.eastmoney.com/api/qt/ulist/get' +
    '?fltt=2&invt=2&ut=' + EM_UT + '&pn=1&pz=50&po=1&np=1&fid=f12' +
    '&fields=f1,f2,f3,f4,f12,f13,f14,f18&secids=',
  // 分时：fields2 顺序 = 时间,开,现价,高,低,量,额,均价（实测确认，现价取第 3 段）
  trends:
    'https://push2his.eastmoney.com/api/qt/stock/trends2/get' +
    '?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1&secid=',
  // 搜索建议（token 为网页版公开值，实测有效）
  search:
    'https://searchapi.eastmoney.com/api/suggest/get' +
    '?type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10&input=',
};

const TX = {
  // 腾讯行情备源（GBK 编码；字段：3=现价 4=昨收 31=涨跌 32=涨跌幅）
  quote: 'https://qt.gtimg.cn/q=',
};

const NEWS =
  'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' +
  '?client=web&biz=web_724&column=350&order=1&needInteractData=0' +
  '&page_index=1&page_size=20&fields=code,showTime,title,summary,url,uniqueUrl,Np_dst' +
  '&req_trace=';

const FAVOR = {
  base: 'https://myfavor.eastmoney.com/v4/webouter/',
  appkey: 'e9166c7e9cdfad3aa3fd7d93b757e9b1',
};

// 指数行 + 托盘标题固定使用（无论是否显示指数条，托盘都需要上证）
const INDEX_SECIDS = ['1.000001', '0.399001', '0.399006'];
const INDEX_SHORT_NAMES = {
  '1.000001': '沪',
  '0.399001': '深',
  '0.399006': '创',
};

// 引导 / 冒烟的示例自选
const DEMO_LIST = [
  { m: 'SH', c: '600519' }, // 贵州茅台
  { m: 'SH', c: '510300' }, // 沪深300ETF
];

const REFRESH_CHOICES = [3000, 5000, 10000, 30000];

const DEFAULT_SHORTCUTS = {
  boss: 'Alt+Shift+H',
  showhide: 'Alt+Shift+S',
  penetrate: 'Alt+Shift+X',
  alphaUp: 'Alt+Shift+Up',
  alphaDown: 'Alt+Shift+Down',
  meeting: 'Alt+Shift+M',
  groupPrev: 'Alt+Shift+Left',
  groupNext: 'Alt+Shift+Right',
};

const SMOKE_LIST = [
  { m: 'SH', c: '600519' },
  { m: 'SZ', c: '000001' },
  { m: 'SZ', c: '300750' },
  { m: 'SH', c: '510300' },
  { m: 'BJ', c: '833171' },
];

module.exports = {
  ROOT, UA, EM_UT, EM, TX, NEWS, FAVOR,
  INDEX_SECIDS, INDEX_SHORT_NAMES, DEMO_LIST, REFRESH_CHOICES,
  DEFAULT_SHORTCUTS, SMOKE_LIST,
};
