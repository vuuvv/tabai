/**
 * Full-stack verification: provider adapter + engine + real AI service.
 *
 * Emulates what the extension host does on every keystroke.
 */
import { setLogLevel, setLogSink } from '../../dist-src/core/logger.js';
import { CompletionEngine } from '../../dist-src/completion/engine.js';
import { AIClient } from '../../dist-src/ai/client.js';
import { DEFAULT_SETTINGS } from '../../dist-src/config/settings.js';

const lines = [];
setLogSink((level, message) => lines.push(message));
setLogLevel('debug');

const settings = {
  ...DEFAULT_SETTINGS,
  debounceMs: 0, contextDebounceMs: 0, logLevel: 'debug',
  maxTokens: 60, maxPrefixLines: 60,
};

const engine = new CompletionEngine({ client: new AIClient() });

const doc = {
  uri: 'file:///demo.py', languageId: 'python', version: 1,
  fileName: 'demo.py',
  text: [
    'def calculate_total(prices, tax_rate):',
    '    """Return the sum of prices with tax applied."""',
    '    subtotal = sum(prices)',
    '    ',
    '',
    'def format_currency(amount, currency="USD"):',
    '    ',
    '',
  ].join('\n'),
};

console.log('=== 真实补全请求 ===');
const t0 = Date.now();
const outcome = await engine.complete(doc, { line: 3, character: 4 }, settings);
console.log('耗时:', Date.now() - t0, 'ms');
console.log('reason:', outcome.reason);
console.log('text:', JSON.stringify(outcome.completion?.text));

console.log();
console.log('=== 日志 ===');
for (const line of lines) console.log('  ' + line);
