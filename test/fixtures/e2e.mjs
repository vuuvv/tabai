/**
 * End-to-end smoke test against the real local AI service.
 *
 * Exercises the actual FIM and chat paths through the compiled client.
 */
// Run `npm run build:e2e` first to emit dist-src/.
import { AIClient } from '../../dist-src/ai/client.js';

const settings = {
  providerType: 'fim',
  baseUrl: 'http://192.168.2.101:1234/v1',
  apiKey: '',
  completionModel: 'qwen3.6-35b-a3b',
  commitModel: 'qwen3.6-35b-a3b',
  timeoutMs: 60000,
  maxRetries: 0,
  completionEnabled: true,
  debounceMs: 0,
  contextDebounceMs: 0,
  maxPrefixLines: 60,
  maxSuffixLines: 10,
  maxTokens: 60,
  temperature: 0.1,
  multiline: true,
  cacheSize: 10,
  cacheTtlMs: 60000,
  gitMaxDiffChars: 8000,
  gitConventionalCommits: true,
  gitLanguage: 'en',
  gitAutoCommit: false,
};

const context = {
  document: {
    uri: 'file:///demo.py',
    languageId: 'python',
    version: 1,
    text: 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    ',
    fileName: 'demo.py',
  },
  position: { line: 4, character: 4 },
  prefix: 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    ',
  suffix: '\n\nprint(sub(5, 3))\n',
  currentLine: '    ',
  isMiddleOfLine: false,
  imports: [],
};

const client = new AIClient();

console.log('=== FIM completion ===');
const fim = await client.complete(settings, context);
console.log('text:', JSON.stringify(fim.text));
console.log('model:', fim.model, 'finish:', fim.finishReason, 'latency:', fim.latencyMs + 'ms');

console.log();
console.log('=== chat completion ===');
const chat = await client.complete({ ...settings, providerType: 'openai-compatible' }, context);
console.log('text:', JSON.stringify(chat.text));
console.log('latency:', chat.latencyMs + 'ms');

console.log();
console.log('=== commit message ===');
const commit = await client.generateCommitMessage(settings, {
  repoRoot: '/repo',
  branch: 'main',
  files: [
    { path: 'src/auth.ts', status: 'M', insertions: 24, deletions: 3 },
    { path: 'src/auth.test.ts', status: 'A', insertions: 40, deletions: 0 },
  ],
  diff: [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '+export function validateToken(token: string): boolean {',
    '+  if (!token) return false;',
    '+  return token.length > 10;',
    '+}',
    'diff --git a/src/auth.test.ts b/src/auth.test.ts',
    '+describe("validateToken", () => {',
    '+  it("rejects empty tokens", () => {',
    '+    expect(validateToken("")).toBe(false);',
    '+  });',
    '+});',
  ].join('\n'),
  truncated: false,
});
console.log('subject:', JSON.stringify(commit.subject));
console.log('body:', JSON.stringify(commit.body));
console.log('latency:', commit.latencyMs + 'ms');

console.log();
console.log('=== models ===');
console.log(await client.listModels(settings));
