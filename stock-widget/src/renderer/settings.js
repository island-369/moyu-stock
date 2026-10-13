'use strict';
/* 设置窗逻辑：读写全部经 IPC；evt:settings 广播回填 */

const $ = (s) => document.querySelector(s);

let settings = null;
let state = null;
let loggedIn = false;

const SC_NAMES = {
  boss: '老板键（隐身 / 呼出）',
  showhide: '显示 / 隐藏小窗',
  penetrate: '鼠标穿透开关',
  alphaUp: '背景浓度 +',
  alphaDown: '背景浓度 −',
  meeting: '会议模式（隐身 + 防录屏 + 静默）',
  groupPrev: '上一个分组',
  groupNext: '下一个分组',
};

async function boot() {
  if (typeof widget === 'undefined') return;
  const data = await widget.invoke('app:boot').catch(() => null);
  if (!data) return;
  settings = data.settings;
  state = data.state;
  loggedIn = !!(state && state.loggedIn);

  fillAll();
  wire();
  renderManualList();

  widget.on('evt:settings', (s) => {
    const focus = document.activeElement;
    const focusedId = focus && focus.id;
    settings = s;
    fillAll(focusedId);
  });
  widget.on('evt:state', (st) => {
    state = st;
    loggedIn = !!st.loggedIn;
    updateCloudState();
    renderManualList();
    renderPositions();
  });
  widget.on('evt:login', (ok) => {
    loggedIn = !!ok;
    updateCloudState();
  });
}

function fillAll(skipId) {
  const a = settings.appearance, b = settings.behavior, src = settings.source;
  const set = (id, v) => { const el = $(id); if (el && id !== '#' + skipId) el.value = v; };
  set('#theme', a.theme);
  set('#fontSize', a.fontSize);
  if (skipId !== 'bgAlpha') $('#bgAlpha').value = Math.round(a.bgAlpha * 100);
  $('#vibrancy').checked = !!a.vibrancy;
  $('#pulse').checked = !!a.pulse;
  $('#monoMode').checked = !!a.mono;
  set('#upColor', a.mono ? 'red' : a.upColor);
  $('#showCode').checked = !!a.showCode;
  $('#showIndexBar').checked = !!a.showIndexBar;
  $('#autoHeight').checked = !!a.autoHeight;
  $('#autoWidth').checked = !!a.autoWidth;
  set('#refreshInterval', String(b.refreshInterval));
  $('#newsEnabled').checked = !!b.newsEnabled;
  set('#bossKeyAction', b.bossKeyAction);
  $('#dockIcon').checked = !!b.dockIcon;
  $('#contentProtection').checked = !!b.contentProtection;
  $('#launchAtLogin').checked = !!b.launchAtLogin;
  const al = settings.alerts || {};
  $('#alertEnabled').checked = al.enabled !== false;
  set('#alertStyle', al.style || 'banner');
  $('#alertLowKey').checked = !!al.lowKey;
  set('#alertThreshold', String(al.threshold || 5));
  $('#summaryEnabled').checked = al.summary !== false;
  const sc = settings.source || {};
  set('#sortMode', sc.sortMode === 'pct' ? 'pct-desc' : (sc.sortMode || 'default'));
  updateModeSeg(src.mode);
  renderShortcuts();
  updateCloudState();
}

function updateModeSeg(mode) {
  document.querySelectorAll('#mode button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.v === mode);
  });
  $('#manualbox').hidden = mode !== 'manual';
  $('#cloudbox').hidden = mode === 'manual';
}

function updateCloudState() {
  const el = $('#cloudstate');
  if (settings && settings.source.mode !== 'cloud') { el.textContent = '—'; return; }
  if (loggedIn) {
    const gs = (state && state.groups) || [];
    el.textContent = `已登录 · ${gs.length} 个分组 / ${gs.reduce((n, g) => n + (g.count || 0), 0)} 只自选`;
  } else {
    el.textContent = '未登录';
  }
}

