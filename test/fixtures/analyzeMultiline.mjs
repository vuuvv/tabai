/**
 * Tests what happens when an edit_recommends-shaped result is converted to a
 * VS Code InlineCompletionItem whose range spans multiple lines.
 */
import { computeInsertionRange } from '../../dist-src/completion/engine.js';

console.log('=== 场景：多行替换 ===');
console.log('原代码 (3 行):');
console.log('  1| def foo(x):');
console.log('  2|     a = x + 1');
console.log('  3|     return a');
console.log();

// edit_recommends 想表达：把 2..3 行整体替换成 1 行
const editRecommend = {
  edit_before: '    a = x + 1\n    return a',
  edit_after: '    return x + 1',
  edit_area_range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
};

console.log('edit_area_range:', JSON.stringify(editRecommend.edit_area_range));
console.log('  start.line =', editRecommend.edit_area_range.start.line);
console.log('  end.line   =', editRecommend.edit_area_range.end.line);
console.log('  跨行?', editRecommend.edit_area_range.start.line !== editRecommend.edit_area_range.end.line);
console.log();

// 当前实现：computeInsertionRange 只会产出单行范围
const range = computeInsertionRange({ line: 1, character: 4 }, '    a = x + 1');
console.log('当前 computeInsertionRange 产出:', JSON.stringify(range));
console.log('  -> 完全忽略了 edit_area_range 的 end.line=3');
console.log('  -> 只能表达"在第 1 行内替换"，无法表达"删除第 2、3 行"');
console.log();
console.log('=== VS Code API 约束 ===');
console.log('InlineCompletionItem.range: "Must begin and end on the same line"');
console.log('  -> 即便我们构造出 {start:{1,0}, end:{3,0}}，VS Code 也会拒绝/忽略');
