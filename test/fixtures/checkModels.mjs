import { AIClient } from '../../dist-src/ai/client.js';

const base = {
  providerType: 'fim',
  apiKey: '',
  completionModel: 'qwen3.6-35b-a3b',
  commitModel: 'qwen3.6-35b-a3b',
  timeoutMs: 20000, maxRetries: 0, completionEnabled: true,
  debounceMs: 0, contextDebounceMs: 0, maxPrefixLines: 60, maxSuffixLines: 10,
  maxTokens: 60, temperature: 0.1, multiline: true, reasoningMode: 'auto',
  cacheSize: 10, cacheTtlMs: 60000, gitMaxDiffChars: 8000,
  gitConventionalCommits: true, gitLanguage: 'en', gitAutoCommit: false,
};

const client = new AIClient();

for (const url of ['http://192.168.2.101:1234/v1', 'http://192.168.2.101:1234/api/v1']) {
  const models = await client.listModels({ ...base, baseUrl: url });
  console.log(url.padEnd(38), '=>', models.length ? models.join(', ') : '(empty)');
}