function wire() {
  const setPatch = (patch) => widget.invoke('app:settings:set', patch).catch(() => {});

  $('#theme').onchange = () => setPatch({ appearance: { theme: $('#theme').value } });
  $('#fontSize').onchange = () => setPatch({ appearance: { fontSize: $('#fontSize').value } });
  let alphaT = null;
  $('#bgAlpha').oninput = () => {
    clearTimeout(alphaT);
    alphaT = setTimeout(() => setPatch({ appearance: { bgAlpha: Number($('#bgAlpha').value) / 100 } }), 80);
  };
  $('#vibrancy').onchange = () => setPatch({ appearance: { vibrancy: $('#vibrancy').checked } });
  $('#pulse').onchange = () => setPatch({ appearance: { pulse: $('#pulse').checked } });
  $('#monoMode').onchange = () => setPatch({ appearance: { mono: $('#monoMode').checked } });
  $('#upColor').onchange = () => setPatch({ appearance: { upColor: $('#upColor').value } });
  $('#showCode').onchange = () => setPatch({ appearance: { showCode: $('#showCode').checked } });
  $('#showIndexBar').onchange = () => setPatch({ appearance: { showIndexBar: $('#showIndexBar').checked } });
  $('#autoHeight').onchange = () => setPatch({ appearance: { autoHeight: $('#autoHeight').checked } });
  $('#autoWidth').onchange = () => setPatch({ appearance: { autoWidth: $('#autoWidth').checked } });
  $('#refreshInterval').onchange = () => setPatch({ behavior: { refreshInterval: Number($('#refreshInterval').value) } });
  $('#newsEnabled').onchange = () => setPatch({ behavior: { newsEnabled: $('#newsEnabled').checked } });
  $('#bossKeyAction').onchange = () => setPatch({ behavior: { bossKeyAction: $('#bossKeyAction').value } });
  $('#dockIcon').onchange = () => setPatch({ behavior: { dockIcon: $('#dockIcon').checked } });
  $('#contentProtection').onchange = () => setPatch({ behavior: { contentProtection: $('#contentProtection').checked } });
  $('#launchAtLogin').onchange = () => setPatch({ behavior: { launchAtLogin: $('#launchAtLogin').checked } });
  $('#alertEnabled').onchange = () => setPatch({ alerts: { enabled: $('#alertEnabled').checked } });
  $('#alertStyle').onchange = () => setPatch({ alerts: { style: $('#alertStyle').value } });
  $('#alertLowKey').onchange = () => setPatch({ alerts: { lowKey: $('#alertLowKey').checked } });
  $('#alertThreshold').onchange = () => setPatch({ alerts: { threshold: Number($('#alertThreshold').value) } });
  $('#summaryEnabled').onchange = () => setPatch({ alerts: { summary: $('#summaryEnabled').checked } });
  $('#sortMode').onchange = () => setPatch({ source: { sortMode: $('#sortMode').value } });

  document.querySelectorAll('#mode button').forEach((btn) => {
    btn.onclick = () => setPatch({ source: { mode: btn.dataset.v } });
  });

  $('#sc-reset').onclick = () => widget.invoke('app:shortcuts:reset').catch(() => {});

  $('#pos-import-btn').onclick = async () => {
    const text = $('#posimport').value;
    if (!text.trim()) return;
    const res = await widget.invoke('app:positions:import', { text }).catch(() => null);
    const msg = $('#posmsg');
    if (res && res.ok) {
      msg.textContent = `已导入 ${res.added} 只` + (res.invalid && res.invalid.length ? `，未识别：${res.invalid.join('、')}` : '');
      $('#posimport').value = '';
    } else msg.textContent = '导入失败，请检查格式';
  };

  $('#login-btn').onclick = () => widget.invoke('app:login:open').catch(() => {});
  $('#logout-btn').onclick = () => widget.invoke('app:login:logout').catch(() => {});

  $('#import-btn').onclick = async () => {
    const text = $('#importbox').value;
    if (!text.trim()) return;
    const res = await widget.invoke('app:import', { text }).catch(() => null);
    const msg = $('#importmsg');
    if (res && res.ok) {
      msg.textContent = `已导入 ${res.addedCount} 只` +
        (res.invalid && res.invalid.length ? `，未识别：${res.invalid.join('、')}` : '');
      $('#importbox').value = '';
    } else {
      msg.textContent = '导入失败，请检查格式';
    }
  };
  $('#import-file-btn').onclick = () => $('#importfile').click();
  $('#importfile').onchange = async () => {
    const f = $('#importfile').files && $('#importfile').files[0];
    if (!f) return;
    const text = await f.text();
    $('#importbox').value = text;
    $('#import-btn').click();
  };
}

