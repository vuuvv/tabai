import { AIClient } from '../../dist-src/ai/client.js';
import { DEFAULT_SETTINGS } from '../../dist-src/config/settings.js';

const settings = { ...DEFAULT_SETTINGS, debounceMs: 0, contextDebounceMs: 0, logLevel: 'error', maxTokens: 120, maxPrefixLines: 60, temperature: 0 };

const client = new AIClient();

// 更明确：neighbor 里直接给出了项目约定的写法
const neighbor = [{
  path: 'src/internal/money.ts',
  content: [
    'export function sumMoney(amounts: number[]): number {',
    '  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0));',
    '}',
    '',
    'export function applyRate(amount: number, rate: number): number {',
    '  return fromCents(Math.round(toCents(amount) * (1 + rate)));',
    '}',
  ].join('\n'),
  startLine: 10,
  score: 0.55,
}];

const base = {
  document: {
    uri: 'file:///cart.ts', languageId: 'typescript', version: 1, fileName: 'cart.ts',
    text: 'import { toCents, fromCents, applyRate } from "./internal/money";\n\nexport function totalWithTax(prices: number[], taxRate: number): number {\n  ',
  },
  position: { line: 3, character: 2 },
  prefix: 'import { toCents, fromCents, applyRate } from "./internal/money";\n\nexport function totalWithTax(prices: number[], taxRate: number): number {\n  ',
  suffix: '\n}\n',
  currentLine: '  ',
  isMiddleOfLine: false,
  imports: [],
};

console.log('=== 无上下文 ===');
console.log(JSON.stringify((await client.complete(settings, { ...base, neighbors: [] })).text));

console.log();
console.log('=== 有上下文 ===');
console.log(JSON.stringify((await client.complete(settings, { ...base, neighbors: neighbor })).text));

console.log();
console.log('=== 有上下文 + chat 模式 ===');
console.log(JSON.stringify((await client.complete({ ...settings, providerType: 'openai-compatible' }, { ...base, neighbors: neighbor })).text));
