import { AIClient } from '../../dist-src/ai/client.js';
import { GitService } from '../../dist-src/git/gitService.js';
import { DEFAULT_SETTINGS } from '../../dist-src/config/settings.js';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/tmp/tabai-commit-e2e';
rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 't@t.com'); git('config', 'user.name', 'T');
writeFileSync(join(REPO, 'auth.ts'), 'export function login(u){ return u; }\n');
git('add', 'auth.ts'); git('commit', '-qm', 'init');

// 暂存一个改动
appendFileSync(join(REPO, 'auth.ts'), 'export function validateToken(t: string): boolean {\n  if (!t) return false;\n  return t.length > 10;\n}\n');
git('add', 'auth.ts');
// 另一个未暂存的改动（不应出现在消息里）
appendFileSync(join(REPO, 'auth.ts'), 'export function unrelatedHelper() { return 42; }\n');
// 未跟踪文件（不应出现）
writeFileSync(join(REPO, 'scratch.ts'), 'export const scratch = true;\n');

const svc = new GitService();
const summary = await svc.collectSummary(REPO, 8000);
console.log('stagedOnly:', summary.stagedOnly);
console.log('files:', summary.files.map(f => f.status + ' ' + f.path));
console.log('含 unrelatedHelper:', summary.diff.includes('unrelatedHelper'));
console.log('含 scratch:', summary.diff.includes('scratch'));
console.log();

const client = new AIClient();
const base = { ...DEFAULT_SETTINGS, timeoutMs: 120000, maxRetries: 0 };

for (const lang of ['en', 'zh-CN']) {
  const res = await client.generateCommitMessage({ ...base, gitLanguage: lang }, summary);
  console.log('=== ' + lang + ' ===');
  console.log('subject:', JSON.stringify(res.subject));
  console.log('body   :', JSON.stringify(res.body));
  console.log();
}
