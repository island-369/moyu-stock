'use strict';
/**
 * 配置迁移：历史 4 项一次性布尔标记 + 此后的 schemaVersion 有序迁移表。
 * 新增迁移只需在 MIGRATIONS 表加一个条目，不再往启动流程里堆 if（2026-10 审查 D6）。
 */
const { DEFAULT_SHORTCUTS } = require('../shared/constants');

// v5：提醒方式默认档 banner → menubar（P0-2：把系统通知授权弹窗推迟到用户主动开横幅）
const MIGRATIONS = {
  5: (settings, log) => {
    if (settings.get().alerts.style === 'banner') {
      settings.set({ alerts: { style: 'menubar' } });
      log.info('配置迁移：提醒方式默认改为菜单栏信号（menubar）');
    }
  },
};

/** 旧安装没有 schemaVersion → 视为 4（1–4 号迁移已由下方布尔标记覆盖过） */
const BASE_VERSION = 4;

function runMigrations(settings, log) {
  const info = (m) => log && log.info(m);

  // ---- 历史：一次性布尔标记（保留原语义；已上线跑过的用户不再触发） ----
  if (!settings.get().behavior.dockMigrated) {
    settings.set({ behavior: { dockIcon: true, dockMigrated: true } });
    info('配置迁移：dockIcon 旧默认 false → 新默认 true');
  }
  if (!settings.get().source.activeGroupMigrated) {
    const patch = { source: { activeGroupMigrated: true } };
    if (settings.get().source.activeGroup === 'all') patch.source.activeGroup = 'first';
    settings.set(patch);
    info('配置迁移：activeGroup all → first');
  }
  if (!settings.get().appearance.pulseMigrated) {
    const patch = { appearance: { pulseMigrated: true } };
    if (settings.get().appearance.pulse === true) patch.appearance.pulse = false;
    settings.set(patch);
    info('配置迁移：变动脉冲默认关闭（静默优先）');
  }
  if (!settings.get().shortcuts) {
    settings.data.shortcuts = { ...DEFAULT_SHORTCUTS };
    settings.save();
  }
  const sc = settings.get().shortcuts;
  const scPatch = {};
  for (const k of ['meeting', 'groupPrev', 'groupNext']) {
    if (!sc[k]) scPatch[k] = DEFAULT_SHORTCUTS[k];
  }
  if (Object.keys(scPatch).length) {
    settings.data.shortcuts = { ...sc, ...scPatch };
    settings.save();
    info('配置迁移：补充新快捷键 ' + Object.keys(scPatch).join('/'));
  }

  // ---- schemaVersion 有序迁移表：逐版本执行，失败即停并保留版本号 ----
  let v = Number(settings.get().schemaVersion) || BASE_VERSION;
  for (const key of Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b)) {
    if (key <= v) continue;
    try {
      MIGRATIONS[key](settings, log);
      v = key;
    } catch (e) {
      if (log) log.warn('迁移 ' + key + ' 失败: ' + (e && e.message));
      break;
    }
  }
  if (settings.get().schemaVersion !== v) {
    settings.data.schemaVersion = v;
    settings.save();
    info('配置 schemaVersion → ' + v);
  }
}

module.exports = { runMigrations };
