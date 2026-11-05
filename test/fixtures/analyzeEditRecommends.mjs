/**
 * Demonstrates the concrete difference between the current {text, range}
 * model and an edit_recommends model.
 */
import { postProcessCompletion } from '../../dist-src/completion/postProcess.js';

// 场景：用户选中/光标处已有一行错误实现，希望 AI 把它改掉
const existingCode = [
  'def calculate_total(prices, tax_rate):',
  '    return sum(prices)          // 忘了加税',
  '',
].join('\n');

// 模型返回的是"完整正确版本"（替换式输出）
const modelOutput = '    subtotal = sum(prices)\n    return subtotal * (1 + tax_rate)';

const prefix = 'def calculate_total(prices, tax_rate):\n';
const currentLine = '    return sum(prices)          // 忘了加税';

console.log('=== 当前 {text, range} 模型 ===');
console.log('光标位置: line=1, char=4 (行首缩进后)');
console.log('computeInsertionRange -> {start:{1,4}, end:{1,' + currentLine.length + '}}');
console.log('范围: 第 1 行 4..' + currentLine.length + ' (单行)');
console.log();
console.log('模型输出:', JSON.stringify(modelOutput));
const r = postProcessCompletion(modelOutput, {
  prefix, currentLine, multiline: true, minLength: 1,
});
console.log('后处理结果:', JSON.stringify(r.text));
console.log();
console.log('问题: insertText 会替换 range 覆盖的文本。');
console.log('      当前 range 只覆盖第 1 行，但模型输出了 2 行。');
console.log('      结果: 第 1 行被替换成 2 行，原第 1 行内容丢失 —— 正确。');
console.log('      但如果模型想保留原第 1 行只改第 2 行，就无法表达。');
