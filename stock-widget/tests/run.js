'use strict';
/**
 * 核心层单元测试（纯 Node，不需要 Electron）。
 * 运行：npm test
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('../src/core/code-parser');
const session = require('../src/core/session');
const { withRetry, backoffDelay } = require('../src/core/retry');
const { parseSecurity } = require('../src/core/sync/myfavor');
const { parse: txParse } = { parse: null } || {};
const tx = require('../src/core/market/tencent');
const { Store, deepMerge } = require('../src/store/settings');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.message));
  }
}

console.log('\n[1] 代码解析器');

test('裸 6 位：600519 → SH', () => {
  assert.deepStrictEqual(parser.parse('600519'), { market: 'SH', code: '600519', secid: '1.600519' });
});
test('裸 6 位：000001 → SZ（歧义默认深市个股）', () => {
  assert.deepStrictEqual(parser.parse('000001'), { market: 'SZ', code: '000001', secid: '0.000001' });
});
test('sh000001 → 上证指数（前缀消歧）', () => {
  const r = parser.parse('sh000001');
  assert.strictEqual(r.market, 'SH');
  assert.strictEqual(r.secid, '1.000001');
});
test('000001.SH → SH 指数', () => {
  assert.strictEqual(parser.parse('000001.SH').secid, '1.000001');
});
test('300750 → SZ 创业板', () => {
  assert.strictEqual(parser.parse('300750').market, 'SZ');
});
test('688981 → SH 科创板', () => {
  assert.strictEqual(parser.parse('688981').market, 'SH');
});
test('510300 → SH 基金', () => {
  assert.strictEqual(parser.parse('510300').market, 'SH');
});
test('159915 → SZ 基金', () => {
  assert.strictEqual(parser.parse('159915').market, 'SZ');
});
test('833171 / 430047 / 920001 → BJ', () => {
  assert.strictEqual(parser.parse('833171').market, 'BJ');
  assert.strictEqual(parser.parse('430047').market, 'BJ');
  assert.strictEqual(parser.parse('920001').market, 'BJ');
});
test('00700 → HK', () => {
  assert.deepStrictEqual(parser.parse('00700'), { market: 'HK', code: '00700', secid: '116.00700' });
});
test('00700.HK / HK00700 → HK', () => {
  assert.strictEqual(parser.parse('00700.HK').secid, '116.00700');
  assert.strictEqual(parser.parse('HK00700').secid, '116.00700');
});
test('AAPL → US 纳斯达克默认', () => {
  assert.strictEqual(parser.parse('AAPL').secid, '105.AAPL');
});
test('AAPL.N → US 纽交所', () => {
  assert.strictEqual(parser.parse('AAPL.N').secid, '106.AAPL');
});
test('secid 直写 1.600519', () => {
  assert.strictEqual(parser.parse('1.600519').secid, '1.600519');
});
test('SH.600519 / 600519.SH', () => {
  assert.strictEqual(parser.parse('SH.600519').secid, '1.600519');
  assert.strictEqual(parser.parse('600519.SH').secid, '1.600519');
});
test('垃圾输入 → null', () => {
  assert.strictEqual(parser.parse('茅台'), null);
  assert.strictEqual(parser.parse(''), null);
  assert.strictEqual(parser.parse('1234567890123'), null);
  assert.strictEqual(parser.parse(null), null);
});

console.log('\n[2] 交易时段状态机');

const at = (h, m, weekday) => {
  // weekday: 周一到周五
  const days = [1, 2, 3, 4, 5];
  const d = new Date(2026, 9, days[weekday % 5], h, m, 0);
  return d;
};
test('周一 10:00 A股 → open', () => {
  assert.strictEqual(session.marketPhase(at(10, 0, 0), new Set(['SH'])), 'open');
});
test('周一 12:00 A股 → lunch', () => {
  assert.strictEqual(session.marketPhase(at(12, 0, 0), new Set(['SZ'])), 'lunch');
});
test('周一 09:20 → auction', () => {
  assert.strictEqual(session.marketPhase(at(9, 20, 0), new Set(['SH'])), 'auction');
});
test('周一 15:30 → closed', () => {
  assert.strictEqual(session.marketPhase(at(15, 30, 0), new Set(['SH'])), 'closed');
});
test('周六 10:00 → closed', () => {
  const sat = new Date(2026, 9, 10, 10, 0); // 2026-10-10 周六
  assert.strictEqual(session.marketPhase(sat, new Set(['SH'])), 'closed');
});
test('周一 12:00 但含 HK → open（港股午盘连续）', () => {
  // A 股午休 11:30-13:00，港股 13:00 才开午后… 12:00 港股也休。改用 11:45
  assert.strictEqual(session.marketPhase(at(11, 45, 0), new Set(['HK'])), 'open');
});
test('周一 23:00 含 US → open（宽窗口）', () => {
  assert.strictEqual(session.marketPhase(at(23, 0, 0), new Set(['US'])), 'open');
});
test('closed 心跳 60s / open 用户间隔 / 自适应 60s', () => {
  assert.strictEqual(session.suggestedInterval('closed', 5000, false), 60000);
  assert.strictEqual(session.suggestedInterval('open', 5000, false), 5000);
  assert.strictEqual(session.suggestedInterval('open', 5000, true), 60000);
  assert.strictEqual(session.suggestedInterval('lunch', 5000, false), 30000);
});

console.log('\n[3] 重试与退避');

(async () => {
  let attempts = 0;
  const res = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error('x');
    return 'ok';
  }, { retries: 3, base: 1, sleep: () => Promise.resolve() });
  assert.strictEqual(res, 'ok');
  assert.strictEqual(attempts, 3);
  passed++; console.log('  ✓ withRetry：失败两次后成功');
})().then(async () => {

  test('backoffDelay：1s/2s/4s → 60s 封顶', () => {
    assert.strictEqual(backoffDelay(1), 1000);
    assert.strictEqual(backoffDelay(2), 2000);
    assert.strictEqual(backoffDelay(3), 4000);
    assert.strictEqual(backoffDelay(10), 60000);
  });

  console.log('\n[4] myfavor security 解析（多形态容忍）');

  test('真实格式 0$001216$17285020557739 → SZ（2026-10-12 实测）', () => {
    assert.deepStrictEqual(parseSecurity('0$001216$17285020557739'), { market: 'SZ', code: '001216', secid: '0.001216' });
  });
  test('真实格式 1$603986$47148602949877 → SH（2026-10-12 实测）', () => {
    assert.deepStrictEqual(parseSecurity('1$603986$47148602949877'), { market: 'SH', code: '603986', secid: '1.603986' });
  });
  test('真实格式 0$833171$… → BJ（北交所挂在市场 0 下）', () => {
    assert.strictEqual(parseSecurity('0$833171$123').market, 'BJ');
  });
  test('真实格式 1$000001$… → SH 指数', () => {
    assert.strictEqual(parseSecurity('1$000001$123').secid, '1.000001');
  });
  test('真实格式 116$00700$… → HK', () => {
    assert.strictEqual(parseSecurity('116$00700$123').secid, '116.00700');
  });
  test('真实格式 105$AAPL$… → US', () => {
    assert.strictEqual(parseSecurity('105$AAPL$123').secid, '105.AAPL');
  });
  test('SH.600519$600519（旧格式兼容）', () => {
    const r = parseSecurity('SH.600519$600519');
    assert.strictEqual(r.secid, '1.600519');
  });
  test('SH600519$600519', () => {
    assert.strictEqual(parseSecurity('SH600519$600519').secid, '1.600519');
  });
  test('1.600519$600519（数字市场前缀）', () => {
    assert.strictEqual(parseSecurity('1.600519$600519').secid, '1.600519');
  });
  test('0.833171$833171 → BJ', () => {
    assert.strictEqual(parseSecurity('0.833171$833171').market, 'BJ');
  });
  test('HK.00700$00700', () => {
    assert.strictEqual(parseSecurity('HK.00700$00700').secid, '116.00700');
  });
  test('US.AAPL$AAPL', () => {
    assert.strictEqual(parseSecurity('US.AAPL$AAPL').secid, '105.AAPL');
  });

  console.log('\n[5] 腾讯备源符号映射');

  test('secid → 腾讯符号', () => {
    assert.strictEqual(tx.toTencentSymbol('1.600519'), 'sh600519');
    assert.strictEqual(tx.toTencentSymbol('0.000001'), 'sz000001');
    assert.strictEqual(tx.toTencentSymbol('116.00700'), 'hk00700');
    assert.strictEqual(tx.toTencentSymbol('105.AAPL'), null);
  });

  console.log('\n[6] 设置存储（原子写 + 回滚）');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
  const file = path.join(tmp, 'settings.json');
  const store = new Store(file);
  store.load();
  test('默认值可读', () => {
    assert.strictEqual(store.get().appearance.theme, 'auto');
    assert.strictEqual(store.get().behavior.refreshInterval, 5000);
  });
  test('深合并补丁 + 持久化', () => {
    store.set({ appearance: { bgAlpha: 0.5 } });
    const again = new Store(file).load();
    assert.strictEqual(again.get().appearance.bgAlpha, 0.5);
    assert.strictEqual(again.get().appearance.theme, 'auto'); // 其他默认仍在
  });
  test('主文件损坏 → .bak 回滚到上一版', () => {
    store.set({ behavior: { refreshInterval: 10000 } });
    fs.writeFileSync(file, '{broken json');
    const recovered = new Store(file).load();
    // .bak 保存的是最后一次成功写入前的版本（refreshInterval=5000）
    assert.strictEqual(recovered.get().behavior.refreshInterval, 5000);
    assert.strictEqual(recovered.get().appearance.bgAlpha, 0.5);
  });
  test('数组整体替换（manualList）', () => {
    const merged = deepMerge({ a: { list: [1, 2] } }, { a: { list: [3] } });
    assert.deepStrictEqual(merged.a.list, [3]);
  });
  /* ---- [7] 行情请求合并 + 主源滞回（对应 2026-10-14 实测的东财批量接口时间窗风控） ---- */
  console.log('\n[7] 行情请求合并与主源滞回');

  const atest = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); }
  };

  const quote = require('../src/core/market/quote');
  const { Orchestrator } = require('../src/main/orchestrator');
  const realFetch = globalThis.fetch;
  const jsonOnce = () => ({ ok: true, json: async () => ({ data: { diff: [] } }) });

  await atest('批量行情：385 只只发 1 个请求，pz 随本次条数', async () => {
    const urls = [];
    const secids = Array.from({ length: 385 }, (_, i) => '1.' + String(600000 + i));
    await quote.fetchQuotes(secids, { fetchImpl: async (u) => { urls.push(u); return jsonOnce(); } });
    assert.strictEqual(urls.length, 1);
    assert.ok(/[?&]pz=385&/.test(urls[0]), 'pz 应等于本次条数：' + urls[0].slice(0, 110));
  });

  await atest('批量行情：超过单请求上限才分批', async () => {
    const urls = [];
    const secids = Array.from({ length: 800 }, (_, i) => '1.' + String(600000 + i));
    await quote.fetchQuotes(secids, { fetchImpl: async (u) => { urls.push(u); return jsonOnce(); } });
    assert.strictEqual(urls.length, 2);
    assert.ok(/[?&]pz=700&/.test(urls[0]) && /[?&]pz=100&/.test(urls[1]));
  });

  // ---- 编排器：用桩 fetch 模拟"主源时间窗风控" ----------------
  const EM_OK = { ok: true, json: async () => ({ data: { diff: [{ f2: 22.9, f3: 0.44, f4: 0.1, f12: '600026', f13: 1, f14: '中远海能', f18: 22.8 }] } }) };
  const TX_FIELDS = new Array(50).fill('0');
  TX_FIELDS[0] = '1'; TX_FIELDS[1] = 'TEST'; TX_FIELDS[2] = '600026';
  TX_FIELDS[3] = '22.90'; TX_FIELDS[4] = '22.80'; TX_FIELDS[31] = '0.10'; TX_FIELDS[32] = '0.44';
  const TX_BODY = new TextEncoder().encode('v_sh600026="' + TX_FIELDS.join('~') + '";');
  const isEm = (u) => String(u).includes('push2.eastmoney.com');
  const failEm = async (u) => {
    if (isEm(u)) throw new Error('net::ERR_EMPTY_RESPONSE');
    return { ok: true, arrayBuffer: async () => TX_BODY };
  };
  const mkOrch = () => new Orchestrator({
    settings: {
      data: {
        source: { mode: 'manual', manualList: [{ m: 'SH', c: '600026' }], manualStars: {}, localOrder: {}, filterStarred: false, activeGroup: 'default', sortMode: 'default', positions: [] },
        behavior: { refreshInterval: 5000 },
        alerts: { enabled: false, summary: false, threshold: 5 },
        window: { form: 'full' },
      },
      get() { return this.data; },
      set() {},
    },
    log: { info() {}, warn() {}, error() {} },
    sleepFn: () => Promise.resolve(),   // 重试/探活间隔立即返回，测试不等真实秒数
  });

  await atest('同一 tick 内重试生效：坏窗口里第 2 次成功就不算失败', async () => {
    let n = 0;
    globalThis.fetch = async (u) => {
      if (isEm(u)) { n += 1; if (n === 1) throw new Error('bad window'); return EM_OK; }
      return { ok: true, arrayBuffer: async () => TX_BODY };
    };
    const orch = mkOrch();
    await orch.tickQuote(); orch.stop();
    assert.strictEqual(orch.consecFail, 0);
    assert.strictEqual(orch.source, 'eastmoney');
    assert.strictEqual(n, 2, '应重试一次后成功');
  });

  await atest('主源持续失败 → 切腾讯备源，状态是 backup 而不是 net-error', async () => {
    globalThis.fetch = failEm;
    const orch = mkOrch();
    for (let i = 0; i < 3; i++) { await orch.tickQuote(); orch.stop(); }
    assert.strictEqual(orch.source, 'tencent');
    assert.strictEqual(orch.statusCode(), 'backup');
    const stay = orch.recoverAt - Date.now();
    assert.ok(stay > 55000 && stay <= 60000, '切备源后应有 ≈60s 最短停留，实际 ' + stay + 'ms');
  });

  await atest('探活未通过 → 退避翻倍（60s→120s→240s），不再十几秒一次横跳', async () => {
    globalThis.fetch = failEm;
    const orch = mkOrch();
    orch.source = 'tencent';
    orch.recoverAt = 0;
    await orch.recoverMain(['1.600026']);
    assert.strictEqual(orch.recoverInterval, 120000);
    orch.recoverAt = 0;
    await orch.recoverMain(['1.600026']);
    assert.strictEqual(orch.recoverInterval, 240000);
    assert.strictEqual(orch.source, 'tencent', '探活不通过就不切回');
  });

  await atest('只探活成功 1 次不切回（避免正好撞上好窗口就横跳）', async () => {
    let n = 0;
    globalThis.fetch = async (u) => {
      if (isEm(u)) { n += 1; if (n >= 2) throw new Error('又进坏窗口'); return EM_OK; }
      return { ok: true, arrayBuffer: async () => TX_BODY };
    };
    const orch = mkOrch();
    orch.source = 'tencent';
    orch.recoverAt = 0;
    await orch.recoverMain(['1.600026']);
    assert.strictEqual(orch.source, 'tencent');
    assert.strictEqual(orch.recoverInterval, 120000);
  });

  await atest('连续 2 次探活成功才切回主源，并进入观察期', async () => {
    globalThis.fetch = async (u) => (isEm(u) ? EM_OK : { ok: true, arrayBuffer: async () => TX_BODY });
    const orch = mkOrch();
    orch.source = 'tencent';
    orch.recoverAt = 0;
    await orch.recoverMain(['1.600026']);
    assert.strictEqual(orch.source, 'eastmoney');
    assert.ok(orch.probationUntil > Date.now(), '切回后应进入观察期');
  });

  await atest('观察期内再失败 1 次就退回备源（不干等 3 次）', async () => {
    globalThis.fetch = failEm;
    const orch = mkOrch();
    orch.source = 'eastmoney';
    orch.probationUntil = Date.now() + 60000;
    await orch.tickQuote(); orch.stop();
    assert.strictEqual(orch.source, 'tencent');
  });

  globalThis.fetch = realFetch;

  /* ---- [8] 分时：重试 + 腾讯兜底（东财分时与批量行情同源同风控） ---- */
  console.log('\n[8] 分时：重试与腾讯兜底');

  const trends = require('../src/core/market/trends');
  const EM_TRENDS = { ok: true, json: async () => ({ data: { name: '中远海能', preClose: 22.7, trends: [
    '2026-10-14 09:30,22.69,22.69,22.69,22.69,3472,7877968.00,22.690',
    '2026-10-14 09:31,22.58,22.60,22.70,22.32,25522,57520288.00,22.556',
  ] } }) };
  const TX_MIN = { ok: true, json: async () => ({ code: 0, data: { sh600026: {
    data: { date: '20261014', data: ['0930 22.69 3472 7877968.00', '0931 22.60 28994 65398256.00'] },
    qt: { sh600026: ['1', '中远海能', '600026', '23.18', '22.70', '22.69'] },
  } } }) };
  const noSleep = () => Promise.resolve();

  await atest('分时：东财首次就成功 → 不走兜底', async () => {
    let txCalls = 0;
    const r = await trends.fetchTrends('1.600026', {
      sleepFn: noSleep,
      fetchImpl: async (u) => { if (String(u).includes('ifzq.gtimg.cn')) { txCalls += 1; return TX_MIN; } return EM_TRENDS; },
    });
    assert.strictEqual(r.source, 'eastmoney');
    assert.strictEqual(r.points.length, 2);
    assert.strictEqual(r.preClose, 22.7);
    assert.strictEqual(r.points[1].t, '09:31');
    assert.strictEqual(txCalls, 0);
  });

  await atest('分时：东财连续失败 → 重试 3 次后切腾讯兜底（均价用 VWAP 还原）', async () => {
    let emCalls = 0;
    const r = await trends.fetchTrends('1.600026', {
      sleepFn: noSleep,
      fetchImpl: async (u) => {
        if (String(u).includes('ifzq.gtimg.cn')) return TX_MIN;
        emCalls += 1;
        throw new Error('net::ERR_EMPTY_RESPONSE');
      },
    });
    assert.strictEqual(emCalls, 3, '东财应重试到 3 次');
    assert.strictEqual(r.source, 'tencent');
    assert.strictEqual(r.points.length, 2);
    assert.strictEqual(r.preClose, 22.70);
    assert.ok(Math.abs(r.points[1].avg - 22.556) < 0.01, 'VWAP 应≈22.556，实际 ' + r.points[1].avg);
  });

  await atest('分时：两个源都挂才报错（界面才会显示失败）', async () => {
    let threw = false;
    try {
      await trends.fetchTrends('1.600026', { sleepFn: noSleep, fetchImpl: async () => { throw new Error('down'); } });
    } catch (e) { threw = true; }
    assert.ok(threw);
  });

  await atest('分时：非 A 股 secid 无腾讯符号 → 不误兜底，东财失败即报错', async () => {
    let threw = false;
    try {
      await trends.fetchTrends('105.AAPL', {
        sleepFn: noSleep,
        fetchImpl: async (u) => { if (String(u).includes('ifzq.gtimg.cn')) return TX_MIN; throw new Error('down'); },
      });
    } catch (e) { threw = true; }
    assert.ok(threw);
  });

  /* ---- [9] 按分组记忆排序（切分组恢复该组上次的排序） ---- */
  console.log('\n[9] 按分组记忆排序');

  await atest('排序记忆：first 解析为第一个云分组，各组各自记住、互不串扰', () => {
    const orch = mkOrch();
    orch.groups = [{ gid: 'g1', gname: '自选股', stocks: [] }, { gid: 'g2', gname: '白酒', stocks: [] }];
    const src = orch.settings.data.source;

    src.activeGroup = 'first';
    assert.strictEqual(orch.sortKey(), 'g1'); // first → 实际第一个云分组
    src.groupSorts = orch.rememberSort('pct-desc');

    assert.strictEqual(orch.sortForGroup('g2'), 'default'); // g2 没动过 → 默认原序
    src.activeGroup = 'g2';
    src.groupSorts = orch.rememberSort('price-desc');

    assert.strictEqual(orch.sortForGroup('g1'), 'pct-desc');
    assert.strictEqual(orch.sortForGroup('g2'), 'price-desc');
    assert.strictEqual(orch.sortForGroup('__positions__'), 'default');
    assert.strictEqual(orch.sortForGroup('all'), 'default');
  });

  await atest('排序记忆：manual 无云分组时 first → default 键（老配置无 groupSorts 也不炸）', () => {
    const orch = mkOrch();
    const src = orch.settings.data.source;
    src.activeGroup = 'first';
    assert.strictEqual(orch.sortKey(), 'default');
    src.groupSorts = orch.rememberSort('pct-asc');
    assert.strictEqual(orch.sortForGroup('default'), 'pct-asc');
  });

  /* ---- [10] 个股股价提醒（到价即发并移除，仅盘中） ---- */
  console.log('\n[10] 个股股价提醒');

  await atest('股价提醒：规则股并入行情拉取（不在当前分组也能查到价）', () => {
    const orch = mkOrch();
    orch.settings.data.alerts.priceRules = [
      { id: 'a', m: 'SH', c: '600000', op: 'gte', price: 10 },
      { id: 'b', m: 'US', c: 'AAPL', op: 'lte', price: 100 },
      { id: 'c', m: 'SH', c: '600000', op: 'lte', price: 9 }, // 同股去重条目
    ];
    const entries = orch.priceRuleEntries();
    assert.deepStrictEqual(entries.map((e) => e.secid), ['1.600000', '105.AAPL']);
  });

  await atest('股价提醒：持续有效——突破提醒一次不轰炸；回落后重新布防再触发，规则不删除', () => {
    const orch = mkOrch();
    orch.phase = 'open';
    orch.settings.set = (patch) => { orch.settings.data.alerts.priceRules = patch.alerts.priceRules; };
    orch.settings.data.alerts.priceRules = [
      { id: 'a', m: 'SH', c: '600026', op: 'gte', price: 5.0 },
      { id: 'b', m: 'SH', c: '600026', op: 'lte', price: 3.0 },
    ];
    const events = [];
    orch.on('pricealert', (a) => events.push(a.op + '@' + a.price));
    const tick = (price) => orch.checkPriceRules(new Map([['1.600026', { name: '宁波港', price, suspended: false }]]));
    tick(4.0);                                   // 未到价：不触发
    assert.deepStrictEqual(events, []);
    tick(5.5);                                   // 突破上沿：触发一次
    assert.deepStrictEqual(events, ['gte@5.5']);
    tick(5.6); tick(6.0);                        // 持续在上方：不重复轰炸
    assert.strictEqual(events.length, 1);
    tick(4.5);                                   // 回到条件外：重新布防
    tick(5.2);                                   // 再次突破：再触发
    assert.deepStrictEqual(events, ['gte@5.5', 'gte@5.2']);
    tick(3.0);                                   // 下沿同理：触发一次
    tick(2.9);
    assert.deepStrictEqual(events, ['gte@5.5', 'gte@5.2', 'lte@3']);
    assert.strictEqual(orch.settings.data.alerts.priceRules.length, 2, '规则不删除，一直有效');
  });

  await atest('股价提醒：非盘中/停牌/无价不触发', () => {
    const orch = mkOrch();
    let fired = 0;
    orch.on('pricealert', () => { fired += 1; });
    orch.settings.data.alerts.priceRules = [{ id: 'a', m: 'SH', c: '600026', op: 'gte', price: 5.0 }];
    orch.phase = 'closed';
    orch.checkPriceRules(new Map([['1.600026', { name: '宁波港', price: 5.5 }]]));
    assert.strictEqual(fired, 0);
    orch.phase = 'open';
    orch.checkPriceRules(new Map([['1.600026', { name: '宁波港', price: 5.5, suspended: true }]]));
    assert.strictEqual(fired, 0);
    orch.checkPriceRules(new Map([['1.600026', { name: '宁波港', price: null }]]));
    assert.strictEqual(fired, 0);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
});
