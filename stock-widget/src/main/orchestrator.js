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
const session = require('../core/session');
const { backoffDelay } = require('../core/retry');
const parser = require('../core/code-parser');
const { INDEX_SECIDS, INDEX_SHORT_NAMES } = require('../shared/constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    this._alertDate = '';
    this._alertSent = new Set();
    this._summaryDate = '';

    this.quoteTimer = null;
    this.watchTimer = null;
    this._snapshotSaveTimer = null;
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
    this.scheduleQuote(0);
    this.scheduleWatch(0);
  }

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
    if (signature === this.lastSignature) {
      this.noChangeCount += 1;
      if (this.noChangeCount >= 6 && this.phase === 'open') this.adaptiveSlow = true;
    } else {
      this.noChangeCount = 0;
      this.adaptiveSlow = false;
    }
    this.lastSignature = signature;

    this.emitState(entries, map);
    this.saveSnapshot(entries, map);
    this.checkAlerts(this._lastGood ? this._lastGood.rows : []);
    this.checkPriceRules(map);
    this.maybeSummary(this._lastGood ? this._lastGood.rows : []);

    const interval = session.suggestedInterval(this.phase, s.behavior.refreshInterval, this.adaptiveSlow);
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
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.tickWatch().catch((e) => this.log.error('tickWatch crash', e && e.message));
    }, ms);
  }

  async tickWatch() {
    const s = this.settings.get();
    try {
      if (s.source.mode === 'cloud') {
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

  /* ---------------- 摸鱼：异动预警 + 收盘战报 ---------------- */

  /** 自选涨跌幅越过阈值 → emit('alert')。每方向每日每只一次，防轰炸。
 *  仅盘中（open/auction）触发：收盘后重启不重发当日提醒。 */
  checkAlerts(rows) {
    const a = this.settings.get().alerts;
    if (!a || !a.enabled || !Array.isArray(rows)) return;
    if (this.phase !== 'open' && this.phase !== 'auction') return;
    const today = new Date().toISOString().slice(0, 10);
    if (this._alertDate !== today) {
      this._alertDate = today;
      this._alertSent = new Set();
    }
    for (const r of rows) {
      if (!r || r.suspended || r.pct == null || !Number.isFinite(r.pct)) continue;
      if (Math.abs(r.pct) < a.threshold) continue;
      const key = r.market + r.code + (r.pct > 0 ? '+' : '-');
      if (this._alertSent.has(key)) continue;
      this._alertSent.add(key);
      this.emit('alert', { name: r.name, code: r.code, pct: r.pct, price: r.price, market: r.market });
      this.log.info('异动提醒: ' + r.name + ' ' + (r.pct > 0 ? '+' : '') + r.pct.toFixed(2) + '%');
    }
  }

  /** 股价提醒涉及的自选（可能不在当前分组）：换算 secid 供行情拉取并入 */
  priceRuleEntries() {
    const rules = (this.settings.get().alerts || {}).priceRules;
    if (!Array.isArray(rules)) return [];
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

  /** 个股股价提醒：持续有效（直到用户删除）。突破到价 → emit('pricealert') 一次；
   *  回到条件外自动重新布防（hit 复位），再次突破再提醒——不轰炸也不漏。
   *  仅盘中检查；直接查全量行情 map：提醒股不在当前分组也能命中（拉取时已并入）。 */
  checkPriceRules(map) {
    const rules = (this.settings.get().alerts || {}).priceRules;
    if (!Array.isArray(rules) || !rules.length || !(map instanceof Map)) return;
    if (this.phase !== 'open' && this.phase !== 'auction') return; // 非盘中不用旧数据误报
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

  /** 15:05–15:59 收盘战报，每日一次；周末不发。 */
  maybeSummary(rows) {
    const a = this.settings.get().alerts;
    if (!a || !a.summary || !Array.isArray(rows) || !rows.length) return;
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return;
    if (this.phase !== 'closed') return;
    if (now.getHours() !== 15 || now.getMinutes() < 5) return;
    const today = now.toISOString().slice(0, 10);
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
        if (prev) return { ...prev, secid: e.secid, cost: e.cost || null, star: e.star };
        return {
          market: e.market, code: e.code, secid: e.secid, name: e.code, price: null, prevClose: null,
          pct: null, chg: null, suspended: false, invalid: !map, star: e.star,
          cost: e.cost || null, pl: null,
        };
      }
      const cost = e.cost || null;
      const pl = q.price != null && cost ? +(((q.price - cost) / cost) * 100).toFixed(2) : null;
      return {
        market: e.market, code: e.code, secid: e.secid, name: (q.name || e.code).replace(/\s+/g, ''), price: q.price, prevClose: q.prevClose,
        pct: q.pct, chg: q.chg, suspended: q.suspended, invalid: false, star: e.star,
        cost, pl,
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

  emitState(entries, map) {
    const s = this.settings.get();
    const state = {
      mode: s.source.mode,
      loggedIn: this.loggedIn,
      groups: this.groups.map((g) => ({ gid: g.gid, gname: g.gname, count: g.stocks.length })),
      positionsCount: (s.source.positions || []).length,
      activeGroup: s.source.activeGroup,
      rows: this.buildRows(entries, map),
      indexes: this.buildIndexes(map),
      status: {
        code: this.statusCode(),
        source: this.source,
        phase: this.phase,
        phaseLabel: session.phaseLabel(this.phase),
        lastUpdate: this.lastUpdate,
        retryCount: this.consecFail,   // 展示用：当前源连续失败次数（不是累计重试次数）
        adaptive: this.adaptiveSlow,
      },
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

module.exports = { Orchestrator };
