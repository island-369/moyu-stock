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
const tx = require('../src/core/market/tencent');
const { Store, deepMerge } = require('../src/store/settings');
const { validBounds } = require('../src/shared/bounds');
const { alertFormDefaults, upsertAlertRule } = require('../src/shared/alerts');

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
test('周六 01:00 含 US → open（美股周五晚盘；2026-10 修复：原先被周末判断拦掉）', () => {
  const sat = new Date(2026, 9, 17, 1, 0); // 2026-10-17 周六
  assert.strictEqual(session.marketPhase(sat, new Set(['US'])), 'open');
});
test('周六 21:00 含 US → closed（美股周六休市）', () => {
  const sat = new Date(2026, 9, 17, 21, 0);
  assert.strictEqual(session.marketPhase(sat, new Set(['US'])), 'closed');
});
test('周日 22:00 含 US → closed', () => {
  const sun = new Date(2026, 9, 18, 22, 0); // 2026-10-18 周日
  assert.strictEqual(session.marketPhase(sun, new Set(['US'])), 'closed');
});
test('周二 02:00 含 US → open（美股周一晚盘跨夜）', () => {
  const tue = new Date(2026, 9, 20, 2, 0); // 2026-10-20 周二
  assert.strictEqual(session.marketPhase(tue, new Set(['US'])), 'open');
});
test('closed 心跳 15 分钟 / open 用户间隔 / 自适应 60s / lunch 30s', () => {
  assert.strictEqual(session.suggestedInterval('closed', 5000, false), 900000);
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
  const { Orchestrator, localDateKey } = require('../src/main/orchestrator');
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

  await atest('备源自身持续失败 → 失败分支同样探活主源（不再永久卡死，2026-10 修复 A2）', async () => {
    let emProbes = 0;
    globalThis.fetch = async (u) => {
      if (isEm(u)) { emProbes += 1; throw new Error('主源仍坏'); }
      throw new Error('备源也坏');
    };
    const orch = mkOrch();
    orch.source = 'tencent';
    orch.recoverAt = 0;
    await orch.tickQuote();
    await new Promise((r) => setTimeout(r, 20)); // recoverMain 是 fire-and-forget，等微任务跑完
    orch.stop();
    assert.strictEqual(orch.source, 'tencent');
    assert.ok(emProbes >= 1, '失败分支应尝试探活东财，实际 ' + emProbes + ' 次');
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

  /* ---- [10] 个股预警：到价 + 异动（持续有效，仅盘中） ---- */
  console.log('\n[10] 个股预警：到价 + 异动');

  await atest('预警规则股并入行情拉取（到价 + 异动两类，不在当前分组也能查到价）', () => {
    const orch = mkOrch();
    orch.settings.data.alerts.priceRules = [
      { id: 'a', m: 'SH', c: '600000', op: 'gte', price: 10 },
      { id: 'b', m: 'US', c: 'AAPL', op: 'lte', price: 100 },
      { id: 'c', m: 'SH', c: '600000', op: 'lte', price: 9 }, // 同股去重条目
    ];
    orch.settings.data.alerts.pctRules = [{ id: 'd', m: 'SZ', c: '300750', op: 'gte', pct: 3 }];
    orch.settings.data.alerts.swRules = [{ id: 'e', m: 'SH', c: '600519', op: 'gte', pct: 3, mins: 5 }];
    const entries = orch.priceRuleEntries();
    assert.deepStrictEqual(entries.map((e) => e.secid), ['1.600000', '105.AAPL', '0.300750', '1.600519']);
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

  await atest('异动预警：当日涨/跌幅越过专属阈值提醒一次，回到阈值内重新布防再触发', () => {
    const orch = mkOrch();
    orch.phase = 'open';
    orch.settings.set = (patch) => { orch.settings.data.alerts.pctRules = patch.alerts.pctRules; };
    orch.settings.data.alerts.pctRules = [
      { id: 'a', m: 'SH', c: '600026', op: 'gte', pct: 3 },
      { id: 'b', m: 'SH', c: '600026', op: 'lte', pct: 2 },
    ];
    const events = [];
    orch.on('pricealert', (a) => events.push(a.kind + ':' + a.op + ':' + a.pct));
    const tick = (pct) => orch.checkPctRules(new Map([['1.600026', { name: '宁波港', price: 5, pct, suspended: false }]]));
    tick(1.5);   // 未越过：不触发
    assert.deepStrictEqual(events, []);
    tick(3.2);   // 涨幅越过 3%：触发一次（kind=pct）
    assert.deepStrictEqual(events, ['pct:gte:3.2']);
    tick(3.5);   // 仍在线外：不轰炸
    assert.deepStrictEqual(events, ['pct:gte:3.2']);
    tick(2.8);   // 回到阈值内：重新布防
    tick(3.0);   // 再次越过：再提醒
    assert.deepStrictEqual(events, ['pct:gte:3.2', 'pct:gte:3']);
    tick(-2.5);  // 跌幅越过 2%：触发
    assert.deepStrictEqual(events, ['pct:gte:3.2', 'pct:gte:3', 'pct:lte:-2.5']);
    assert.strictEqual(orch.settings.data.alerts.pctRules.length, 2, '规则不删除，一直有效');
  });

  await atest('异动预警：非盘中/停牌/无涨跌幅不触发', () => {
    const orch = mkOrch();
    let fired = 0;
    orch.on('pricealert', () => { fired += 1; });
    orch.settings.data.alerts.pctRules = [{ id: 'a', m: 'SH', c: '600026', op: 'gte', pct: 3 }];
    orch.phase = 'closed';
    orch.checkPctRules(new Map([['1.600026', { name: '宁波港', price: 5, pct: 4 }]]));
    assert.strictEqual(fired, 0);
    orch.phase = 'open';
    orch.checkPctRules(new Map([['1.600026', { name: '宁波港', price: 5, pct: 4, suspended: true }]]));
    assert.strictEqual(fired, 0);
    orch.checkPctRules(new Map([['1.600026', { name: '宁波港', price: 5, pct: null }]]));
    assert.strictEqual(fired, 0);
  });

  await atest('急涨急跌：N 分钟内涨/跌超阈值提醒一次，回到阈值内重新布防', () => {
    const orch = mkOrch();
    orch.phase = 'open';
    orch.settings.set = (patch) => { orch.settings.data.alerts.swRules = patch.alerts.swRules; };
    orch.settings.data.alerts.swRules = [
      { id: 'a', m: 'SH', c: '600026', op: 'gte', pct: 3, mins: 5 },
      { id: 'b', m: 'SH', c: '600026', op: 'lte', pct: 2, mins: 1 },
    ];
    const events = [];
    orch.on('pricealert', (a) => events.push(a.kind + ':' + a.op + ':' + a.mins + ':' + a.pct.toFixed(1)));
    const T = new Date(2026, 9, 22, 10, 0, 0).getTime();
    const tick = (m, s, price) => orch.checkSwRules(
      new Map([['1.600026', { name: '宁波港', price, suspended: false }]]),
      T + m * 60000 + s * 1000,
    );
    tick(0, 0, 10.00);  // 首个样本：基线
    tick(2, 0, 10.10);  // +1%：不触发
    assert.deepStrictEqual(events, []);
    tick(4, 0, 10.35);  // 对 5 分钟窗基线 10.00 → +3.5%：触发一次
    assert.deepStrictEqual(events, ['sw:gte:5:3.5']);
    tick(4, 30, 10.40); // 仍在外：不轰炸
    assert.deepStrictEqual(events, ['sw:gte:5:3.5']);
    tick(5, 0, 10.10);  // gte 回到阈值内重新布防；同时 10.40→10.10 的回落本身就是 1 分钟内跌超 2% → lte 触发
    assert.deepStrictEqual(events, ['sw:gte:5:3.5', 'sw:lte:1:-2.4']);
    tick(7, 0, 10.50);  // gte 基线滑到 10:02 的 10.10 → +3.96%：再触发（验证已重新布防）
    assert.deepStrictEqual(events, ['sw:gte:5:3.5', 'sw:lte:1:-2.4', 'sw:gte:5:4.0']);
    tick(8, 0, 10.20);  // 1 分钟窗：对 10:07 的 10.50 → -2.9%：再次跌向触发（10:05 后已重新布防）
    assert.deepStrictEqual(events, ['sw:gte:5:3.5', 'sw:lte:1:-2.4', 'sw:gte:5:4.0', 'sw:lte:1:-2.9']);
    assert.strictEqual(orch.settings.data.alerts.swRules.length, 2, '规则不删除，一直有效');
  });

  await atest('急涨急跌：非盘中不判定；单样本（刚设置/刚重启）不触发，样本建立后正常判定', () => {
    const orch = mkOrch();
    let fired = 0;
    orch.on('pricealert', () => { fired += 1; });
    orch.settings.data.alerts.swRules = [{ id: 'a', m: 'SH', c: '600026', op: 'gte', pct: 3, mins: 5 }];
    const mk = (price) => new Map([['1.600026', { name: '宁波港', price, suspended: false }]]);
    orch.phase = 'closed';
    orch.checkSwRules(mk(11), 1000000); // 非盘中：不采样不判定
    assert.strictEqual(fired, 0);
    orch.phase = 'open';
    orch.checkSwRules(mk(11), 1000000); // 盘中首个样本：无基线可比，不触发（重启后不误报）
    assert.strictEqual(fired, 0);
    orch.checkSwRules(mk(11.5), 1300000); // 第二个样本起正常判定：+4.5% → 触发
    assert.strictEqual(fired, 1);
  });

  await atest('冷却防震荡：到价提醒冷却期内的再次到价被吞掉，期满后正常再提醒', () => {
    const orch = mkOrch();
    orch.phase = 'open';
    orch.settings.set = (patch) => { orch.settings.data.alerts.priceRules = patch.alerts.priceRules; };
    orch.settings.data.alerts.cooldownMs = 15 * 60 * 1000;
    orch.settings.data.alerts.priceRules = [{ id: 'a', m: 'SH', c: '600026', op: 'gte', price: 5 }];
    const events = [];
    orch.on('pricealert', (a) => events.push(a.price));
    const T = 1000000;
    const tick = (t, price) => orch.checkPriceRules(new Map([['1.600026', { name: '宁波港', price, suspended: false }]]), T + t);
    tick(0, 5.2);              // 首次到价：提醒
    tick(30 * 1000, 4.9);      // 回落重新布防
    tick(60 * 1000, 5.1);      // 冷却期内再次到价：吞掉不弹
    assert.deepStrictEqual(events, [5.2]);
    tick(90 * 1000, 4.8);      // 回落重新布防
    tick(16 * 60 * 1000, 5.3); // 冷却期满：正常再提醒
    assert.deepStrictEqual(events, [5.2, 5.3]);
    assert.strictEqual(orch.settings.data.alerts.priceRules[0].hit, true, '吞掉的边沿也置位，不逐 tick 重判');
  });

  await atest('冷却防震荡：急涨急跌同样受冷却约束（震荡边沿被吞）', () => {
    const orch = mkOrch();
    orch.phase = 'open';
    orch.settings.set = (patch) => { orch.settings.data.alerts.swRules = patch.alerts.swRules; };
    orch.settings.data.alerts.cooldownMs = 5 * 60 * 1000;
    orch.settings.data.alerts.swRules = [{ id: 'a', m: 'SH', c: '600026', op: 'gte', pct: 3, mins: 5 }];
    const events = [];
    orch.on('pricealert', () => events.push(1));
    const T = new Date(2026, 9, 22, 10, 0, 0).getTime();
    const m = (min, price) => orch.checkSwRules(new Map([['1.600026', { name: '宁波港', price, suspended: false }]]), T + min * 60000);
    m(0, 10.00);  // 基线
    m(2, 10.40);  // 对基线 +4%：提醒（lastAt = 10:02）
    m(3, 10.00);  // 回到阈值内：重新布防
    m(4, 10.45);  // 再次越过（+4.5%），冷却未满 → 吞掉不弹
    assert.deepStrictEqual(events, [1]);
    m(5, 10.00);  // 回落：重新布防
    m(8, 10.50);  // 窗口基线滑到 10:03 的 10.00 → +5%，冷却已满 → 再提醒
    assert.deepStrictEqual(events, [1, 1]);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  /* ---- [11] 异动提醒：口径 / 大盘指数 / 每日去重 / 收盘战报窗口 ---- */
  console.log('\n[11] 异动提醒：口径 / 大盘指数 / 每日去重 / 收盘战报');

  const alertsOrch = () => {
    const orch = mkOrch();
    orch.settings.data.alerts = { enabled: true, threshold: 5, summary: false, basis: 'daily', indexThreshold: 0 };
    orch.phase = 'open';
    return orch;
  };

  await atest('口径默认 daily：当日 +1% 不触发（即使持仓盈亏 -13.3%）', () => {
    const orch = alertsOrch();
    const fired = [];
    orch.on('alert', (a) => fired.push(a.market + a.code));
    orch.checkAlerts([{ market: 'SH', code: '600519', name: '贵州茅台', pct: 1, price: 1300, cost: 1500, pl: -13.3, suspended: false }]);
    assert.deepStrictEqual(fired, []);
  });

  await atest('口径 pl：按持仓盈亏判断（与持仓分组显示列一致）', () => {
    const orch = alertsOrch();
    orch.settings.data.alerts.basis = 'pl';
    const fired = [];
    orch.on('alert', (a) => fired.push(a.pct));
    orch.checkAlerts([{ market: 'SH', code: '600519', name: '贵州茅台', pct: 1, price: 1300, cost: 1500, pl: -13.3, suspended: false }]);
    assert.deepStrictEqual(fired, [-13.3]);
  });

  await atest('口径 pl：无成本的股票回落到当日涨跌幅', () => {
    const orch = alertsOrch();
    orch.settings.data.alerts.basis = 'pl';
    const fired = [];
    orch.on('alert', (a) => fired.push(a.pct));
    orch.checkAlerts([{ market: 'SH', code: '600000', name: '浦发银行', pct: 6.2, price: 9, cost: null, pl: null, suspended: false }]);
    assert.deepStrictEqual(fired, [6.2]);
  });

  await atest('专属异动阈值让位：设了某方向的股票，该方向不再走全局阈值；另一方向不受影响', () => {
    const orch = alertsOrch(); // 全局 threshold=5，daily 口径
    orch.settings.data.alerts.pctRules = [{ id: 'a', m: 'SH', c: '600519', op: 'gte', pct: 3 }];
    const fired = [];
    orch.on('alert', (a) => fired.push(a.market + a.code));
    // 涨幅方向有专属规则：即使越过全局 5% 也不走全局通道（交给 checkPctRules）
    orch.checkAlerts([{ market: 'SH', code: '600519', name: '贵州茅台', pct: 6, price: 1500, suspended: false }]);
    assert.deepStrictEqual(fired, []);
    // 跌幅方向没有专属规则：仍走全局阈值
    orch.checkAlerts([{ market: 'SH', code: '600519', name: '贵州茅台', pct: -6, price: 1400, suspended: false }]);
    assert.deepStrictEqual(fired, ['SH600519']);
    // 其他股票不受影响
    orch.checkAlerts([{ market: 'SZ', code: '300750', name: '宁德时代', pct: 6, price: 200, suspended: false }]);
    assert.deepStrictEqual(fired, ['SH600519', 'SZ300750']);
  });

  await atest('大盘指数：越过独立阈值触发 market=IX（独立信号位）；阈值 0 = 关', () => {
    const orch = alertsOrch();
    orch.settings.data.alerts.indexThreshold = 1.5;
    orch._lastGood = { indexes: [{ secid: '1.000001', name: '', price: 3100, pct: -2.1 }], rows: [] };
    const fired = [];
    orch.on('alert', (a) => fired.push(a.market + ':' + a.name + ':' + a.pct));
    orch.checkAlerts([]);
    assert.deepStrictEqual(fired, ['IX:上证指数:-2.1']);
    // 关掉阈值 → 不触发
    orch.settings.data.alerts.indexThreshold = 0;
    orch._alertDate = ''; orch._alertSent = new Set();
    fired.length = 0;
    orch.checkAlerts([]);
    assert.deepStrictEqual(fired, []);
  });

  await atest('每日去重键用本地日期（00:30 属于当天，而非 UTC 的昨天）', () => {
    assert.strictEqual(localDateKey(new Date(2026, 9, 18, 0, 30)), '2026-10-18');
    assert.strictEqual(localDateKey(new Date(2026, 9, 18, 23, 59)), '2026-10-18');
  });

  await atest('收盘战报：仅工作日 15:05–15:59 且收盘后发一次，同日不重复', () => {
    const orch = alertsOrch();
    orch.settings.data.alerts.summary = true;
    orch.phase = 'closed';
    const got = [];
    orch.on('summary', (s) => got.push(s));
    const rows = [
      { name: 'A', pct: 2, suspended: false },
      { name: 'B', pct: -1, suspended: false },
    ];
    orch.maybeSummary(rows, new Date(2026, 9, 19, 15, 10)); // 周一 15:10 → 发
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].count, 2);
    assert.strictEqual(got[0].up, 1);
    orch.maybeSummary(rows, new Date(2026, 9, 19, 15, 30)); // 同日第二次 → 不发
    assert.strictEqual(got.length, 1);
    orch.maybeSummary(rows, new Date(2026, 9, 17, 15, 10)); // 周六 → 不发
    orch.maybeSummary(rows, new Date(2026, 9, 19, 14, 50)); // 15:05 前 → 不发
    assert.strictEqual(got.length, 1);
  });

  /* ---- [12] 记忆位置校验（多显示器容差，纯函数） ---- */
  console.log('\n[12] 记忆位置校验（多显示器容差）');

  const DISPLAYS = [
    { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }, // 左侧外接屏（负坐标）
  ];
  test('主屏内的位置有效', () => {
    const b = validBounds({ x: 100, y: 80, width: 360, height: 520 }, DISPLAYS);
    assert.ok(b && b.x === 100);
  });
  test('副屏（负坐标）内的位置有效', () => {
    const b = validBounds({ x: -1900, y: 100, width: 360, height: 520 }, DISPLAYS);
    assert.ok(b && b.x === -1900);
  });
  test('拔掉外接屏后残留坐标 → null（回退默认位置）', () => {
    assert.strictEqual(validBounds({ x: 5000, y: 100, width: 360, height: 520 }, DISPLAYS), null);
  });
  test('宽高越界被钳制到允许区间（位置在大屏内、尺寸超上限）', () => {
    const big = [{ workArea: { x: 0, y: 0, width: 3840, height: 2130 } }]; // 4K 屏
    const b = validBounds({ x: 100, y: 80, width: 2000, height: 2000 }, big);
    assert.strictEqual(b.width, 1200);
    assert.strictEqual(b.height, 940);
  });
  test('窗口比所有屏都宽 → 位置无效（回退默认）', () => {
    assert.strictEqual(validBounds({ x: 100, y: 80, width: 2000, height: 520 }, DISPLAYS), null);
  });
  test('缺坐标 → null', () => {
    assert.strictEqual(validBounds({ width: 360, height: 520 }, DISPLAYS), null);
  });

  /* ---- [13] 预警表单回填与同方向更新（纯函数） ---- */
  console.log('\n[13] 预警表单回填与同方向更新');

  test('回填：三类规则各自的值进对应输入框', () => {
    const d = alertFormDefaults({
      priceRules: [{ id: 'a', m: 'SH', c: '600519', op: 'gte', price: 9.5, ts: 1 }],
      pctRules: [{ id: 'b', m: 'SH', c: '600519', op: 'lte', pct: 3, ts: 1 }],
      swRules: [{ id: 'c', m: 'SH', c: '600519', op: 'gte', pct: 2, mins: 10, ts: 1 }],
    }, 'SH', '600519');
    assert.strictEqual(d.gte, '9.5');
    assert.strictEqual(d.lte, '');
    assert.strictEqual(d.up, '');
    assert.strictEqual(d.dn, '3');
    assert.strictEqual(d.swUp, '2');
    assert.strictEqual(d.swUpMins, '10');
    assert.strictEqual(d.swDn, '');
    assert.strictEqual(d.swDnMins, '');
  });
  test('回填：同方向多条取最近一条（ts 最大）', () => {
    const d = alertFormDefaults({
      priceRules: [
        { id: 'a', m: 'SH', c: '600519', op: 'gte', price: 9.5, ts: 100 },
        { id: 'b', m: 'SH', c: '600519', op: 'gte', price: 10.2, ts: 200 },
      ],
    }, 'SH', '600519');
    assert.strictEqual(d.gte, '10.2');
  });
  test('回填：只匹配同一只股票，别的股票的规则不串合', () => {
    const d = alertFormDefaults({
      priceRules: [{ id: 'a', m: 'SZ', c: '000001', op: 'gte', price: 12, ts: 1 }],
    }, 'SH', '600519');
    assert.strictEqual(d.gte, '');
  });
  test('回填：无任何规则 → 全空（新股票首次设置）', () => {
    const d = alertFormDefaults({}, 'SH', '600519');
    assert.deepStrictEqual(d, { gte: '', lte: '', up: '', dn: '', swUp: '', swUpMins: '', swDn: '', swDnMins: '' });
  });
  test('upsert：同方向旧规则被新值替换（改值即更新，不叠多条）', () => {
    const rules = [
      { id: 'a', m: 'SH', c: '600519', op: 'gte', price: 9.5, ts: 100 },
      { id: 'b', m: 'SH', c: '600519', op: 'lte', price: 8, ts: 100 },
      { id: 'c', m: 'SZ', c: '000001', op: 'gte', price: 12, ts: 100 },
    ];
    const next = upsertAlertRule(rules, { id: 'd', m: 'SH', c: '600519', op: 'gte', price: 10.2, ts: 200 });
    assert.strictEqual(next.length, 3);
    assert.ok(next.some((r) => r.id === 'd' && r.price === 10.2)); // 新值在
    assert.ok(!next.some((r) => r.id === 'a'));                     // 旧 gte 9.5 被替换
    assert.ok(next.some((r) => r.id === 'b'));                      // 另一方向保留
    assert.ok(next.some((r) => r.id === 'c'));                      // 其他股票保留
  });
  test('upsert：空列表/非数组安全', () => {
    const next = upsertAlertRule(undefined, { id: 'x', m: 'SH', c: '600519', op: 'gte', price: 1 });
    assert.strictEqual(next.length, 1);
  });

  /* ---- [14] 云端写回（双向同步）：sc 转换 / 写 URL 构造 / 单步 diff / 队列与回滚 ---- */
  console.log('\n[14] 云端写回（双向同步）');

  const myfavor2 = require('../src/core/sync/myfavor');
  const { singleMove } = require('../src/core/sync/order-diff');
  const { FAVOR } = require('../src/shared/constants');

  // mock fetcher：记录 URL，按请求返回 JSONP（与生产端同形：cb 包裹）
  const mkFetcher = (reply) => {
    const calls = [];
    const fn = async (url) => {
      calls.push(String(url));
      const body = typeof reply === 'function' ? reply(String(url), calls.length) : reply;
      return 'jsonpcb(' + JSON.stringify(body) + ');';
    };
    fn.calls = calls;
    return fn;
  };
  const OK = { state: 0, message: '' };

  test('toSc：secid 的 . → $（含港股/美股/北交所）', () => {
    assert.strictEqual(myfavor2.toSc('1.600519'), '1$600519');
    assert.strictEqual(myfavor2.toSc('0.833171'), '0$833171');
    assert.strictEqual(myfavor2.toSc('116.00700'), '116$00700');
    assert.strictEqual(myfavor2.toSc('105.AAPL'), '105$AAPL');
    assert.strictEqual(myfavor2.toSc(''), '');
  });

  await atest('addStock：as? 带分组与 sc（URL 编码与生产端一致）', async () => {
    const f = mkFetcher(OK);
    const r = await myfavor2.addStock(f, 123, '1.600519');
    assert.ok(r.re);
    assert.strictEqual(f.calls.length, 1);
    const u = f.calls[0];
    assert.ok(u.startsWith(FAVOR.base + 'as?appkey=' + FAVOR.appkey + '&cb=jsonpcb&'), 'URL 前缀: ' + u);
    assert.ok(u.includes('g=123') && u.includes('sc=1%24600519'), '参数: ' + u);
  });

  await atest('addStockToDefault：asz? 无 g 参数', async () => {
    const f = mkFetcher(OK);
    await myfavor2.addStockToDefault(f, '116.00700');
    const u = f.calls[0];
    assert.ok(u.includes('/asz?'));
    assert.ok(!u.includes('g='), 'asz 不带分组: ' + u);
    assert.ok(u.includes('sc=116%2400700'));
  });

  await atest('deleteStock：ds? 带分组与 sc', async () => {
    const f = mkFetcher(OK);
    const r = await myfavor2.deleteStock(f, 456, '0.000001');
    assert.ok(r.re);
    assert.ok(f.calls[0].includes('/ds?') && f.calls[0].includes('g=456') && f.calls[0].includes('sc=0%24000001'));
  });

  await atest('sortStock：ss? 邻居参数（空串=顶/底边界）', async () => {
    const f = mkFetcher(OK);
    await myfavor2.sortStock(f, 789, '1.600519', '', '0.000001');
    const u = f.calls[0];
    assert.ok(u.includes('/ss?'));
    assert.ok(u.includes('sc=1%24600519'));
    assert.ok(u.includes('sc1=&sc2=0%24000001'), '空邻居应传空串: ' + u);
  });

  await atest('写失败：state!=0 → {re:false,message}，不抛异常', async () => {
    const f = mkFetcher({ state: 101, message: '股票已存在' });
    const r = await myfavor2.addStock(f, 1, '1.600519');
    assert.strictEqual(r.re, false);
    assert.strictEqual(r.message, '股票已存在');
  });

  test('singleMove：中部前拖 → 被拖元素 + 新邻居（同一结果可能有等价描述，任一合法即可）', () => {
    const r = singleMove(['A', 'B', 'C', 'D'], ['A', 'C', 'B', 'D']);
    assert.ok(r);
    // 两种等价描述都得到 [A,C,B,D]：B 放到 C/D 之间，或 C 放到 A/B 之间
    const ok1 = r.key === 'B' && r.before === 'C' && r.after === 'D';
    const ok2 = r.key === 'C' && r.before === 'A' && r.after === 'B';
    assert.ok(ok1 || ok2, '非法描述: ' + JSON.stringify(r));
  });
  test('singleMove：后拖（首元素拖到尾部）→ 邻居正确', () => {
    const r = singleMove(['A', 'B', 'C', 'D'], ['B', 'C', 'D', 'A']);
    assert.ok(r);
    assert.strictEqual(r.key, 'A');
    assert.strictEqual(r.before, 'D');
    assert.strictEqual(r.after, '');
  });
  test('singleMove：拖到顶 → before 为空串', () => {
    const r = singleMove(['A', 'B', 'C'], ['C', 'A', 'B']);
    assert.ok(r);
    assert.strictEqual(r.key, 'C');
    assert.strictEqual(r.before, '');
    assert.strictEqual(r.after, 'A');
  });
  test('singleMove：相邻互换也是单步（任取一种合法描述）', () => {
    const r = singleMove(['A', 'B'], ['B', 'A']);
    assert.ok(r && r.key && ((r.key === 'A' && r.before === 'B') || (r.key === 'B' && r.after === 'A')));
  });
  test('singleMove：原位拖放 → null（无操作）', () => {
    assert.strictEqual(singleMove(['A', 'B', 'C'], ['A', 'B', 'C']), null);
  });
  test('singleMove：多元素变动 → null（不写回）', () => {
    assert.strictEqual(singleMove(['A', 'B', 'C', 'D'], ['C', 'D', 'A', 'B']), null);
  });
  test('singleMove：集合不一致（云端已变）→ null', () => {
    assert.strictEqual(singleMove(['A', 'B', 'C'], ['A', 'B', 'X']), null);
    assert.strictEqual(singleMove(['A', 'B'], ['A', 'B', 'C']), null);
  });
  test('singleMove：非数组 / 空数组 → null', () => {
    assert.strictEqual(singleMove(null, ['A']), null);
    assert.strictEqual(singleMove([], []), null);
  });

  // ---- Orchestrator 层：写队列 / 乐观更新 / 回滚 ----

  const mkCloudOrch = (opts = {}) => {
    const sets = [];
    const data = {
      source: {
        mode: 'cloud',
        activeGroup: opts.activeGroup != null ? opts.activeGroup : 'first',
        sortMode: 'default', groupSorts: {}, localOrder: {}, cloudWrite: true,
        manualList: [], manualStars: {}, positions: [], filterStarred: false,
      },
      behavior: { refreshInterval: 5000 },
      alerts: { enabled: false, summary: false, threshold: 5 },
      window: { form: 'full' },
    };
    const orch = new Orchestrator({
      settings: {
        data,
        get() { return this.data; },
        set(p) { sets.push(p); this.data = deepMerge(this.data, p); },
      },
      log: { info() {}, warn() {}, error() {} },
      sleepFn: () => Promise.resolve(),
      makeFetcher: () => opts.fetcher || null,
    });
    orch.sets = sets;
    orch.loggedIn = true;
    orch.groups = [
      { gid: '10', gname: '自选股', stocks: [
        { market: 'SH', code: '600519', secid: '1.600519', star: false },
        { market: 'SZ', code: '000001', secid: '0.000001', star: false },
        { market: 'SH', code: '600026', secid: '1.600026', star: false },
      ] },
      { gid: '20', gname: '持仓', stocks: [
        { market: 'SH', code: '600519', secid: '1.600519', star: false },
      ] },
    ];
    return orch;
  };

  await atest('cloudWriteSort：单步拖拽 → ss? 写回 + 清 localOrder + 乐观重排', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f });
    const res = await orch.cloudWriteSort({
      keys: ['SH600026', 'SH600519', 'SZ000001'],
      oldKeys: ['SH600519', 'SZ000001', 'SH600026'],
    });
    orch.stop();
    assert.strictEqual(res, 'pushed');
    const u = f.calls[0];
    assert.ok(u.includes('/ss?') && u.includes('g=10'), '应写回当前分组: ' + u);
    assert.ok(u.includes('sc=1%24600026') && u.includes('sc1=&sc2=1%24600519'), '首拖到顶: ' + u);
    assert.ok(orch.sets.some((p) => p.source && p.source.localOrder && Object.keys(p.source.localOrder).length === 0), '写回成功后清本地序');
    assert.deepStrictEqual(orch.groups[0].stocks.map((s) => s.market + s.code), ['SH600026', 'SH600519', 'SZ000001'], '乐观重排');
  });

  await atest('cloudWriteSort：写失败 → 保留本地序兑底（回滚）', async () => {
    const f = mkFetcher({ state: 555, message: '系统繁忙' });
    const orch = mkCloudOrch({ fetcher: f });
    const res = await orch.cloudWriteSort({
      keys: ['SZ000001', 'SH600519'],
      oldKeys: ['SH600519', 'SZ000001'],
    });
    orch.stop();
    assert.strictEqual(res, 'fallback');
    assert.ok(orch.sets.some((p) => p.source && p.source.localOrder && p.source.localOrder.SH600519 === 1), '失败时保存本地序');
    assert.deepStrictEqual(orch.groups[0].stocks.map((s) => s.market + s.code), ['SH600519', 'SZ000001', 'SH600026'], '云数据不动');
  });

  await atest('cloudWriteSort：多元素变动 → 不写回，直接本地序', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f });
    const res = await orch.cloudWriteSort({
      keys: ['SH600026', 'SZ000001', 'SH600519'],
      oldKeys: ['SH600519', 'SZ000001', 'SH600026'],
    });
    orch.stop();
    assert.strictEqual(res, 'fallback');
    assert.strictEqual(f.calls.length, 0, 'diff 不成立就不发写请求');
  });

  await atest('cloudWriteAdd：具体分组视图 → as? 加到该组；dup 不打接口', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f, activeGroup: '20' });
    await orch.cloudWriteAdd({ market: 'SZ', code: '300750' });
    orch.stop();
    assert.ok(f.calls[0].includes('/as?') && f.calls[0].includes('g=20'), '加到当前分组: ' + f.calls[0]);
    assert.ok(orch.groups[1].stocks.some((s) => s.code === '300750'), '乐观加进组');
    // dup：再加一次同组同股 → 不发请求
    const f2 = mkFetcher(OK);
    const orch2 = mkCloudOrch({ fetcher: f2, activeGroup: '20' });
    const r = await orch2.cloudWriteAdd({ market: 'SH', code: '600519' });
    orch2.stop();
    assert.strictEqual(r.dup, true);
    assert.strictEqual(f2.calls.length, 0);
  });

  await atest('cloudWriteAdd：合并视图 → asz? 默认组；未登录 → 不发请求', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f, activeGroup: 'all' });
    await orch.cloudWriteAdd({ market: 'US', code: 'AAPL', secid: '105.AAPL' });
    orch.stop();
    assert.ok(f.calls[0].includes('/asz?') && f.calls[0].includes('sc=105%24AAPL'));
    const f2 = mkFetcher(OK);
    const orch2 = mkCloudOrch({ fetcher: f2 });
    orch2.loggedIn = false;
    const r = await orch2.cloudWriteAdd({ market: 'US', code: 'AAPL' });
    orch2.stop();
    assert.strictEqual(r.re, false);
    assert.strictEqual(f2.calls.length, 0);
  });

  await atest('cloudWriteAdd：合并视图查重扫全部分组（在任一组已有 → dup 不打接口）', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f, activeGroup: 'all' });
    // 600519 在组 20（非首组）里：合并视图下也算已存在
    const r = await orch.cloudWriteAdd({ market: 'SH', code: '600519' });
    orch.stop();
    assert.strictEqual(r.dup, true);
    assert.strictEqual(f.calls.length, 0);
  });

  await atest('cloudWriteAdd：具体分组查重只看目标组（在别的组里仍可加进这个组）', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f, activeGroup: '20' });
    // 000001 已在组 10、不在目标组 20：加到组 20 应照常发 as?（不是 dup）
    const r = await orch.cloudWriteAdd({ market: 'SZ', code: '000001' });
    orch.stop();
    assert.ok(!r.dup);
    assert.ok(f.calls[0].includes('/as?') && f.calls[0].includes('g=20'));
  });

  await atest('cloudWriteDelete：默认从全部分组移除，逐组 ds?', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f });
    const r = await orch.cloudWriteDelete({ market: 'SH', code: '600519' });
    orch.stop();
    assert.ok(r.re);
    assert.strictEqual(f.calls.length, 2, '两个分组各删一次');
    assert.ok(f.calls.every((u) => u.includes('/ds?') && u.includes('sc=1%24600519')));
    assert.ok(!orch.groups.some((g) => g.stocks.some((s) => s.code === '600519')), '乐观移除');
  });

  await atest('cloudWriteDelete：指定单组 → 只删那一组', async () => {
    const f = mkFetcher(OK);
    const orch = mkCloudOrch({ fetcher: f });
    await orch.cloudWriteDelete({ market: 'SH', code: '600519', gids: ['20'] });
    orch.stop();
    assert.strictEqual(f.calls.length, 1);
    assert.ok(f.calls[0].includes('g=20'));
    assert.ok(orch.groups[0].stocks.some((s) => s.code === '600519'), '另一组保留');
    assert.ok(!orch.groups[1].stocks.some((s) => s.code === '600519'));
  });

  await atest('写队列串行：两个写请求不并发（第二个等第一个完成）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const f = async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return 'jsonpcb(' + JSON.stringify(OK) + ');';
    };
    const orch = mkCloudOrch({ fetcher: f });
    const p1 = orch.cloudWriteDelete({ market: 'SH', code: '600519', gids: ['10'] });
    const p2 = orch.cloudWriteDelete({ market: 'SH', code: '600026', gids: ['10'] });
    await Promise.all([p1, p2]);
    orch.stop();
    assert.strictEqual(maxInFlight, 1, '写请求不应并发');
  });

  await atest('回声抑制：写进行中 tickWatch 不拉云态', async () => {
    // 读接口 mock：分组列表 + 组内股票（tickWatch 完整路径）
    const readReply = (u) => {
      if (u.includes('ggdefstkindexinfos')) {
        return { state: 0, data: { ginfolist: [{ gid: 10, gname: '自选股' }, { gid: 20, gname: '持仓' }] } };
      }
      return { state: 0, data: { stkinfolist: [{ security: '1$600519$1' }] } };
    };
    const f = mkFetcher(readReply);
    const orch = mkCloudOrch({ fetcher: f });
    orch.writePending = 1; // 模拟写进行中
    await orch.tickWatch();
    orch.stop();
    assert.strictEqual(f.calls.length, 0, '写进行中不应拉取云态');
    orch.writePending = 0;
    await orch.tickWatch();
    orch.stop();
    assert.ok(f.calls.length >= 3, '写完成后正常拉取（分组列表 + 各组），实际 ' + f.calls.length);
  });

  /* ---- [15] 本地持仓 upsert（右键加入持仓 / 持仓成本弹层） ---- */
  console.log('\n[15] 本地持仓增删改');

  const { upsertPosition, positionDefaults } = require('../src/shared/positions');

  test('upsert：新条目追加到尾部', () => {
    const next = upsertPosition([{ m: 'SH', c: '600519', cost: 1500 }], { m: 'SZ', c: '300750', cost: 210, qty: 100 });
    assert.strictEqual(next.length, 2);
    assert.deepStrictEqual(next[1], { m: 'SZ', c: '300750', cost: 210, qty: 100 });
  });
  test('upsert：同 (m,c) 整体替换（清空成本 = null 落盘）', () => {
    const next = upsertPosition(
      [{ m: 'SH', c: '600519', cost: 1500, qty: 200, s: '1.600519' }],
      { m: 'SH', c: '600519', cost: null, qty: null }
    );
    assert.strictEqual(next.length, 1);
    assert.deepStrictEqual(next[0], { m: 'SH', c: '600519', cost: null, qty: null, s: '1.600519' });
  });
  test('upsert：未提供 secid 时保留旧值（美股换组不丢市场号）', () => {
    const next = upsertPosition(
      [{ m: 'US', c: 'AAPL', s: '105.AAPL', cost: 180 }],
      { m: 'US', c: 'AAPL', cost: 190 }
    );
    assert.strictEqual(next[0].s, '105.AAPL');
    assert.strictEqual(next[0].cost, 190);
  });
  test('upsert：非数组安全（首次添加）', () => {
    const next = upsertPosition(undefined, { m: 'SH', c: '600519' });
    assert.strictEqual(next.length, 1);
  });
  test('positionDefaults：回填成本/数量，未设 = null，别的股票不串仓', () => {
    const list = [
      { m: 'SH', c: '600519', cost: 1500, qty: 200 },
      { m: 'US', c: 'AAPL', s: '105.AAPL' },
    ];
    assert.deepStrictEqual(positionDefaults(list, 'SH', '600519'), { cost: 1500, qty: 200 });
    assert.deepStrictEqual(positionDefaults(list, 'US', 'AAPL'), { cost: null, qty: null });
    assert.deepStrictEqual(positionDefaults(list, 'SZ', '300750'), { cost: null, qty: null });
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
});
