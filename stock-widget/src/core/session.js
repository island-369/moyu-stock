'use strict';
/**
 * 交易时段状态机（纯函数，可单测）。
 * A 股精确到分钟；港股按官方时段；美股用宽窗口 + 自适应降速兜底（避免维护夏令时表）。
 * 节假日不写死日期：由轮询层的「无变化自适应降速」自纠错（见 orchestrator）。
 */

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}
function isWeekday(d) {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/** A 股时段：closed / auction / open / lunch */
function aSharePhase(d) {
  if (!isWeekday(d)) return 'closed';
  const m = minutesOfDay(d);
  if (m >= 555 && m < 580) return 'auction'; // 09:15–09:30（含集合竞价与匹配）
  if (m >= 580 && m < 690) return 'open';    // 09:30–11:30
  if (m >= 690 && m < 780) return 'lunch';   // 11:30–13:00
  if (m >= 780 && m < 900) return 'open';    // 13:00–15:00
  return 'closed';
}

/** 港股时段（与北京同时区，无夏令时） */
function hkPhase(d) {
  if (!isWeekday(d)) return 'closed';
  const m = minutesOfDay(d);
  if ((m >= 570 && m < 720) || (m >= 780 && m < 960)) return 'open'; // 09:30–12:00 / 13:00–16:00
  return 'closed';
}

/** 美股宽窗口（北京时间 20:30–05:00），覆盖冬夏令时；误判由自适应降速兜底 */
function usMaybe(d) {
  if (!isWeekday(d)) return false;
  const m = minutesOfDay(d);
  return m >= 1230 || m < 300;
}

/**
 * 综合时段。markets: Set<'SH'|'SZ'|'BJ'|'HK'|'US'>
 * @returns {'open'|'auction'|'lunch'|'closed'}
 */
function marketPhase(now, markets) {
  if (markets.has('US') && usMaybe(now)) return 'open';
  if (markets.has('HK') && hkPhase(now) === 'open') return 'open';
  return aSharePhase(now);
}

/**
 * 各时段建议刷新间隔。
 * @param {string} phase marketPhase 结果
 * @param {number} userInterval 用户设置（开盘时段生效）
 * @param {boolean} adaptiveSlow 自适应降速（疑似节假日/无波动）
 */
function suggestedInterval(phase, userInterval, adaptiveSlow) {
  switch (phase) {
    case 'open': return adaptiveSlow ? 60000 : userInterval;
    case 'auction': return Math.min(userInterval, 5000);
    case 'lunch': return 30000;
    default: return 60000; // closed：心跳，兼做交易日翻转检测
  }
}

/** UI 文案 */
function phaseLabel(phase) {
  return { open: '交易中', auction: '竞价', lunch: '午间休市', closed: '已收盘' }[phase] || '';
}

module.exports = { aSharePhase, hkPhase, usMaybe, marketPhase, suggestedInterval, phaseLabel };
