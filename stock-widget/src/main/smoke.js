'use strict';
/**
 * 冒烟模式（--smoke）：真实拉数据 + 自动截图。独立 profile 由 index.js 设置，
 * 本模块只负责「等到第一份数据 → 截图 → 退出」。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { ROOT } = require('../shared/constants');

/**
 * @param {{orch:object, getMainWin:()=>object, log:object}} deps
 */
function runSmoke({ orch, getMainWin, log }) {
  let done = false;
  const finish = async (why) => {
    if (done) return;
    done = true;
    log.info('smoke finish: ' + why);
    console.log('SMOKE_FINISH(' + why + ') data=' + (orch && orch.lastUpdate ? 'yes' : 'no'));
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const w = getMainWin();
      const img = await w.webContents.capturePage();
      const out = path.join(ROOT, 'smoke-screenshot.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SMOKE_OK ' + out);
    } catch (e) {
      console.error('SMOKE_CAPTURE_FAIL ' + (e && e.message));
    }
    setTimeout(() => app.exit(0), 300);
  };
  orch.on('state', () => { if (orch.lastUpdate) finish('data'); });
  setTimeout(() => finish('timeout'), 25000);
}

module.exports = { runSmoke };
