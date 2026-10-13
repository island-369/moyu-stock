'use strict';
/**
 * 轮询编排器（核心状态机）：
 *  - 行情：主源东财 → 连续 3 次失败切腾讯备源 → 60s 内探活切回
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

class Orchestrator extends EventEmitter {
  constructor({ settings, log, makeFetcher, snapshotFile }) {
    super();
    this.settings = settings;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.makeFetcher = makeFetcher || (() => null);
    this.snapshotFile = snapshotFile;

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
    const secids = [...new Set([...entries.map((e) => e.secid), ...INDEX_SECIDS])];

    const fetcher = this.source === 'eastmoney' ? emQuote.fetchQuotes : txQuote.fetchQuotes;
    let map;
    try {
      map = await fetcher(secids);
      if (secids.length && !map.size) throw new Error('empty response');
    } catch (e) {
      this.consecFail += 1;
      this.retryCount += 1;
      if (this.consecFail >= 3 && this.source === 'eastmoney') {
        this.source = 'tencent';
        this.consecFail = 0;
        this.log.warn('主源连续失败，切换腾讯备源');
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
    this.maybeSummary(this._lastGood ? this._lastGood.rows : []);

    const interval = session.suggestedInterval(this.phase, s.behavior.refreshInterval, this.adaptiveSlow);
    this.scheduleQuote(interval);

    // 备源期间探活主源（用上证一只，代价极小）
    if (this.source === 'tencent') {
      emQuote.fetchQuotes(INDEX_SECIDS.slice(0, 1))
        .then((m) => {
          if (m.size && this.source === 'tencent') {
            this.source = 'eastmoney';
            this.log.info('主源恢复，切回东财');
            this.emitState(entries, map);
          }
        })
        .catch(() => { /* 仍不可用 */ });
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
    if (this.consecFail > 0 || this.retryCount > 0) return this.source === 'tencent' ? 'degraded' : 'net-error';
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
        retryCount: this.retryCount,
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
