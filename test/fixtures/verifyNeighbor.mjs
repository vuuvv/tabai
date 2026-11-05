/**
 * Real-world cross-file context test.
 *
 * Uses the plugin's own source tree: ask for a completion in one file while
 * the collector scans the others.
 */
import { collectNeighborContext, buildQueryWindow, formatNeighborContext } from '../../dist-src/completion/neighborContext.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((p) => ({
  path: relative(ROOT, p),
  text: readFileSync(p, 'utf8'),
}));

console.log('扫描文件数:', files.length);
console.log();

// 场景 1：在 engine.ts 里请求补全，问"缓存"相关的代码
const current = files.find((f) => f.path.endsWith('completion/engine.ts'));
const query1 = buildQueryWindow(current.text, 250, 15);
console.log('=== 场景 1: 在 engine.ts 中，查询 "缓存" 上下文 ===');
const r1 = collectNeighborContext(files, {
  currentPath: current.path,
  query: query1,
  threshold: 0.08,
  maxSnippets: 3,
  maxSnippetChars: 600,
  maxTotalChars: 2000,
  windowLines: 40,
  maxFiles: 30,
  maxFileChars: 100000,
});
for (const s of r1) {
  console.log('  ' + s.path + '  score=' + s.score.toFixed(3) + '  line=' + (s.startLine + 1));
}
console.log();

// 场景 2：模拟用户正在写一个"重试"函数
const query2 = 'async function retryWithBackoff(fn, maxRetries, baseDelayMs) {\n  for (let attempt = 1; attempt <= maxRetries; attempt++) {\n';
console.log('=== 场景 2: 正在写重试函数，找项目里类似的实现 ===');
const r2 = collectNeighborContext(files, {
  currentPath: 'src/scratch.ts',
  query: query2,
  threshold: 0.05,
  maxSnippets: 3,
  maxSnippetChars: 500,
  maxTotalChars: 1500,
  windowLines: 40,
  maxFiles: 30,
  maxFileChars: 100000,
});
for (const s of r2) {
  console.log('  ' + s.path + '  score=' + s.score.toFixed(3) + '  line=' + (s.startLine + 1));
}
console.log();

// 场景 3：模拟写一个"LRU 缓存"
const query3 = 'class LruCache {\n  constructor(capacity, ttlMs) {\n    this.capacity = capacity;\n  }\n  get(key) {\n';
console.log('=== 场景 3: 正在写 LRU 缓存类 ===');
const r3 = collectNeighborContext(files, {
  currentPath: 'src/scratch.ts',
  query: query3,
  threshold: 0.05,
  maxSnippets: 3,
  maxSnippetChars: 400,
  maxTotalChars: 1200,
  windowLines: 40,
  maxFiles: 30,
  maxFileChars: 100000,
});
for (const s of r3) {
  console.log('  ' + s.path + '  score=' + s.score.toFixed(3) + '  line=' + (s.startLine + 1));
}

console.log();
console.log('=== 场景 2 的 prompt 块预览 ===');
console.log(formatNeighborContext(r2).slice(0, 700));
