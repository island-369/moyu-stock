'use strict';
/**
 * IPC 路由：渲染层唯一入口。网络、凭据、系统调用全部收在主进程。
 */
const { ipcMain, shell, clipboard, Menu, app } = require('electron');
const { DEFAULT_SHORTCUTS } = require('../shared/constants');
const { alertFormDefaults, upsertAlertRule } = require('../shared/alerts');
const { upsertPosition, positionDefaults } = require('../shared/positions');
const search = require('../core/market/search');
const trends = require('../core/market/trends');
const news = require('../core/market/news');
const parser = require('../core/code-parser');

const trendsCache = new Map(); // secid -> {ts, data}

function quoteUrl(row) {
  const m = row.market;
  if (m === 'HK') return 'https://quote.eastmoney.com/hk/' + row.code + '.html';
  if (m === 'US') return 'https://quote.eastmoney.com/us/' + row.code + '.html';
  return 'https://quote.eastmoney.com/' + m.toLowerCase() + row.code + '.html';
}

const VALID_MARKETS = ['SH', 'SZ', 'BJ', 'HK', 'US'];

function setupIpc(ctx) {
  const { settings, orch, log } = ctx;

  // 统一广播：复用 index.js 的实现（覆盖主窗 + 设置窗；D4：不再各自维护一套）
  const broadcast = ctx.broadcast;

  ipcMain.handle('app:boot', () => ({
    state: orch.currentState(),
    settings: settings.get(),
    penetrate: !!(ctx.getPenetrate && ctx.getPenetrate()),
  }));

  ipcMain.handle('app:search', async (_e, payload) => {
    try {
      const rows = await search.search(String((payload && payload.q) || ''));
      return { ok: true, rows };
    } catch (e) {
      log.warn('search failed', e && e.message);
      return { ok: false, rows: [] };
    }
  });

  ipcMain.handle('app:trends', async (_e, payload) => {
    const secid = String((payload && payload.secid) || '');
    if (!/^\d+\.[\w.]+$/.test(secid)) return { ok: false };
    const hit = trendsCache.get(secid);
    if (hit && Date.now() - hit.ts < 30000) return { ok: true, ...hit.data };
    try {
      const data = await trends.fetchTrends(secid);
      trendsCache.set(secid, { ts: Date.now(), data });
      if (trendsCache.size > 80) trendsCache.delete(trendsCache.keys().next().value);
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false };
    }
  });

  ipcMain.handle('app:news', async () => {
    try { return { ok: true, items: await news.fetchNews() }; }
    catch (e) { return { ok: false, items: [] }; }
  });

  ipcMain.handle('app:settings:set', (_e, payload) => {
    let patch = payload || {};
    // 排序按分组记忆：改排序时记到当前分组名下，切分组互不串扰
    if (patch.source && patch.source.sortMode != null && orch.rememberSort) {
      patch = { ...patch, source: { ...patch.source, groupSorts: orch.rememberSort(patch.source.sortMode) } };
    }
    // 纯外观补丁（浓度拖杆等高频）走防抖落盘（D12）；其余同步写
    const appearanceOnly = patch.appearance && Object.keys(patch).length === 1;
    const next = appearanceOnly ? settings.setSoon(patch) : settings.set(patch);
    broadcast('evt:settings', next);
    if (patch.shortcuts) ctx.reregisterShortcuts();
    if (patch.appearance) ctx.applyVibrancy();
    if (patch.behavior && patch.behavior.contentProtection != null && ctx.applyContentProtection) ctx.applyContentProtection();
    if (patch.behavior || patch.source) orch.scheduleQuote(300);
    if (patch.behavior && patch.behavior.dockIcon != null) ctx.setDockIcon(!!next.behavior.dockIcon);
    if (patch.behavior && patch.behavior.launchAtLogin != null) ctx.applyLoginItem();
    if (patch.behavior && patch.behavior.pauseWhenHidden != null && ctx.applyPausePolicy) ctx.applyPausePolicy();
    ctx.syncTray();
    return next;
  });

  ipcMain.handle('app:meeting', () => { ctx.toggleMeeting(); return { ok: true }; });

  /* ---------- 手动列表 ---------- */

  ipcMain.handle('app:list:add', (_e, p) => {
    const market = p && p.market;
    const code = p && String(p.code || '').toUpperCase();
    if (!market || !code || !VALID_MARKETS.includes(market)) return { ok: false, error: 'invalid' };
    const s = settings.get();
    // 持仓视图：加入本地持仓（无成本，右键「持仓成本 / 数量」补）。
    // 此前云端模式会误写回东财默认组、手动模式会写进 manualList——持仓视图下都看不见。
    if (s.source.activeGroup === '__positions__') {
      const list = s.source.positions || [];
      if (list.some((e) => e.m === market && e.c === code)) return { ok: true, dup: true, pos: true };
      const entry = { m: market, c: code };
      if (p.secid) entry.s = String(p.secid);
      settings.set({ source: { positions: [...list, entry] } });
      broadcast('evt:settings', settings.get()); // 设置窗持仓列表跟上
      orch.scheduleQuote(0);
      return { ok: true, pos: true };
    }
    // 云端模式：写回东财（当前分组视图 → 加到该组；合并视图 → 账号默认组）。
    // 旧行为（写进 manualList）在云端模式下不可见，等价无效，不再保留。
    if (s.source.mode === 'cloud') {
      if (!s.source.cloudWrite) {
        return { ok: false, error: 'cloud-readonly', message: '云端写回已关闭，可在设置 → 数据与自选中开启' };
      }
      if (!orch.loggedIn) {
        return { ok: false, error: 'login', message: '未登录，请先扫码登录东财' };
      }
      return orch.cloudWriteAdd({ market, code, secid: p.secid ? String(p.secid) : null })
        .then((r) => (r && r.re
          ? { ok: true, dup: !!r.dup }
          : { ok: false, error: 'cloud', message: (r && r.message) || '同步失败' }));
    }
    const list = s.source.manualList || [];
    if (list.some((e) => e.m === market && e.c === code)) return { ok: true, dup: true };
    const entry = { m: market, c: code };
    if (p.secid) entry.s = String(p.secid);
    settings.set({ source: { manualList: [...list, entry] } });
    orch.scheduleQuote(0);
    return { ok: true };
  });

  ipcMain.handle('app:list:remove', (_e, p) => {
    const key = (p && p.market) + String((p && p.code) || '').toUpperCase();
    const s = settings.get();
    const list = (s.source.manualList || []).filter((e) => (e.m + e.c) !== key);
    const stars = { ...(s.source.manualStars || {}) };
    delete stars[key];
    settings.set({ source: { manualList: list, manualStars: stars } });
    orch.scheduleQuote(0);
    return { ok: true };
  });

  ipcMain.handle('app:list:reorder', (_e, p) => {
    const keys = Array.isArray(p && p.keys) ? p.keys.map(String) : [];
    // 旧序（dragstart 捕获）：云端模式下用来推导「谁被拖到了哪」——ss? 写回只发增量，不发的全量
    const oldKeys = Array.isArray(p && p.oldKeys) ? p.oldKeys.map(String) : [];
    const s = settings.get();
    if (s.source.mode === 'cloud') {
      // 具体分组 + 写回开启 → 推到云端（云序为准）；合并视图 / 未登录 / 关闭写回 → 维持本地序
      const gid = orch.sortKey();
      const canPush = !!s.source.cloudWrite && orch.loggedIn && gid !== 'all' && orch.groups.length > 0;
      if (canPush) {
        orch.cloudWriteSort({ keys, oldKeys }).catch(() => {});
      } else {
        const order = {};
        keys.forEach((k, i) => { order[k] = i; });
        settings.set({ source: { localOrder: order } });
      }
    } else {
      const list = s.source.manualList || [];
      const byKey = new Map(list.map((e) => [e.m + e.c, e]));
      const next = [];
      for (const k of keys) { const e = byKey.get(k); if (e) { next.push(e); byKey.delete(k); } }
      for (const e of byKey.values()) next.push(e);
      settings.set({ source: { manualList: next } });
    }
    orch.scheduleQuote(0);
    return { ok: true };
  });

  ipcMain.handle('app:group:select', (_e, p) => {
    const gid = p && p.gid != null ? String(p.gid) : 'all';
    // 切分组时恢复该分组自己上次的排序（没用过 = 默认原序）
    settings.set({ source: { activeGroup: gid, sortMode: orch.sortForGroup(gid) } });
    broadcast('evt:settings', settings.get()); // 排序随分组变了，设置窗/眼睛面板要跟上
    orch.scheduleQuote(0);
    return { ok: true };
  });

  /* ---------- 个股预警（右键 → 预警设置）：到价 + 异动（涨/跌幅专属阈值） ---------- */

  ipcMain.handle('app:pricealert:add', (_e, p) => {
    const m = String((p && p.market) || '');
    const c = String((p && p.code) || '').toUpperCase();
    const op = p && p.op === 'lte' ? 'lte' : 'gte';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (p && p.kind === 'pct') {
      // 异动预警：涨幅超过 / 跌幅超过 X%（存正数，方向由 op 表达）
      const pct = Number(p && p.pct);
      if (!VALID_MARKETS.includes(m) || !c || !Number.isFinite(pct) || pct <= 0 || pct > 1000) {
        return { ok: false, error: 'invalid' };
      }
      const rules = (settings.get().alerts && settings.get().alerts.pctRules) || [];
      if (rules.some((r) => r.m === m && r.c === c && r.op === op && r.pct === pct)) {
        return { ok: true, dup: true };
      }
      // 同方向改值即更新（不叠多条）：表单每方向一个输入，旧值被新值替换
      settings.set({ alerts: { pctRules: upsertAlertRule(rules, { id, m, c, op, pct, ts: Date.now() }) } });
      broadcast('evt:settings', settings.get());
      return { ok: true };
    }
    if (p && p.kind === 'sw') {
      // 急涨急跌（时间窗）：N 分钟内涨/跌幅超过 X%（mins 分钟留空时渲染层已默认 5）
      const pct = Number(p && p.pct);
      const mins = Number(p && p.mins);
      if (!VALID_MARKETS.includes(m) || !c || !Number.isFinite(pct) || pct <= 0 || pct > 100
        || !Number.isFinite(mins) || mins <= 0 || mins > 240) {
        return { ok: false, error: 'invalid' };
      }
      const swRules = (settings.get().alerts && settings.get().alerts.swRules) || [];
      if (swRules.some((r) => r.m === m && r.c === c && r.op === op && r.pct === pct && r.mins === mins)) {
        return { ok: true, dup: true };
      }
      settings.set({ alerts: { swRules: upsertAlertRule(swRules, { id, m, c, op, pct, mins, ts: Date.now() }) } });
      broadcast('evt:settings', settings.get());
      return { ok: true };
    }
    const price = Number(p && p.price);
    if (!VALID_MARKETS.includes(m) || !c || !Number.isFinite(price) || price <= 0) {
      return { ok: false, error: 'invalid' };
    }
    const rules = (settings.get().alerts && settings.get().alerts.priceRules) || [];
    if (rules.some((r) => r.m === m && r.c === c && r.op === op && r.price === price)) {
      return { ok: true, dup: true };
    }
    settings.set({ alerts: { priceRules: upsertAlertRule(rules, { id, m, c, op, price, ts: Date.now() }) } });
    broadcast('evt:settings', settings.get());
    return { ok: true };
  });

  ipcMain.handle('app:pricealert:remove', (_e, p) => {
    const id = p && p.id;
    const cur = settings.get().alerts || {};
    const priceRules = (Array.isArray(cur.priceRules) ? cur.priceRules : []).filter((r) => r.id !== id);
    const pctRules = (Array.isArray(cur.pctRules) ? cur.pctRules : []).filter((r) => r.id !== id);
    const swRules = (Array.isArray(cur.swRules) ? cur.swRules : []).filter((r) => r.id !== id);
    settings.set({ alerts: { priceRules, pctRules, swRules } });
    broadcast('evt:settings', settings.get());
    return { ok: true };
  });

  // 列表滚动运行态镜像（渲染层为源头；右键菜单标签用）
  ipcMain.handle('app:autoscroll:set', (_e, p) => {
    if (ctx.setAutoscrollOn) ctx.setAutoscrollOn(!!(p && p.on));
    return { ok: true };
  });

  // 股价提醒屏上弹窗：拖动/点击命令 + 位置预览（提醒面板里「预览 / 调整弹窗位置」）
  ipcMain.handle('app:toast:cmd', (_e, p) => {
    if (ctx.toast) ctx.toast.handleCommand(p || {});
    return { ok: true };
  });
  ipcMain.handle('app:pricetoast:preview', () => {
    if (ctx.toast) {
      ctx.toast.showAlertToast({
        title: '股价提醒 · 预览',
        body: '拖动到合适位置，松手即记忆 · 点击打开小窗',
        accent: '#E5C24F',
      });
    }
    return { ok: true };
  });

  /* ---------- 登录 ---------- */

  ipcMain.handle('app:settings:open', () => { ctx.openSettingsWin(); return { ok: true }; });

  ipcMain.handle('app:penetrate', () => { ctx.togglePenetrate(); return { ok: true }; });

  ipcMain.handle('app:boss', () => { ctx.bossAction(); return { ok: true }; });

  ipcMain.handle('app:positions:import', (_e, p) => {
    const text = String((p && p.text) || '');
    const list = [...(settings.get().source.positions || [])];
    let added = 0;
    const invalid = [];
    for (const line of text.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/[\s,，]+/);
      const parsed = parser.parse(parts[0]);
      if (!parsed) { invalid.push(parts[0]); continue; }
      const key = parsed.market + parsed.code;
      const cost = parts[1] != null && Number(parts[1]) > 0 ? Number(parts[1]) : null;
      const qty = parts[2] != null && Number(parts[2]) > 0 ? Number(parts[2]) : null;
      const entry = { m: parsed.market, c: parsed.code, s: parsed.secid, cost, qty };
      const idx = list.findIndex((e) => e.m + e.c === key);
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      added++;
    }
    const patch = { source: { positions: list } };
    if (added > 0) patch.source.activeGroup = '__positions__';
    settings.set(patch);
    orch.scheduleQuote(0);
    return { ok: true, added, invalid };
  });

  ipcMain.handle('app:positions:set', (_e, p) => {
    // 单条 upsert（右键「加入持仓 / 持仓成本」弹窗保存）：成本/数量空 = 不记录
    const market = p && p.market;
    const code = p && String(p.code || '').toUpperCase();
    if (!market || !code || !VALID_MARKETS.includes(market)) return { ok: false, error: 'invalid' };
    const cost = Number(p && p.cost);
    const qty = Number(p && p.qty);
    const entry = {
      m: market, c: code,
      cost: Number.isFinite(cost) && cost > 0 ? cost : null,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : null,
    };
    if (p && p.secid) entry.s = String(p.secid);
    const s = settings.get();
    const existed = (s.source.positions || []).some((e) => e && e.m === market && e.c === code);
    settings.set({ source: { positions: upsertPosition(s.source.positions, entry) } });
    broadcast('evt:settings', settings.get()); // 设置窗持仓列表跟上
    orch.scheduleQuote(0);
    return { ok: true, added: !existed };
  });

  ipcMain.handle('app:positions:remove', (_e, p) => {
    if (!(p && p.market && p.code)) return { ok: false, error: 'invalid' };
    removePosition(p.market, p.code);
    return { ok: true };
  });

  ipcMain.handle('app:debug', (_e, p) => {
    log.info('[渲染层] ' + String((p && p.msg) || ''));
    return { ok: true };
  });

  ipcMain.handle('app:shortcuts:reset', () => {
    settings.set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
    ctx.reregisterShortcuts();
    broadcast('evt:settings', settings.get());
    broadcast('evt:notice', { text: '快捷键已恢复默认：⌥⇧H 隐身 · ⌥⇧S 显隐 · ⌥⇧X 穿透 · ⌥⇧M 会议模式 · ⌥⇧←→ 切分组 · ⌥⇧↑↓ 浓度' });
    log.info('快捷键已恢复默认');
    return { ok: true };
  });

  ipcMain.handle('app:bg:ctx', () => { ctx.bgContextMenu(); return { ok: true }; });

  ipcMain.handle('app:resize:start', (_e, p) => { ctx.startResizeSession((p && p.dir) || 'e'); return { ok: true }; });

  ipcMain.handle('app:resize:end', () => { ctx.stopResizeSession(); return { ok: true }; });

  ipcMain.handle('app:hide', () => { ctx.hideToBackground(); return { ok: true }; });

  ipcMain.handle('app:import', (_e, p) => {
    const text = String((p && p.text) || '');
    const s = settings.get();
    const list = [...(s.source.manualList || [])];
    const have = new Set(list.map((e) => e.m + e.c));
    const invalid = [];
    let addedCount = 0;
    for (const token of text.split(/[\s,;，；、]+/)) {
      const t = token.trim();
      if (!t) continue;
      const parsed = parser.parse(t) || parser.parse(t.replace(/^\d+[.\\/]*/, ''));
      if (!parsed) {
        if (t.length >= 4 && t.length <= 10) invalid.push(t);
        continue;
      }
      const key = parsed.market + parsed.code;
      if (have.has(key)) continue;
      have.add(key);
      const entry = { m: parsed.market, c: parsed.code };
      if (parsed.secid) entry.s = parsed.secid;
      list.push(entry);
      addedCount += 1;
    }
    settings.set({ source: { manualList: list } });
    orch.scheduleQuote(0);
    return { ok: true, addedCount, invalid };
  });

  ipcMain.handle('app:login:open', () => { ctx.openLogin(); return { ok: true }; });

  ipcMain.handle('app:login:logout', async () => { await ctx.doLogout(); return { ok: true }; });

  /* ---------- 窗口 ---------- */

  ipcMain.handle('app:win:form', (_e, p) => {
    const form = p && p.form === 'mini' ? 'mini' : 'full';
    ctx.setForm(form);
    return { ok: true };
  });

  ipcMain.handle('app:win:height', (_e, p) => {
    const h = Number(p && p.height);
    if (Number.isFinite(h)) ctx.setHeight(h);
    return { ok: true };
  });

  ipcMain.handle('app:win:expand', (_e, p) => {
    const h = Number(p && p.height);
    if (Number.isFinite(h)) ctx.expandForPopup(h);
    return { ok: true };
  });

  ipcMain.handle('app:popup:watch', (_e, p) => {
    ctx.setPopupWatch(!!(p && p.open));
    return { ok: true };
  });

  ipcMain.handle('app:settings:hide', () => {
    const w = ctx.getSettingsWin();
    if (w && !w.isDestroyed() && w.isVisible()) w.hide();
    return { ok: true };
  });

  ipcMain.handle('app:win:width', (_e, p) => {
    const w = Number(p && p.width);
    if (Number.isFinite(w)) ctx.setWidth(w);
    return { ok: true };
  });

  /* ---------- 右键菜单 / 外链 / 其他 ---------- */

  /** 持仓删除（右键菜单与 app:positions:remove 共用）：空了就退出持仓视图 */
  const removePosition = (market, code) => {
    const k = market + String(code || '').toUpperCase();
    const list = (settings.get().source.positions || []).filter((e) => (e.m + e.c) !== k);
    const patch = { source: { positions: list } };
    if (!list.length && settings.get().source.activeGroup === '__positions__') patch.source.activeGroup = 'first';
    settings.set(patch);
    broadcast('evt:settings', settings.get()); // 设置窗持仓列表跟上
    orch.scheduleQuote(0);
  };

  ipcMain.handle('app:ctx:menu', (_e, p) => {
    const key = String((p && p.key) || '');
    const st = orch.currentState();
    const row = st && st.rows.find((r) => r.market + r.code === key);
    if (!row) return { ok: false };
    const manual = settings.get().source.mode === 'manual';
    const src = settings.get().source;
    const posView = src.activeGroup === '__positions__';
    const posEntry = (src.positions || []).find((e) => e && e.m === row.market && e.c === row.code);
    const inPos = !!posEntry;
    const sendPosEdit = () => {
      const w = ctx.getMainWin();
      if (!w || w.isDestroyed()) return;
      const ex = positionDefaults(src.positions, row.market, row.code);
      w.webContents.send('evt:posedit', {
        market: row.market, code: row.code, name: row.name, price: row.price,
        exists: inPos, cost: ex.cost, qty: ex.qty,
        secid: posEntry && posEntry.s ? posEntry.s : (row.secid || null),
      });
    };
    const tpl = [
      { label: '复制代码（' + row.code + '）', click: () => clipboard.writeText(row.code) },
      {
        label: '复制名称与现价',
        enabled: row.price != null,
        click: () => clipboard.writeText(row.name + ' ' + (row.price != null ? row.price.toFixed(2) : '—')),
      },
      { type: 'separator' },
      { label: '在东方财富打开', click: () => ctx.openExternalUrl(quoteUrl(row)) },
      {
        // 预警设置（参考东财/同花顺右键预警）：到价 + 涨/跌幅异动，四项可同时设
        label: '预警设置…',
        click: () => {
          const w = ctx.getMainWin();
          if (w && !w.isDestroyed()) w.webContents.send('evt:pricealert', {
            market: row.market, code: row.code, name: row.name, price: row.price,
            // 回填已设预警（2026-10：此前每次打开都空表单，看不到旧值）
            existing: alertFormDefaults(settings.get().alerts, row.market, row.code),
          });
        },
      },
    ];
    // 持仓入口（手动 / 云端模式都有；本地记录，不碰云自选）
    if (inPos) {
      tpl.push(
        { type: 'separator' },
        { label: '持仓成本 / 数量…', click: sendPosEdit },
        ...(posView ? [{ label: '从持仓删除', click: () => removePosition(row.market, row.code) }] : []),
      );
    } else {
      tpl.push(
        { type: 'separator' },
        { label: '加入持仓（本地记录）…', click: sendPosEdit },
      );
    }
    if (manual && !posView) {
      tpl.push(
        { type: 'separator' },
        { label: row.star ? '取消置顶' : '置顶', click: () => ctx.setStar(key, !row.star) },
        { label: '从自选删除', click: () => ctx.removeStock(row) },
      );
    } else if (!manual) {
      // 云端模式：删除写回东财（写失败 → 黄条提示 + 复拉回滚，云数据为准）
      if (src.cloudWrite && orch.loggedIn) {
        const gIn = orch.groupsContaining(key);
        if (gIn.length === 1) {
          tpl.push(
            { type: 'separator' },
            { label: '从自选删除（' + gIn[0].gname + '）', click: () => { orch.cloudWriteDelete({ market: row.market, code: row.code }).catch(() => {}); } },
          );
        } else if (gIn.length > 1) {
          // 一只股在多个分组：列出各分组逐一删，或一次删干净
          tpl.push(
            { type: 'separator' },
            {
              label: '从自选删除',
              submenu: [
                ...gIn.map((g) => ({
                  label: '从「' + g.gname + '」删除',
                  click: () => { orch.cloudWriteDelete({ market: row.market, code: row.code, gids: [g.gid] }).catch(() => {}); },
                })),
                { type: 'separator' },
                {
                  label: '从全部分组删除（' + gIn.length + ' 处）',
                  click: () => { orch.cloudWriteDelete({ market: row.market, code: row.code }).catch(() => {}); },
                },
              ],
            },
          );
        }
      }
    }
    const menu = Menu.buildFromTemplate(tpl);
    const w = ctx.getMainWin();
    if (w && !w.isDestroyed()) menu.popup({ window: w });
    return { ok: true };
  });

  ipcMain.handle('app:open-external', (_e, p) => ctx.openExternalUrl(String((p && p.url) || '')));

  ipcMain.handle('app:refresh', () => { orch.force(); return { ok: true }; });

  ipcMain.handle('app:quit', () => { app.quit(); return { ok: true }; });
}

module.exports = { setupIpc, quoteUrl };