function renderPositions() {
  const box = $('#poslist');
  if (!box || !settings) return;
  const list = settings.source.positions || [];
  const sig = JSON.stringify(list);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  if (!list.length) {
    const d = document.createElement('span');
    d.className = 'dim small';
    d.textContent = '暂无持仓记录（导入后小窗出现「持仓」分组）';
    box.append(d);
    return;
  }
  const names = new Map();
  if (state && state.rows) for (const r of state.rows) names.set(r.market + r.code, r.name);
  for (const e of list) {
    const item = document.createElement('span');
    item.className = 'mitem';
    const label = document.createElement('span');
    label.textContent = `${names.get(e.m + e.c) || e.c} ${e.cost != null ? '@' + e.cost : ''}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除';
    del.onclick = () => widget.invoke('app:positions:remove', { market: e.m, code: e.c }).catch(() => {});
    item.append(label, del);
    box.append(item);
  }
}

function renderManualList() {
  const box = $('#mlist');
  if (!box || !settings || settings.source.mode !== 'manual') return;
  const list = settings.source.manualList || [];
  const names = new Map();
  if (state && state.rows) {
    for (const r of state.rows) names.set(r.market + r.code, r.name);
  }
  if (box.dataset.count === String(list.length) && box.dataset.sig === JSON.stringify(list)) return;
  box.dataset.count = String(list.length);
  box.dataset.sig = JSON.stringify(list);
  box.textContent = '';
  if (!list.length) {
    const d = document.createElement('span');
    d.className = 'dim small';
    d.textContent = '列表为空';
    box.append(d);
    return;
  }
  for (const e of list) {
    const key = e.m + e.c;
    const item = document.createElement('span');
    item.className = 'mitem';
    const label = document.createElement('span');
    label.textContent = `${names.get(key) || e.c} ${e.c}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除';
    del.onclick = () => widget.invoke('app:list:remove', { market: e.m, code: e.c }).catch(() => {});
    item.append(label, del);
    box.append(item);
  }
}

function renderShortcuts() {
  const box = $('#scrows');
  if (!box || !settings) return;
  const sc = settings.shortcuts || {};
  const sig = JSON.stringify(sc);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  for (const [name, label] of Object.entries(SC_NAMES)) {
    const row = document.createElement('div');
    row.className = 'scrow';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = label;
    const acc = document.createElement('span');
    acc.className = 'acc';
    acc.textContent = sc[name] || '—';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '录制';
    btn.onclick = () => recordKey(row, name, acc);
    row.append(n, acc, btn);
    box.append(row);
  }
}

function recordKey(row, name, accEl) {
  row.classList.add('recording');
  const old = accEl.textContent;
  accEl.textContent = '按下新组合键…';

  const cleanup = () => {
    row.classList.remove('recording');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape') {
      accEl.textContent = old;
      cleanup();
      return;
    }
    const parts = [];
    if (e.altKey) parts.push('Alt');
    if (e.ctrlKey) parts.push('Control');
    if (e.metaKey) parts.push('Command');
    if (e.shiftKey) parts.push('Shift');
    const keyMap = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Enter: 'Return', ' ': 'Space', Escape: 'Esc',
    };
    let k = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (!/^[A-Z0-9]|Up$|Down$|Left$|Right$|Return$|Space$/.test(k) && k.length > 1) {
      accEl.textContent = old;
      cleanup();
      return;
    }
    if (!parts.length) parts.push('Alt'); // 无修饰键时默认 Alt，避免全局误触
    parts.push(k);
    const acc = parts.join('+');
    cleanup();
    accEl.textContent = acc;
    widget.invoke('app:settings:set', { shortcuts: { [name]: acc } }).catch(() => {});
  };
  document.addEventListener('keydown', onKey, true);
}

boot();
