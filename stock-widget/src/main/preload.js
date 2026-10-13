'use strict';
/**
 * 预加载桥：渲染层唯一 IPC 通道，白名单收口。
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
  'app:boot', 'app:search', 'app:trends', 'app:news',
  'app:settings:set', 'app:settings:open', 'app:penetrate', 'app:boss', 'app:import', 'app:shortcuts:reset', 'app:debug',
  'app:positions:import', 'app:positions:remove',
  'app:list:add', 'app:list:remove', 'app:list:reorder',
  'app:list:star', 'app:group:select', 'app:login:open', 'app:login:logout',
  'app:win:form', 'app:win:height', 'app:win:width', 'app:win:expand', 'app:popup:watch', 'app:settings:hide', 'app:resize:start', 'app:resize:end', 'app:ctx:menu', 'app:bg:ctx', 'app:open-external',
  'app:hide', 'app:refresh', 'app:quit', 'app:meeting',
];
const EVENTS = ['evt:state', 'evt:settings', 'evt:login', 'evt:notice', 'evt:penetrate', 'evt:popup:close', 'evt:win:settings-vis', 'evt:meeting', 'evt:focus-search'];

contextBridge.exposeInMainWorld('widget', {
  invoke(channel, payload) {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error('bad channel: ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENTS.includes(channel) || typeof cb !== 'function') return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
