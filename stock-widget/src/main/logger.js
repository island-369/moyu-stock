'use strict';
/**
 * 极简文件日志：按天滚动保留 7 天；Cookie/凭据强制脱敏。
 */
const fs = require('fs');
const path = require('path');

function redact(s) {
  return String(s)
    .replace(/("(?:cookie|Cookie|set-cookie|Set-Cookie|authorization)"\s*:\s*)"[^"]*"/g, '$1"[REDACTED]"')
    .replace(/\b(uidal|qgqp_b_id|pi|aiucci|st_si|vqhaskventheme)\s*=\s*[^;\s"']+/gi, '$1=[REDACTED]');
}

function safe(o) {
  if (typeof o === 'string') return redact(o);
  try { return redact(JSON.stringify(o)); } catch (e) { return redact(String(o)); }
}

class Logger {
  constructor(dir) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.clean();
    } catch (e) { /* 忽略 */ }
  }
  get file() {
    return path.join(this.dir, 'main-' + new Date().toISOString().slice(0, 10) + '.log');
  }
  clean() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.log')).sort();
      while (files.length > 7) fs.unlinkSync(path.join(this.dir, files.shift()));
    } catch (e) { /* 忽略 */ }
  }
  write(level, args) {
    const line = '[' + new Date().toISOString() + '] [' + level + '] ' +
      args.map(safe).join(' ') + '\n';
    try { fs.appendFileSync(this.file, line); } catch (e) { /* 忽略 */ }
  }
  info(...a) { this.write('INFO', a); }
  warn(...a) { this.write('WARN', a); }
  error(...a) { this.write('ERROR', a); }
}

module.exports = { Logger, redact };
