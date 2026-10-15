'use strict';
/**
 * 原子写 JSON 存储：写临时文件 → 备份旧文件 → rename。
 * 损坏自动回滚 .bak；深合并默认值（新增字段向后兼容）。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  appearance: {
    theme: 'auto',        // auto | dark | light
    fontSize: 'standard', // mini | compact | standard | large
    bgAlpha: 0.78,        // 0.35–1 背景板浓度
    vibrancy: true,       // macOS 毛玻璃
    pulse: false,         // 变动脉冲（摸鱼静默优先，默认关；需要可在设置开启）
    pulseMigrated: false, // 一次性迁移标记：旧默认 true → false
    upColor: 'red',       // red=红涨 | green=绿涨
    mono: false,          // 单色模式：涨跌同色（隐蔽优先，方向靠 +/− 符号传达）
    showCode: false,      // 股票代码：默认隐藏（隐蔽优先）
    showIndexBar: true,
    autoHeight: true,     // 窗口高度自适应内容
    autoWidth: true,      // 窗口宽度自适应内容（摸鱼紧凑：无中间空隙）
  },
  behavior: {
    refreshInterval: 5000,   // 3000|5000|10000|30000
    bossKeyAction: 'menubar', // menubar | hide
    newsEnabled: false,
    dockIcon: true,          // 在 Dock 显示图标（像普通应用一样最小化/恢复）；隐蔽场景可在设置/托盘关闭
    dockMigrated: false,     // v0.1.0 一次性迁移标记（默认 false：老配置缺此键 → 触发迁移；跑过一次后写 true）
    hideHintShown: false,    // 首次退到后台的提示已展示
    contentProtection: false, // 防录屏：开启后窗口不出现在截屏/录屏/屏幕共享里（会议共享屏不露馅）
    launchAtLogin: false,     // 开机自启（上班开机即有，省掉"手动开应用"这个动作）
  },
  alerts: {
    enabled: true,        // 自选异动提醒（摸鱼核心：不用盯，异动找你）
    threshold: 5,         // 涨跌幅绝对值阈值 %
    summary: true,        // 15:05 收盘战报
    style: 'banner',      // banner=系统横幅 | menubar=菜单栏 ▲▼ 信号（最低调）| silent=静默只记黄条
    lowKey: false,        // 低调通知：标题/正文不出现股票名与价格（默认通知本身就是暴露源）
    priceRules: [],       // 个股股价提醒 [{id,m,c,op:'gte'|'lte',price,hit,ts}]：盘中到价屏上弹窗并重新布防
    toastPos: null,       // 股价提醒弹窗位置（拖动后记忆）{x,y}
  },
  source: {
    mode: 'manual',       // manual | cloud
    manualList: [],       // [{m:'SH', c:'600519'}]，顺序即显示顺序
    manualStars: {},      // 'SH600519' -> true（手动模式置顶）
    activeGroup: 'first',     // first=第一个分组（像东财默认落在自选股）| all=合并视图 | gid
    activeGroupMigrated: false, // 一次性迁移标记（默认 false，迁移后写 true）
    sortMode: 'default',  // default=自选顺序 | pct=按涨跌幅（摸鱼一眼看异动）
    groupSorts: {},       // 按分组记忆排序：gid -> sortMode，切分组恢复该组上次的排序
    localOrder: {},       // 云端模式本地顺序覆盖 'SH600519' -> idx
    filterStarred: false, // 仅看置顶（手动模式；自选几百只时快速聚焦）
    positions: [],        // 本地持仓 [{m,c,s,cost,qty}] —— 与东财账户无关，成本本地记录
  },
  window: {
    bounds: null,         // {x,y,width,height}
    form: 'full',         // full | mini
    startHidden: false,   // 内部状态：上次完全隐身后退出/崩溃 → 下次启动恢复为隐身（不暴露）
  },
  shortcuts: null,        // 由 DEFAULT_SHORTCUTS 填充
  onboarded: false,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    if (isPlainObject(base[k]) && isPlainObject(patch[k])) out[k] = deepMerge(base[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}

class Store {
  /**
   * @param {string} file JSON 路径
   * @param {object} defaults 默认值（会被深合并）
   */
  constructor(file, defaults = DEFAULTS) {
    this.file = file;
    this.bak = file + '.bak';
    this.tmp = file + '.tmp';
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this._saveTimer = null;
  }

  load() {
    for (const f of [this.file, this.bak]) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.data = deepMerge(structuredClone(this.defaults), j);
        return this;
      } catch (e) { /* 尝试下一个 */ }
    }
    return this;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
      try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.bak); } catch (e) { /* 备份失败不阻塞 */ }
      fs.renameSync(this.tmp, this.file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
    return this;
  }

  /** 高频变更（窗口位置等）的防抖保存 */
  saveSoon(ms = 600) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), ms);
    return this;
  }

  get() { return this.data; }

  /** 深合并补丁并持久化；返回新数据 */
  set(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS, deepMerge };
