'use strict';
/**
 * 轮询编排器（核心状态机）：
 *  - 行情：主源东财 → 同一 tick 内先快重试 → 连续 3 次失败切腾讯备源
 *          → 备源最短停留 60s 后才探活主源，连续 2 次成功才切回；探活失败则退避翻倍（上限 10 分钟），把来回横跳压下去
 *          （2026-10-14 实测：东财批量接口存在时间窗式风控，好窗口连续成功、坏窗口连续空响应，成功率 20%–60% 之间波动）
 *  - 时段感知 + 无变化自适应降速（替代写死节假日表，自纠错）
 *  - 云端自选：60s 轮询 myfavor；失败三分类（network / auth / api）
 *  - 快照：成功拉取即存，启动时先行恢复（离线也有界面）
 * 零窗口依赖（EventEmitter 输出），便于测试。
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const emQuote = require('../core/market/quote');
const txQuote = require('../core/market/tencent');
const myfavor = require('../core/sync/myfavor');
const { singleMove } = require('../core/sync/order-diff');
const session = require('../core/session');
const { backoffDelay } = require('../core/retry');
const parser = require('../core/code-parser');
const { INDEX_SECIDS, INDEX_SHORT_NAMES } = require('../shared/constants');

// 指数全名兜底（大盘异动提醒文案用）。注：本应放 constants.js，但该文件含一行公开
// token 字面量、整文件写入会被安全策略拦截，只能在此内联。
const INDEX_FULL_NAMES = { '1.000001': '上证指数', '0.399001': '深证成指', '0.399006': '创业板指' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本地日期键（YYYY-MM-DD）。toISOString 是 UTC，北京 00:00–08:00 会拿到「昨天」；
 *  用在每日去重键上会让翻转边界落在早上 8 点而非 0 点。 */
function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const QUOTE_ATTEMPTS = 3;               // 单 tick 内尝试次数（主源风控是时间窗式，隔几百毫秒再试常能落到好窗口）
const RETRY_GAPS_MS = [300, 900];       // 重试之间的间隔
const FAIL_THRESHOLD = 3;               // 连续失败多少个 tick 才切备源
const PROBATION_MS = 5 * 60 * 1000;     // 从备源切回主源后的观察期
const PROBATION_FAILS = 1;              // 观察期内再失败这么多个 tick 就退回备源（不干等 3 次）
const RECOVER_MIN_MS = 60 * 1000;       // 切到备源后的最短停留，这期间不探活主源
const RECOVER_MAX_MS = 10 * 60 * 1000;  // 探活退避上限
const RECOVER_CONFIRM = 2;              // 切回主源所需的连续探活成功次数
const RECOVER_GAP_MS = 10 * 1000;       // 连续探活之间的间隔

class Orchestrator extends EventEmitter {
  constructor({ settings, log, makeFetcher, snapshotFile, sleepFn }) {
    super();
    this.settings = settings;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.makeFetcher = makeFetcher || (() => null);
    this.snapshotFile = snapshotFile;
    this.sleep = sleepFn || sleep;   // 可注入（单测把重试/探活间隔变成立即返回）

    this.source = 'eastmoney';
    this.consecFail = 0;
    this.retryCount = 0;
    this.noChangeCount = 0;
    this.adaptiveSlow = false;
    this.phase = 'closed';
    this.lastUpdate = 0;
    this.lastSignature = '';
    this._lastGood = null;      // 上一次成功态（失败时沿用）

    this.groups = [];           // [{gid, gname, stocks:[{market,code,secid,star}]}]
    this.loggedIn = false;
    this.authFailCount = 0;
    this.writePending = 0;      // 云端写回进行中（轮询回声抑制用）
    this.writeChain = null;     // 串行写队列尾（一次只发一个写请求）

    this._alertDate = '';
    this._alertSent = new Set();
    this._summaryDate = '';
    this._swTicks = new Map();   // 急涨急跌滚动采样：m+c -> [[ts, price], ...]（内存态，重启重建）

    this.quoteTimer = null;
    this.watchTimer = null;
    this._snapshotSaveTimer = null;
    this._paused = false;                   // 窗口隐藏暂停（pauseWhenHidden）
    this.recoverAt = 0;                     // 下次允许探活主源的时间
    this.recoverInterval = RECOVER_MIN_MS;  // 探活退避间隔（探活失败一次翻倍）
    this.recovering = false;                // 探活进行中（避免并发探活）
    this.probationUntil = 0;                // 切回主源后的观察期截止时间
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    this.restoreSnapshot();
    this.scheduleQuote(400);
    this.scheduleWatch(1500);
  }

  stop() {
    clearTimeout(this.quoteTimer);
    clearTimeout(this.watchTimer);
    clearTimeout(this._snapshotSaveTimer);
  }

  force() {
    this._paused = false; // 托盘「刷新自选」是用户显式要求：即使处于隐藏暂停也放行
    this.scheduleQuote(0);
    this.scheduleWatch(0);
  }

  /** 窗口隐藏暂停（pauseWhenHidden）：停掉两个轮询（省电、少一条网络特征）；唤回 resume 立即刷新 */
  pause() {
    if (this._paused) return;
    this._paused = true;
    clearTimeout(this.quoteTimer);
    clearTimeout(this.watchTimer);
    this.log.info('行情轮询已暂停（窗口隐藏）');
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.scheduleQuote(0);
    this.scheduleWatch(0);
    this.log.info('行情轮询已恢复');
  }

  isPaused() { return !!this._paused; }

  /* ---------------- 按分组记忆排序 ---------------- */

  /** 分组排序记忆键：'first'/空 → 实际第一个云分组（无云分组时 cloud→all、manual→default） */
  sortKey(activeGroup) {
    const s = this.settings.get();
    let a = activeGroup != null ? String(activeGroup) : s.source.activeGroup;
    if (!a || a === 'first') {
      a = (this.groups && this.groups.length)
        ? String(this.groups[0].gid)
        : (s.source.mode === 'cloud' ? 'all' : 'default');
    }
    return a;
  }

