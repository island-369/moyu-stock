'use strict';
/**
 * 写回链路真机验证（--validate-write）：
 *   用登录会话做一轮「读分组 → 加测试股 → 读回确认 → 删测试股 → 读回确认」，
 *   只动 600519（贵州茅台）在默认分组里的有无，验证完恢复原状，不碰其他自选。
 *
 * 运行方式（先退出行情小窗，避免单实例锁挡住）：
 *   npm run validate-write        # = electron . --validate-write
 *
 * 判定：
 *   VALIDATE_WRITE_OK    全链路通过（写回可用）
 *   VALIDATE_WRITE_FAIL  某一步失败（看日志定位：未登录 / 接口变更 / 参数语义变化）
 */
const { app } = require('electron');
const myfavor = require('../core/sync/myfavor');

const TEST_SECID = '1.600519'; // 贵州茅台（A 股，代码人尽皆知，测试后无残留）

/**
 * @param {{fetcher:Function, log:object}} deps fetcher 已绑定 persist:em-login 登录会话
 */
async function runValidateWrite({ fetcher, log }) {
  const say = (m) => { log.info(m); console.log('[validate-write] ' + m); };
  const fail = (m) => { say('✗ ' + m); console.log('VALIDATE_WRITE_FAIL ' + m); };

  // 1. 登录探测
  if (!(await myfavor.probeLogin(fetcher, null))) {
    fail('未登录（先在应用里扫码登录，再跑验证）');
    return false;
  }
  say('登录态正常');

  // 2. 读分组
  const groups = await myfavor.groupList(fetcher);
  say('分组 ' + groups.length + ' 个：' + groups.map((g) => g.gname).join('、'));

  // 3. 加测试股到默认分组（asz 与小窗「全部」视图同路径）
  const before = await readDefaultHas(fetcher, groups);
  say('测试前默认分组是否已含 600519：' + (before ? '是（删除后可恢复）' : '否'));
  let r = await myfavor.addStockToDefault(fetcher, TEST_SECID);
  if (!r.re) { fail('addStockToDefault 失败：' + (r.message || '')); return false; }
  say('as? 添加成功');

  // 4. 读回确认（服务端落位可能非首组，全组找）
  await sleep(1200);
  const afterAdd = await readDefaultHas(fetcher, groups);
  if (!afterAdd) { fail('添加后读回未发现 600519（写接口返回成功但云态未变，契约疑似变更）'); return false; }
  say('读回确认：600519 已在云端');

  // 5. 删除（在哪个组就删哪个组，全部清干净）
  const gids = await groupsContaining(fetcher, groups);
  if (!gids.length) { fail('读回发现 600519，但定位不到所在分组'); return false; }
  for (const gid of gids) {
    const d = await myfavor.deleteStock(fetcher, gid, TEST_SECID);
    if (!d.re) { fail('deleteStock(' + gid + ') 失败：' + (d.message || '') + ' —— 600519 残留，请手动删除'); return false; }
  }
  say('ds? 删除成功 × ' + gids.length + ' 组');

  // 6. 读回确认删除（若验证前就有，恢复原状也算通过）
  await sleep(1200);
  const afterDel = await groupsContaining(fetcher, groups);
  if (afterDel.length && !before) { fail('删除后读回仍发现 600519（请手动删除）'); return false; }
  if (afterDel.length && before) say('已恢复验证前状态（600519 本来就在）');

  say('✓ 写回链路验证通过（加 / 删 / 读回全部一致）');
  console.log('VALIDATE_WRITE_OK');
  return true;
}

/** 默认分组（首组）里是否已有测试股 */
async function readDefaultHas(fetcher, groups) {
  if (!groups.length) return false;
  const list = await myfavor.groupStocks(fetcher, groups[0].gid);
  return list.some((s) => s.secid === TEST_SECID);
}

/** 测试股当前所在的全部分组 gid */
async function groupsContaining(fetcher, groups) {
  const out = [];
  for (const g of groups) {
    const list = await myfavor.groupStocks(fetcher, g.gid);
    if (list.some((s) => s.secid === TEST_SECID)) out.push(g.gid);
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 入口：验证完自动退出进程（exitCode 0=通过 1=失败） */
async function validateAndExit({ fetcher, log }) {
  let ok = false;
  try {
    ok = await runValidateWrite({ fetcher, log });
  } catch (e) {
    console.log('[validate-write] ✗ 异常：' + ((e && e.message) || e));
    console.log('VALIDATE_WRITE_FAIL ' + ((e && e.message) || 'exception'));
    ok = false;
  }
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
}

module.exports = { runValidateWrite, validateAndExit };
