'use strict';
/**
 * 登录窗：加载东方财富自选页（quote.eastmoney.com/zixuan/），
 * 用独立持久分区（persist:em-login）承载会话——Cookie 始终留在
 * Chromium 自己的加密存储里，应用代码零接触。
 * 每 2.5s 用 myfavor 接口探测登录态，state==0 即成功，自动关窗。
 * 同时记录页面自身发起的 myfavor 请求 URL 作端点一致性诊断。
 */
const { BrowserWindow, net } = require('electron');
const myfavor = require('../core/sync/myfavor');

/** 绑定登录会话的 fetcher（注入 myfavor 模块）。
 *  2026-10-12 实测结论（勿改回）：
 *  - net.request 的 referrer 选项不会真正发出 Referer 头 → 服务端 403；
 *  - 直接 setHeader('Referer') 会被 Chromium 以 invalid referrer 为由取消请求；
 *  - 唯一可靠通道是 attachRefererFix 的 onBeforeSendHeaders 注入。 */
function sessionFetcher(ses) {
  return (url) => new Promise((resolve, reject) => {
    const req = net.request({ url, useSessionCookies: true, session: ses });
    req.setHeader('User-Agent', myfavor.HEADERS['User-Agent']);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });
}

/** myfavor 服务强制要求 Referer。只补缺失的，登录页自身请求不受影响。 */
function attachRefererFix(ses) {
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['*://myfavor.eastmoney.com/*'] },
    (details, cb) => {
      const h = { ...details.requestHeaders };
      const has = Object.keys(h).some((k) => k.toLowerCase() === 'referer');
      if (!has) h['Referer'] = myfavor.REFERER;
      cb({ requestHeaders: h });
    }
  );
}

/**
 * @param {object} opts
 *   ses: Electron Session（persist:em-login）
 *   onSuccess() / onCancelled() / log()
 */
function openLoginWindow(opts) {
  const { ses, onSuccess, onCancelled, log } = opts;
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    // 中性化：标题只留「登录」（原「登录东方财富」在任务控制/窗口列表直接暴露），不进 ⌘Tab
    title: '登录',
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      partition: 'persist:em-login',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const filter = { urls: ['*://myfavor.eastmoney.com/*'] };
  const capture = (details, cb) => {
    if (log) log('myfavor(页面自身请求) ' + details.url);
    cb({});
  };
  try { ses.webRequest.onBeforeRequest(filter, capture); } catch (e) { /* 忽略 */ }

  win.loadURL('https://quote.eastmoney.com/zixuan/');

  let settled = false;
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return;
    try {
      const ok = await myfavor.probeLogin(sessionFetcher(ses), log);
      if (ok && !settled) {
        settled = true;
        clearInterval(timer);
        try { ses.webRequest.onBeforeRequest(null); } catch (e) { /* 忽略 */ }
        onSuccess && onSuccess();
        win.close();
      }
    } catch (e) { /* 探测失败静默重试 */ }
  }, 2500);

  win.on('closed', () => {
    clearInterval(timer);
    try { ses.webRequest.onBeforeRequest(null); } catch (e) { /* 忽略 */ }
    if (!settled) { settled = true; onCancelled && onCancelled(); }
  });

  return win;
}

/** 退出登录：清空登录分区全部存储 */
async function logout(ses) {
  try { await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] }); return true; }
  catch (e) { return false; }
}

module.exports = { sessionFetcher, attachRefererFix, openLoginWindow, logout };
