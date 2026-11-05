/**
 * Verifies that debug-level logging actually reaches the sink.
 *
 * This exercises the real logger + engine + provider-facing code paths with
 * logLevel=debug, mirroring what the extension host will do.
 */
import { setLogLevel, setLogSink } from '../../dist-src/core/logger.js';
import { CompletionEngine } from '../../dist-src/completion/engine.js';
import { readSettings } from '../../dist-src/config/settings.js';
import { DEFAULT_SETTINGS } from '../../dist-src/config/settings.js';

const lines = [];
setLogSink((level, message) => lines.push(level + ' :: ' + message));
setLogLevel('debug');

const settings = { ...DEFAULT_SETTINGS, debounceMs: 0, contextDebounceMs: 0, logLevel: 'debug' };

const engine = new CompletionEngine({
  client: {
    async complete() {
      return { text: 'return a + b', model: 'qwen', finishReason: 'stop', latencyMs: 12, fromCache: false };
    },
  },
});

const doc = {
  uri: 'file:///demo.py', languageId: 'python', version: 1,
  text: 'def add(a, b):\n    ', fileName: 'demo.py',
};

console.log('=== 正常补全 ===');
const ok = await engine.complete(doc, { line: 1, character: 4 }, settings);
console.log('outcome:', ok.reason, '| text:', JSON.stringify(ok.completion?.text));

console.log();
console.log('=== 关闭补全 ===');
const off = await engine.complete(doc, { line: 1, character: 4 }, { ...settings, completionEnabled: false });
console.log('outcome:', off.reason);

console.log();
console.log('=== 缓存命中 ===');
const cached = await engine.complete(doc, { line: 1, character: 4 }, settings);
console.log('outcome:', cached.reason, '| fromCache:', cached.fromCache);

console.log();
console.log('=== 捕获到的日志行 ===');
for (const line of lines) console.log('  ' + line);