  /** 改排序时记到当前分组名下：各分组互不串扰 */
  rememberSort(mode) {
    return { ...(this.settings.get().source.groupSorts || {}), [this.sortKey()]: String(mode) };
  }

  /** 切到某分组时恢复它自己上次的排序（没用过 = 默认原序） */
  sortForGroup(gid) {
    return (this.settings.get().source.groupSorts || {})[String(gid)] || 'default';
  }

  /* ---------------- 条目解析 ---------------- */

  currentEntries() {
    const s = this.settings.get();
    let entries = [];
    // 本地持仓（独立于手动/云端）：activeGroup = '__positions__'
    if (s.source.activeGroup === '__positions__' && (s.source.positions || []).length) {
      return s.source.positions
        .filter((p) => p && p.m && p.c)
        .map((p) => ({
          market: p.m, code: String(p.c),
          secid: p.s || (p.m === 'US' ? '105.' + p.c : parser.MARKET_SECID[p.m] + '.' + p.c),
          cost: p.cost || null, qty: p.qty || null, star: false,
        }));
    }
    if (s.source.mode === 'cloud' && this.loggedIn) {
      // 分组解析：all=合并 / first=第一个分组（东财式默认）/ 具体 gid
      let sel = s.source.activeGroup;
      if (sel === 'first' || sel == null) {
        sel = this.groups.length ? String(this.groups[0].gid) : 'all';
      }
      const stocks = sel === 'all'
        ? this.groups.flatMap((g) => g.stocks)
        : (this.groups.find((g) => String(g.gid) === String(sel)) || { stocks: [] }).stocks;
      const seen = new Set();
      for (const st of stocks) {
        const k = parser.keyOf(st);
        if (!seen.has(k)) { seen.add(k); entries.push(st); }
      }
      const order = s.source.localOrder || {};
      entries = entries.slice().sort((a, b) => {
        const ia = order[parser.keyOf(a)], ib = order[parser.keyOf(b)];
        if (ia != null && ib != null) return ia - ib;
        if (ia != null) return -1;
        if (ib != null) return 1;
        return 0;
      });
      entries.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0));
    } else {
      const stars = s.source.manualStars || {};
      entries = (s.source.manualList || [])
        .filter((e) => e && e.m && e.c)
        .map((e) => ({
          market: e.m, code: String(e.c),
          secid: e.s || (e.m === 'US' ? '105.' + e.c : parser.MARKET_SECID[e.m] + '.' + e.c),
          star: !!stars[e.m + e.c],
        }));
      entries.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0));
    }
    return entries;
  }

  /* ---------------- 行情轮询 ---------------- */

  scheduleQuote(ms) {
    if (this._paused) return;
    clearTimeout(this.quoteTimer);
    this.quoteTimer = setTimeout(() => {
      this.tickQuote().catch((e) => this.log.error('tickQuote crash', e && e.message));
    }, ms);
  }

  async tickQuote() {
    const s = this.settings.get();
    const entries = this.currentEntries();
    const markets = new Set(entries.map((e) => e.market));
    this.phase = session.marketPhase(new Date(), markets);
    // 股价提醒涉及的股票可能不在当前分组：并入拉取，否则永远查不到价
    const ruleEntries = this.priceRuleEntries();
    const secids = [...new Set([...entries.map((e) => e.secid), ...ruleEntries.map((e) => e.secid), ...INDEX_SECIDS])];

    const fetcher = this.source === 'eastmoney' ? emQuote.fetchQuotes : txQuote.fetchQuotes;
    const map = await this.fetchWithRetry(fetcher, secids);
    if (!map) {
      this.consecFail += 1;
      this.retryCount += 1;
      // 刚从备源切回的观察期内，再失败一次就退回备源（不再干等 3 次，也不反复给用户看异常）
      const threshold = Date.now() < this.probationUntil ? PROBATION_FAILS : FAIL_THRESHOLD;
      if (this.consecFail >= threshold && this.source === 'eastmoney') {
        this.source = 'tencent';
        this.consecFail = 0;
        this.recoverAt = Date.now() + this.recoverInterval;
        this.log.warn('主源连续失败，切换腾讯备源（' + Math.round(this.recoverInterval / 1000) + 's 后探活）');
        this.scheduleQuote(1500);
      } else {
        this.scheduleQuote(backoffDelay(this.retryCount));
      }
      // 2026-10 审查 A2：备源自身也在失败时（如美股为主的列表在腾讯侧恒为空响应），
      // 失败分支必须同样探活主源——此前探活只挂在成功分支，一旦切过去就永远回不来。
      if (this.source === 'tencent') {
        this.recoverMain(secids).catch((e) => this.log.warn('探活异常 ' + (e && e.message)));
      }
      this.emitState(entries, null);
      return;
    }

    // 成功：计数复位 + 自适应降速（疑似休市日/无波动 → 60s）
    this.consecFail = 0;
    this.retryCount = 0;
    this.lastUpdate = Date.now();
    const signature = INDEX_SECIDS.concat(entries.map((e) => e.secid))
      .map((id) => { const q = map.get(id); return id + ':' + (q ? q.price + ',' + q.pct : '-'); })
      .join('|');
    const changed = signature !== this.lastSignature; // 数据没变 → 后续只发轻量状态，不再全量广播
    if (!changed) {
      this.noChangeCount += 1;
      if (this.noChangeCount >= 6 && this.phase === 'open') this.adaptiveSlow = true;
    } else {
      this.noChangeCount = 0;
      this.adaptiveSlow = false;
    }
    this.lastSignature = signature;

    this.emitState(entries, map, !changed);
    if (changed) this.saveSnapshot(entries, map);
    this.checkAlerts(this._lastGood ? this._lastGood.rows : []);
    this.checkPriceRules(map);
    this.checkPctRules(map);
    this.checkSwRules(map);
    this.maybeSummary(this._lastGood ? this._lastGood.rows : []);

    let interval = session.suggestedInterval(this.phase, s.behavior.refreshInterval, this.adaptiveSlow);
    // 收盘后 10 分钟内保持 60s 心跳：15:05 收盘战报准时发出，之后再降到 15 分钟低频
    if (this.phase === 'closed') {
      const n = new Date();
      const mins = n.getHours() * 60 + n.getMinutes();
      if (n.getDay() !== 0 && n.getDay() !== 6 && mins >= 900 && mins < 910) {
        interval = Math.min(interval, 60000);
      }
    }
    this.scheduleQuote(interval);

    // 主源已平稳走过观察期 → 探活退避复位
    if (this.source === 'eastmoney' && this.probationUntil && Date.now() > this.probationUntil) {
      this.probationUntil = 0;
      if (this.recoverInterval !== RECOVER_MIN_MS) {
        this.recoverInterval = RECOVER_MIN_MS;
        this.log.info('主源已稳定，探活退避复位为 ' + Math.round(RECOVER_MIN_MS / 1000) + 's');
      }
    }
    // 备源期间按退避间隔探活主源（一有好窗口就切回、下轮又失败 → 反复横跳，所以必须滞回）
    if (this.source === 'tencent') {
      this.recoverMain(secids).catch((e) => this.log.warn('探活异常 ' + (e && e.message)));
    }
  }

  /**
   * 同一 tick 内快速重试：东财批量接口是时间窗式风控（好窗口连续成功、坏窗口连续空响应），
   * 隔几百毫秒再试往往就落到好窗口，于是不必计入失败也不必切备源。
   * @returns {Promise<Map|null>} 全部尝试都失败时返回 null
   */
  async fetchWithRetry(fetcher, secids) {
    for (let i = 0; i < QUOTE_ATTEMPTS; i++) {
      try {
        const map = await fetcher(secids);
        if (!secids.length || map.size) return map;
        throw new Error('empty response');
      } catch (e) {
        if (i === QUOTE_ATTEMPTS - 1) return null;
        await this.sleep(RETRY_GAPS_MS[Math.min(i, RETRY_GAPS_MS.length - 1)]);
      }
    }
    return null;
  }

  /**
   * 备源期间探活主源：跑真实的全量请求（等于预演一轮行情），连续 RECOVER_CONFIRM 次成功才切回。
   * 未通过则退避翻倍（60s → 120s → … → 10 分钟），让"切回—失败"的横跳越来越稀疏。
   */
  async recoverMain(secids) {
    if (this.recovering || this.source !== 'tencent') return;
    if (Date.now() < this.recoverAt) return;
    this.recovering = true;
    try {
      let ok = 0;
      for (let i = 0; i < RECOVER_CONFIRM; i++) {
        if (i) await this.sleep(RECOVER_GAP_MS);
        if (this.source !== 'tencent') return; // 期间已切回，放弃本轮
        const map = await this.fetchWithRetry(emQuote.fetchQuotes, secids);
        if (!map) break;
        ok += 1;
      }
      if (ok >= RECOVER_CONFIRM) {
        this.source = 'eastmoney';
        this.probationUntil = Date.now() + PROBATION_MS;
        this.consecFail = 0;
        this.retryCount = 0;
        this.log.info('主源连续 ' + ok + ' 次探活成功，切回东财（观察期 ' + Math.round(PROBATION_MS / 60000) + ' 分钟）');
        this.scheduleQuote(0);
        return;
      }
      this.recoverInterval = Math.min(this.recoverInterval * 2, RECOVER_MAX_MS);
      this.recoverAt = Date.now() + this.recoverInterval;
      this.log.warn('主源探活未通过（' + ok + '/' + RECOVER_CONFIRM + '），' + Math.round(this.recoverInterval / 1000) + 's 后再试');
    } finally {
      this.recovering = false;
    }
  }

  /* ---------------- 云端自选轮询 ---------------- */

  scheduleWatch(ms) {
    if (this._paused) return;
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.tickWatch().catch((e) => this.log.error('tickWatch crash', e && e.message));
    }, ms);
  }

  async tickWatch() {
    const s = this.settings.get();
    try {
      if (s.source.mode === 'cloud') {
        if (this.writePending > 0) {
          // 写回进行中：本轮不拉云态（旧云态会覆盖刚写入的乐观更新），
          // 写完成后会主动复拉（成功 2s / 失败立即），不会少拉
        } else {
          const fetcher = this.makeFetcher();
          if (fetcher) {
            const groups = await myfavor.groupList(fetcher);
            const stocks = [];
            for (const g of groups) {
              let list = [];
              try { list = await myfavor.groupStocks(fetcher, g.gid); }
              catch (e) { this.log.warn('gstkinfos 失败 gid=' + g.gid, e && e.message); }
              stocks.push({ gid: g.gid, gname: g.gname, stocks: list });
            }
            const before = JSON.stringify(this.groups);
            this.groups = stocks;
            if (!this.loggedIn) {
              this.loggedIn = true;
              this.emit('login', true);
            }
            this.authFailCount = 0;
            if (JSON.stringify(stocks) !== before) {
              this.log.info('云端自选已更新：' + stocks.map((g) => g.gname + '(' + g.stocks.length + ')').join('、'));
              this.scheduleQuote(200);
            }
            this.emit('groups', this.groups);
          } else if (this.loggedIn) {
            this.loggedIn = false;
            this.emit('login', false);
          }
        }
      }
    } catch (e) {
      if (e && e.kind === 'auth') {
        this.authFailCount += 1;
        if (this.authFailCount >= 2) {
          // 连续两次业务态失败 → 判定登录过期（先沿用快照显示）
          if (this.loggedIn) {
            this.loggedIn = false;
            this.emit('login', false);
            this.log.warn('云端自选登录态失效（连续 2 次非 0 状态）');
          }
        }
      } else if (e && e.kind === 'api') {
        this.log.error('自选接口结构异常（可能已变更）', e && e.message);
        this.emit('api-changed');
      } else {
        this.log.warn('自选同步网络错误', e && e.message);
      }
    }
    this.scheduleWatch(60000);
  }

  /** 登录窗成功回调 */
  onLoginSuccess() {
    this.loggedIn = true;
    this.authFailCount = 0;
    this.emit('login', true);
    this.scheduleWatch(0);
  }

  onLogout() {
    this.loggedIn = false;
    this.groups = [];
    this.emit('login', false);
    this.scheduleQuote(0);
  }

  /* ---------------- 云端写回（双向同步，2026-11-10 契约见 myfavor.js） ---------------- */

  /** key（如 SH600519）→ 包含该股的云分组列表 */
  groupsContaining(key) {
    return this.groups.filter((g) => (g.stocks || []).some((st) => parser.keyOf(st) === key));
  }

  /** 组内 key → secid（找不到返回 null） */
  secidInGroup(gid, key) {
    const g = this.groups.find((x) => String(x.gid) === String(gid));
    if (!g) return null;
    const st = (g.stocks || []).find((x) => parser.keyOf(x) === key);
    return st ? st.secid : null;
  }

  /** 串行写队列：一次只发一个写请求，防并发把云态写乱。
 *  永不 reject：并常一律转成 {re:false, message}（调用方只看 re）。 */
  enqueueWrite(run) {
    const task = async () => {
      this.writePending += 1;
      try {
        return await run();
      } catch (e) {
        this.log.warn('云端写回并常: ' + (e && e.message));
        return { re: false, message: (e && e.message) || '网络并常' };
      } finally {
        this.writePending -= 1;
      }
    };
    const p = (this.writeChain || Promise.resolve()).then(task, task);
    this.writeChain = p.catch(() => {});
    return p;
  }

  /** 加自选写回。目标分组：具体分组视图 → 该组；合并/首组视图 → 账号默认分组（asz）。
 *  返回 Promise<{re, dup?, message?}>。 */
  cloudWriteAdd({ market, code, secid }) {
    if (!this.loggedIn) return Promise.resolve({ re: false, message: '未登录，请先扫码登录' });
    const s = this.settings.get();
    const a = s.source.activeGroup;
    const key = market + code;
    const sc = secid || (market === 'US' ? '105.' + code : parser.MARKET_SECID[market] + '.' + code);
    let gid = null;
    let useDefault = a === 'all' || a === '__positions__'; // 合并/持仓视图 → 账号默认分组（asz）
    if (!useDefault) {
      gid = (!a || a === 'first')
        ? (this.groups.length ? String(this.groups[0].gid) : null)
        : String(a);
      if (!gid) useDefault = true; // 分组还没拉到 → 默认组兜底
    }
    // 重复检查（本地判断，不打接口）：asz 场景扫全部分组（账号里已有就不再加），
    // 具体分组场景只看目标组（在别的组里 ≠ 不能加到这个组）
    const dupHit = useDefault
      ? this.groups.some((g) => (g.stocks || []).some((st) => parser.keyOf(st) === key))
      : (() => {
        const g = gid != null ? this.groups.find((x) => String(x.gid) === String(gid)) : null;
        return !!g && (g.stocks || []).some((st) => parser.keyOf(st) === key);
      })();
    if (dupHit) return Promise.resolve({ re: true, dup: true });
    return this.enqueueWrite(async () => {
      const fetcher = this.makeFetcher();
      if (!fetcher) return { re: false, message: '未登录，请先扫码登录' };
      const r = useDefault ? await myfavor.addStockToDefault(fetcher, sc) : await myfavor.addStock(fetcher, gid, sc);
      if (r.re) {
        this.log.info('云端写回：添加 ' + market + code + (useDefault ? ' → 默认分组' : ' → 组 ' + gid));
        // 乐观更新：立即出现在列表（2s 后复拉以云态为准；asz 的真实落位也由复拉纠正）
        const targetGid = useDefault ? (this.groups.length ? String(this.groups[0].gid) : null) : gid;
        if (targetGid) {
          const g = this.groups.find((x) => String(x.gid) === targetGid);
          if (g && !(g.stocks || []).some((st) => parser.keyOf(st) === key)) {
            g.stocks = [...(g.stocks || []), { market, code, secid: sc, star: false }];
          }
        }
        this.emit('groups', this.groups);
        this.scheduleQuote(0);
        this.scheduleWatch(2000);
      } else {
        this.log.warn('云端写回添加失败: ' + (r.message || ''));
        this.emit('notice', { text: '添加未同步到东财：' + (r.message || '失败'), ms: 6000 });
        this.scheduleWatch(0);
      }
      return r;
    });
  }

  /** 删自选写回。gids 缺省 = 从包含它的全部分组移除。
 *  逐组串行；全部成功才乐观移除，部分失败 → 提示 + 立即复拉（云态为准）。 */
  cloudWriteDelete({ market, code, gids }) {
    if (!this.loggedIn) return Promise.resolve({ re: false, message: '未登录，请先扫码登录' });
    const key = market + code;
    const targets = (Array.isArray(gids) && gids.length
      ? gids
      : this.groupsContaining(key).map((g) => String(g.gid))
    ).map(String);
    if (!targets.length) return Promise.resolve({ re: false, message: '云端没有这只自选' });
    return this.enqueueWrite(async () => {
      const fetcher = this.makeFetcher();
      if (!fetcher) return { re: false, message: '未登录，请先扫码登录' };
      let okCount = 0;
      let lastMsg = '';
      for (const gid of targets) {
        const secid = this.secidInGroup(gid, key);
        if (!secid) { okCount += 1; continue; } // 已不在该组（云态已变）→ 视为成功
        try {
          const r = await myfavor.deleteStock(fetcher, gid, secid);
          if (r.re) okCount += 1; else lastMsg = r.message || '';
        } catch (e) { lastMsg = (e && e.message) || '网络并常'; }
      }
      const re = okCount === targets.length;
      if (re) {
        this.log.info('云端写回：删除 ' + key + ' × ' + targets.length + ' 组');
        for (const gid of targets) {
          const g = this.groups.find((x) => String(x.gid) === gid);
          if (g) g.stocks = (g.stocks || []).filter((st) => parser.keyOf(st) !== key);
        }
        this.emit('groups', this.groups);
        this.scheduleQuote(0);
        this.scheduleWatch(2000);
      } else {
        this.log.warn('云端写回删除失败: ' + lastMsg);
        this.emit('notice', { text: '删除未同步到东财' + (lastMsg ? '：' + lastMsg : ''), ms: 6000 });
        this.scheduleWatch(0);
      }
      return { re, message: lastMsg };
    });
  }

  /** 拖拽排序写回（仅具体分组视图；合并视图由调用方走本地序）。
 *  返回 'pushed'（已写回并清本地序）| 'fallback'（未写回，已存本地序兜底）。 */
  async cloudWriteSort({ keys, oldKeys }) {
    const gid = this.sortKey();
    const g = this.groups.find((x) => String(x.gid) === String(gid));
    const saveLocal = () => {
      const order = {};
      keys.forEach((k, i) => { order[k] = i; });
      this.settings.set({ source: { localOrder: order } });
    };
    if (!this.loggedIn || !g) { saveLocal(); return 'fallback'; }
    // diff + key→secid 映射；任一不成立（多元素变动/云态已变）→ 本地序兜底，不写回
    const mv = singleMove(oldKeys, keys);
    const sc = mv ? this.secidInGroup(gid, mv.key) : null;
    const prev = mv && mv.before ? this.secidInGroup(gid, mv.before) : '';
    const next = mv && mv.after ? this.secidInGroup(gid, mv.after) : '';
    if (!mv || !sc || (mv.before && !prev) || (mv.after && !next)) {
      saveLocal();
      return 'fallback';
    }
    const r = await this.enqueueWrite(() => this.makeFetcher()
      ? myfavor.sortStock(this.makeFetcher(), gid, sc, prev, next)
      : Promise.resolve({ re: false, message: '未登录，请先扫码登录' }));
    if (r.re) {
      this.log.info('云端写回：排序 ' + mv.key + ' → ' + (mv.before || '顶') + ' / ' + (mv.after || '底'));
      this.settings.set({ source: { localOrder: {} } }); // 云序为准，清本地序覆盖
      // 乐观重排该组为新显示序（置顶稳定排序重放后给果一致），2s 后复拉以云态为准
      const byKey = new Map((g.stocks || []).map((st) => [parser.keyOf(st), st]));
      const reordered = [];
      for (const k of keys) { const st = byKey.get(k); if (st) { reordered.push(st); byKey.delete(k); } }
      g.stocks = [...reordered, ...byKey.values()];
      this.emit('groups', this.groups);
      this.scheduleWatch(2000);
      return 'pushed';
    }
    this.log.warn('云端写回排序失败: ' + (r.message || '') + '（已保留本地顺序）');
    this.emit('notice', { text: '顺序未同步到东财' + (r.message ? '：' + r.message : '') + '，已保留本地顺序', ms: 6000 });
    saveLocal();
    this.scheduleWatch(0);
    return 'fallback';
  }

  /* ---------------- 摸鱼：异动预警 + 收盘战报 ---------------- */

  /** 自选涨跌幅越过阈值 → emit('alert')。每方向每日每只一次，防轰炸。
 *  仅盘中（open/auction）触发：收盘后重启不重发当日提醒。
 *  口径（alerts.basis）：daily=当日涨跌幅；pl=持仓盈亏 %（有成本才算，与持仓分组显示列一致，
 *  解决「列里显示 -15% 盈亏但提醒只看当日 +3%」的口径制裂）。
 *  大盘指数独立阈值（alerts.indexThreshold，0=关）：market='IX'，菜单栏用 ▲▲/▼▼ 独立信号位。 */
  checkAlerts(rows) {
    const a = this.settings.get().alerts;
    if (!a || !a.enabled || !Array.isArray(rows)) return;
    if (this.phase !== 'open' && this.phase !== 'auction') return;
    const today = localDateKey(new Date());
    if (this._alertDate !== today) {
      this._alertDate = today;
      this._alertSent = new Set();
    }
    const basisPl = a.basis === 'pl';
    // 个股专属异动阈值（pctRules，右键 → 预警设置）：设了某方向的股票，全局阈值在该方向让位，
    // 交给 checkPctRules 按专属阈值提醒；仅当日涨跌幅口径生效（pl 盈亏口径是另一回事，不让位）
    let custom = null;
    if (!basisPl && Array.isArray(a.pctRules) && a.pctRules.length) {
      custom = new Map();
      for (const pr of a.pctRules) {
        if (!pr || !pr.m || !pr.c) continue;
        const k = pr.m + pr.c;
        const cur = custom.get(k) || {};
        if (pr.op === 'lte') cur.dn = true; else cur.up = true;
        custom.set(k, cur);
      }
    }
    for (const r of rows) {
      if (!r || r.suspended || r.pct == null || !Number.isFinite(r.pct)) continue;
      const v = basisPl && r.cost != null && r.pl != null ? r.pl : r.pct;
      if (custom) {
        const cu = custom.get(r.market + r.code);
        if (cu && (v > 0 ? cu.up : cu.dn)) continue; // 该方向有专属规则，不再吃全局阈值
      }
      if (v == null || !Number.isFinite(v) || Math.abs(v) < a.threshold) continue;
      const key = r.market + r.code + (v > 0 ? '+' : '-');
      if (this._alertSent.has(key)) continue;
      this._alertSent.add(key);
      this.emit('alert', { name: r.name, code: r.code, pct: v, price: r.price, market: r.market });
      this.log.info('异动提醒: ' + r.name + ' ' + (v > 0 ? '+' : '') + v.toFixed(2) + '%' + (basisPl ? '（盈亏口径）' : ''));
    }
    const idxTh = Number(a.indexThreshold);
    if (Number.isFinite(idxTh) && idxTh > 0 && this._lastGood) {
      for (const ix of (this._lastGood.indexes || [])) {
        if (!ix || ix.pct == null || !Number.isFinite(ix.pct)) continue;
        if (Math.abs(ix.pct) < idxTh) continue;
        const key = 'IX' + ix.secid + (ix.pct > 0 ? '+' : '-');
        if (this._alertSent.has(key)) continue;
        this._alertSent.add(key);
        this.emit('alert', {
          name: ix.name || INDEX_FULL_NAMES[ix.secid] || '大盘指数',
          code: ix.secid, pct: ix.pct, price: ix.price, market: 'IX',
        });
        this.log.info('大盘异动提醒: ' + (ix.name || ix.secid) + ' ' + (ix.pct > 0 ? '+' : '') + ix.pct.toFixed(2) + '%');
      }
    }
  }

  /** 预警规则涉及的自选（到价 + 异动 + 急涨急跌，可能不在当前分组）：换算 secid 供行情拉取并入 */
  priceRuleEntries() {
    const a = this.settings.get().alerts || {};
    const rules = [
      ...(Array.isArray(a.priceRules) ? a.priceRules : []),
      ...(Array.isArray(a.pctRules) ? a.pctRules : []),
      ...(Array.isArray(a.swRules) ? a.swRules : []),
    ];
    const seen = new Set();
    const out = [];
    for (const r of rules) {
      if (!r || !r.m || !r.c) continue;
      const key = r.m + r.c;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ market: r.m, code: String(r.c), secid: r.m === 'US' ? '105.' + r.c : parser.MARKET_SECID[r.m] + '.' + r.c });
    }
    return out;
  }

  /** 预警冷却（防震荡连弹）：同一规则两次真正提醒的最小间隔 ms；缺省/非法 = 0（不冷却）。
 *  冷却期内的再次越过只吞边沿不弹（hit 照样置位）：价位在阈值附近一分钱反复磨时不再连弹，
 *  冷却期满后的一次真突破照常提醒。 */
  cooldownOf(a) {
    const v = Number(a && a.cooldownMs);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** 个股到价提醒：持续有效（直到用户删除）。突破到价 → emit('pricealert') 一次；
   *  回到条件外自动重新布防（hit 复位），再次突破再提醒——不轰炸也不漏；
   *  同一规则两次提醒间隔 ≥ 冷却时间（cooldownMs）。
   *  仅盘中检查；直接查全量行情 map：提醒股不在当前分组也能命中（拉取时已并入）。 */
  checkPriceRules(map, now = Date.now()) {
    const a = this.settings.get().alerts || {};
    const rules = a.priceRules;
    if (!Array.isArray(rules) || !rules.length || !(map instanceof Map)) return;
    if (this.phase !== 'open' && this.phase !== 'auction') return; // 非盘中不用旧数据误报
    const cd = this.cooldownOf(a);
    const secOf = new Map(this.priceRuleEntries().map((e) => [e.market + e.code, e.secid]));
    const hit = [];
    let changed = false;
    for (const rule of rules) {
      const secid = secOf.get(rule.m + rule.c);
      const q = secid ? map.get(secid) : null;
      const cond = !!(q && !q.suspended && q.price != null && Number.isFinite(q.price) &&
        (rule.op === 'lte' ? q.price <= rule.price : q.price >= rule.price));
      if (cond && !rule.hit) {
        rule.hit = true;      // 提醒一次后挂起，防每 5 秒轰炸
        changed = true;
        if (cd > 0 && now - (rule.lastAt || 0) < cd) continue; // 冷却期内：只吞边沿不弹
        rule.lastAt = now;
        hit.push({ rule, q });
      } else if (!cond && rule.hit) {
        rule.hit = false;     // 回到条件外：重新布防
        changed = true;
      }
    }
    if (!changed) return;
    this.settings.set({ alerts: { priceRules: rules } }); // 规则保留，只更新布防状态
    this.emit('settings-changed');
    for (const { rule, q } of hit) {
      this.emit('pricealert', {
        name: (q.name || rule.c).replace(/\s+/g, ''), code: rule.c, market: rule.m,
        price: q.price, op: rule.op, target: rule.price,
      });
      this.log.info(`股价提醒命中: ${q.name || rule.c} ${q.price} ${rule.op === 'gte' ? '≥' : '≤'} ${rule.price}`);
    }
  }

  /** 个股异动预警（右键 → 预警设置，参考东财/同花顺）：当日涨/跌幅越过专属阈值 →
 *  emit('pricealert', kind:'pct')。与到价提醒同机制：持续有效、突破提醒一次、
 *  回到阈值内自动重新布防，两次提醒间隔 ≥ 冷却时间；仅盘中检查。 */
  checkPctRules(map, now = Date.now()) {
    const a = this.settings.get().alerts || {};
    const rules = a.pctRules;
    if (!Array.isArray(rules) || !rules.length || !(map instanceof Map)) return;
    if (this.phase !== 'open' && this.phase !== 'auction') return; // 非盘中不用旧数据误报
    const cd = this.cooldownOf(a);
    const secOf = new Map(this.priceRuleEntries().map((e) => [e.market + e.code, e.secid]));
    const hit = [];
    let changed = false;
    for (const rule of rules) {
      const secid = secOf.get(rule.m + rule.c);
      const q = secid ? map.get(secid) : null;
      // pct 存正数：gte=涨幅超过 pct%；lte=跌幅超过 pct%（当日涨跌幅 ≤ -pct%）
      const cond = !!(q && !q.suspended && q.pct != null && Number.isFinite(q.pct) &&
        (rule.op === 'lte' ? q.pct <= -rule.pct : q.pct >= rule.pct));
      if (cond && !rule.hit) {
        rule.hit = true;      // 提醒一次后挂起，防每 5 秒轰炸
        changed = true;
        if (cd > 0 && now - (rule.lastAt || 0) < cd) continue; // 冷却期内：只吞边沿不弹
        rule.lastAt = now;
        hit.push({ rule, q });
      } else if (!cond && rule.hit) {
        rule.hit = false;     // 回到阈值内：重新布防
        changed = true;
      }
    }
    if (!changed) return;
    this.settings.set({ alerts: { pctRules: rules } }); // 规则保留，只更新布防状态
    this.emit('settings-changed');
    for (const { rule, q } of hit) {
      this.emit('pricealert', {
        kind: 'pct', name: (q.name || rule.c).replace(/\s+/g, ''), code: rule.c, market: rule.m,
        price: q.price, pct: q.pct, op: rule.op, target: rule.pct,
      });
      this.log.info(`异动预警命中: ${q.name || rule.c} 当日${rule.op === 'lte' ? '跌' : '涨'}幅 ${q.pct}% 越过${rule.op === 'lte' ? '≤-' : '≥'}${rule.pct}%`);
    }
  }

  /** 急涨急跌预警（右键 → 预警设置，时间窗，参考东财「快速拉升/下跌」）：N 分钟内涨/跌幅
 *  超过 X% → emit('pricealert', kind:'sw')。内存滚动采样（只采规则股，每 tick 一点），
 *  基线 = 窗口内最旧样本：重启/刚设置后样本不足不判定（宁漏勿误，没有历史价可比）。
 *  与到价/异动同机制：持续有效、触发一次挂起、回到阈值内重新布防，两次提醒间隔 ≥ 冷却时间。 */
  checkSwRules(map, now = Date.now()) {
    const a = this.settings.get().alerts || {};
    const rules = a.swRules;
    if (!Array.isArray(rules) || !rules.length || !(map instanceof Map)) {
      if (this._swTicks.size) this._swTicks.clear(); // 规则清空：缓冲一并释放
      return;
    }
    if (this.phase !== 'open' && this.phase !== 'auction') return; // 非盘中不采样不判定
    const cd = this.cooldownOf(a);
    // 1) 每股采样一个点，按该股最大窗口剪枝；规则已删的股票清缓冲
    const maxW = {};
    for (const r of rules) {
      if (!r || !r.m || !r.c) continue;
      const k = r.m + r.c;
      maxW[k] = Math.max(maxW[k] || 0, (Number(r.mins) || 5) * 60000);
    }
    for (const k of [...this._swTicks.keys()]) {
      if (!(k in maxW)) this._swTicks.delete(k);
    }
    const secOf = new Map(this.priceRuleEntries().map((e) => [e.market + e.code, e.secid]));
    const qOf = {};
    for (const k of Object.keys(maxW)) {
      let arr = this._swTicks.get(k) || [];
      const secid = secOf.get(k);
      const q = secid ? map.get(secid) : null;
      qOf[k] = q;
      if (q && !q.suspended && q.price != null && Number.isFinite(q.price) && q.price > 0) {
        if (arr.length && arr[arr.length - 1][0] === now) arr[arr.length - 1][1] = q.price; // 同刻覆盖
        else arr.push([now, q.price]);
      }
      arr = arr.filter((s) => now - s[0] <= maxW[k] + 60000); // 留 1 分钟余量
      if (arr.length) this._swTicks.set(k, arr);
      else this._swTicks.delete(k);
    }
    // 2) 判定：现价 vs 窗口内最旧样本的涨跌幅（窗口内的短时急动同样命中：2 分钟内涨够也算 5 分钟内涨够）
    const hit = [];
    let changed = false;
    for (const rule of rules) {
      if (!rule || !rule.m || !rule.c) continue;
      const arr = this._swTicks.get(rule.m + rule.c);
      if (!arr || arr.length < 2) continue; // 样本不足（刚设置/刚重启）：不判定
      const w = (Number(rule.mins) || 5) * 60000;
      let base = null;
      for (const s of arr) { if (now - s[0] <= w) { base = s; break; } }
      if (!base) continue;
      const cur = arr[arr.length - 1][1];
      const chg = ((cur - base[1]) / base[1]) * 100;
      const cond = rule.op === 'lte' ? chg <= -rule.pct : chg >= rule.pct;
      if (cond && !rule.hit) {
        rule.hit = true;        // 提醒一次后挂起，防每 5 秒轰炸
        changed = true;
        if (cd > 0 && now - (rule.lastAt || 0) < cd) continue; // 冷却期内：只吞边沿不弹
        rule.lastAt = now;
        hit.push({ rule, cur, chg });
      } else if (!cond && rule.hit) {
        rule.hit = false;       // 回到阈值内：重新布防
        changed = true;
      }
    }
    if (!changed) return;
    this.settings.set({ alerts: { swRules: rules } }); // 规则保留，只更新布防状态
    this.emit('settings-changed');
    for (const { rule, cur, chg } of hit) {
      const q = qOf[rule.m + rule.c];
      this.emit('pricealert', {
        kind: 'sw', name: ((q && q.name) || rule.c).replace(/\s+/g, ''), code: rule.c, market: rule.m,
        price: cur, pct: chg, op: rule.op, target: rule.pct, mins: Number(rule.mins) || 5,
      });
      this.log.info(`急涨急跌命中: ${(q && q.name) || rule.c} ${rule.mins} 分钟内${rule.op === 'lte' ? '跌' : '涨'}幅 ${chg.toFixed(2)}% 超过 ${rule.pct}%`);
    }
  }

  /** 15:05–15:59 收盘战报，每日一次；周末不发。now 可注入（单测）。 */
  maybeSummary(rows, now = new Date()) {
    const a = this.settings.get().alerts;
    if (!a || !a.summary || !Array.isArray(rows) || !rows.length) return;
    if (now.getDay() === 0 || now.getDay() === 6) return;
    if (this.phase !== 'closed') return;
    if (now.getHours() !== 15 || now.getMinutes() < 5) return;
    const today = localDateKey(now);
    if (this._summaryDate === today) return;
    this._summaryDate = today;
    const valid = rows.filter((r) => r && !r.suspended && r.pct != null && Number.isFinite(r.pct));
    if (!valid.length) return;
    const avg = valid.reduce((s, r) => s + r.pct, 0) / valid.length;
    const up = valid.filter((r) => r.pct > 0).length;
    const dn = valid.filter((r) => r.pct < 0).length;
    const sorted = valid.slice().sort((x, y) => y.pct - x.pct);
    this.emit('summary', {
      count: valid.length,
      avg,
      up,
      dn,
      flat: valid.length - up - dn,
      top: { name: sorted[0].name, pct: sorted[0].pct },
      bot: { name: sorted[sorted.length - 1].name, pct: sorted[sorted.length - 1].pct },
    });
  }

  /* ---------------- 状态输出 ---------------- */

  buildRows(entries, map) {
    return entries.map((e) => {
      const q = map ? map.get(e.secid) : null;
      if (!q) {
        const prev = this._lastGood && this._lastGood.rows.find((r) => r.market === e.market && r.code === e.code);
        if (prev) return { ...prev, secid: e.secid, cost: e.cost || null, qty: e.qty || null, star: e.star };
        return {
          market: e.market, code: e.code, secid: e.secid, name: e.code, price: null, prevClose: null,
          pct: null, chg: null, suspended: false, invalid: !map, star: e.star,
          cost: e.cost || null, qty: e.qty || null, pl: null, plAmt: null,
        };
      }
      const cost = e.cost || null;
      const qty = e.qty || null;
      const pl = q.price != null && cost ? +(((q.price - cost) / cost) * 100).toFixed(2) : null;
      // 盈亏金额（需同时有成本与数量；此前 qty 只存不用）——供持仓汇总与后续金额提醒
      const plAmt = q.price != null && cost != null && qty ? Math.round((q.price - cost) * qty) : null;
      return {
        market: e.market, code: e.code, secid: e.secid, name: (q.name || e.code).replace(/\s+/g, ''), price: q.price, prevClose: q.prevClose,
        pct: q.pct, chg: q.chg, suspended: q.suspended, invalid: false, star: e.star,
        cost, qty, pl, plAmt,
      };
    });
  }

  buildIndexes(map) {
    return INDEX_SECIDS.map((secid) => {
      const q = map ? map.get(secid) : (this._lastGood && this._lastGood.indexes.find((i) => i.secid === secid)) || null;
      return {
        secid,
        short: INDEX_SHORT_NAMES[secid] || (q && q.name ? q.name.slice(0, 1) : '·'),
        name: q ? q.name : '',
        price: q ? q.price : null,
        pct: q ? q.pct : null,
      };
    });
  }

  statusCode() {
    const s = this.settings.get();
    if (s.source.mode === 'cloud' && !this.loggedIn) return 'logged-out';
    if (this.consecFail > 0) return 'net-error';    // 当前源在失败：数据在变旧
    if (this.source === 'tencent') return 'backup';  // 备源供数正常：不是异常，只是走了备源
    return 'ok';
  }

  buildStatus() {
    return {
      code: this.statusCode(),
      source: this.source,
      phase: this.phase,
      phaseLabel: session.phaseLabel(this.phase),
      lastUpdate: this.lastUpdate,
      retryCount: this.consecFail,   // 展示用：当前源连续失败次数（不是累计重试次数）
      adaptive: this.adaptiveSlow,
      paused: !!this._paused,        // 隐藏暂停中（菜单栏数据时间标记用）
    };
  }

  emitState(entries, map, light = false) {
    const s = this.settings.get();
    const status = this.buildStatus();
    // 轻量推送：数据签名未变时（几百只自选下每 5s 的全量 IPC 序列化是性能大头），只发 status 补丁；
    // 轻量事件只发给主窗（设置窗需要完整结构），路由见 index.js
    if (light && this._lastGood) {
      this._lastGood.status = status;
      this.emit('state', { light: true, status });
      return;
    }
    const state = {
      mode: s.source.mode,
      loggedIn: this.loggedIn,
      groups: this.groups.map((g) => ({ gid: g.gid, gname: g.gname, count: g.stocks.length })),
      positionsCount: (s.source.positions || []).length,
      activeGroup: s.source.activeGroup,
      rows: this.buildRows(entries, map),
      indexes: this.buildIndexes(map),
      status,
      form: s.window.form,
    };
    if (map) this._lastGood = state;
    this.emit('state', state);
  }

  currentState() {
    return this._lastGood || null;
  }

  /* ---------------- 快照 ---------------- */

  saveSnapshot(entries, map) {
    if (!this.snapshotFile) return;
    clearTimeout(this._snapshotSaveTimer);
    this._snapshotSaveTimer = setTimeout(() => {
      try {
        const state = this._lastGood;
        if (!state) return;
        fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
        fs.writeFileSync(this.snapshotFile, JSON.stringify({
          time: Date.now(),
          rows: state.rows,
          indexes: state.indexes,
          groups: state.groups,
        }));
      } catch (e) { /* 快照失败不阻塞 */ }
    }, 15000);
  }

  restoreSnapshot() {
    try {
      if (!this.snapshotFile || !fs.existsSync(this.snapshotFile)) return;
      const j = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      if (!j || !Array.isArray(j.rows)) return;
      this._lastGood = {
        mode: this.settings.get().source.mode,
        loggedIn: false,
        groups: j.groups || [],
        activeGroup: this.settings.get().source.activeGroup,
        rows: j.rows,
        indexes: j.indexes || [],
        status: {
          code: 'ok', source: 'eastmoney', phase: 'closed', phaseLabel: '',
          lastUpdate: j.time || 0, retryCount: 0, adaptive: false,
        },
        form: this.settings.get().window.form,
      };
      this.emit('state', this._lastGood);
    } catch (e) { /* 快照损坏则忽略 */ }
  }
}

module.exports = { Orchestrator, localDateKey };
