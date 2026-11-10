#!/usr/bin/env node
'use strict';
/**
 * 零依赖 lint（D8）：对 src/ tools/ tests/ 全量跑 node --check 语法检查。
 * 真正的 ESLint 规则集（no-unused-vars 等）待引入依赖后再补，先保证 CI 有语法门禁。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = [];

function walk(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
}

for (const d of ['src', 'tools', 'tests']) walk(path.join(ROOT, d));

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad += 1;
    console.error('✗ ' + path.relative(ROOT, f));
    const firstLine = String(r.stderr || '').trim().split('\n')[0];
    if (firstLine) console.error('  ' + firstLine);
  }
}

/* 渲染层元素引用交叉检查：$('#id') 字面量必须在同目录配对 HTML 里存在。
 * 背景（2026-10-22 事故）：upColor UI 随单色模式移除但 settings.js 绑定残留，
 * wire() 在 null.onchange 处抛错，其后所有设置项（含预警弹窗时间）静默失效。 */
const RENDERER_PAIRS = [
  ['src/renderer/app.js', 'src/renderer/index.html'],
  ['src/renderer/settings.js', 'src/renderer/settings.html'],
  ['src/renderer/alert.js', 'src/renderer/alert.html'],
];
for (const [jsRel, htmlRel] of RENDERER_PAIRS) {
  const jsPath = path.join(ROOT, jsRel);
  const htmlPath = path.join(ROOT, htmlRel);
  if (!fs.existsSync(jsPath) || !fs.existsSync(htmlPath)) continue;
  const ids = new Set([...fs.readFileSync(htmlPath, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...fs.readFileSync(jsPath, 'utf8').matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const missing = refs.filter((id) => !ids.has(id));
  if (missing.length) {
    bad += 1;
    console.error(`✗ ${jsRel} 引用了 ${htmlRel} 中不存在的元素: ${missing.map((id) => '#' + id).join(' ')}`);
  }
}

console.log(`lint: ${files.length} 个文件，${bad} 个错误`);
process.exit(bad ? 1 : 0);
