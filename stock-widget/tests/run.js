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
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
});
