import { computeInsertionRange } from '../../dist-src/completion/engine.js';

console.log('=== 验证 range 覆盖范围缺陷 ===');
const line = 'result = calculate(a, b)';
// 光标在 "calculate" 之后，即 character=18
const pos = { line: 0, character: 18 };
const range = computeInsertionRange(pos, line);

console.log('行内容:', JSON.stringify(line));
console.log('行长度:', line.length);
console.log('光标位置:', pos.character, '(在 "calculate" 之后)');
console.log();
console.log('computeInsertionRange ->', JSON.stringify(range));
console.log();
console.log('range 覆盖的文本:', JSON.stringify(line.slice(range.start.character, range.end.character)));
console.log();
if (range.end.character >= line.length) {
  console.log('结论: range 覆盖到行尾，接受补全后 "（a, b）" 会被替换掉 —— 确认是缺陷');
} else {
  console.log('结论: range 未覆盖到行尾');
}
