'use strict';
/**
 * 全局快捷键：全部可自定义；注册失败（冲突）即时回报，不静默失效。
 */
const { globalShortcut } = require('electron');

/**
 * @param {object} shortcuts {boss, showhide, penetrate, alphaUp, alphaDown}
 * @param {object} handlers 同名处理函数
 * @param {(name:string, acc:string)=>void} onConflict
 */
function registerAll(shortcuts, handlers, onConflict) {
  globalShortcut.unregisterAll();
  for (const [name, acc] of Object.entries(shortcuts || {})) {
    const fn = handlers[name];
    if (!acc || typeof fn !== 'function') continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, fn); } catch (e) { ok = false; }
    if (!ok && onConflict) onConflict(name, acc);
  }
}

module.exports = { registerAll };
