'use strict';
/**
 * 带指数退避的重试（仅用于网络类错误；业务态错误由调用方分类处理）。
 */

/**
 * @param {() => Promise<T>} fn
 * @param {{retries?:number, base?:number, max?:number, sleep?:function}} opts
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const base = opts.base ?? 800;
  const max = opts.max ?? 30000;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(Math.min(base * Math.pow(2, attempt), max));
    }
  }
  throw lastErr;
}

/** 轮询失败后的下一次调度间隔：1s/2s/4s → 60s 封顶 */
function backoffDelay(retryCount) {
  if (retryCount <= 0) return 1000;
  return Math.min(1000 * Math.pow(2, retryCount - 1), 60000);
}

module.exports = { withRetry, backoffDelay };
