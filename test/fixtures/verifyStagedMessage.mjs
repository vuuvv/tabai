import { AIClient } from '../../dist-src/ai/client.js';
import { GitService } from '../../dist-src/git/gitService.js';
import { DEFAULT_SETTINGS } from '../../dist-src/config/settings.js';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/tmp/tabai-repro2';
rmSync(REPO, { recursive: true, force: true });
mkdirSync(join(REPO, 'doc', 'assets'), { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email','t@t.com'); git('config','user.name','T');
writeFileSync(join(REPO, 'README.md'), '# proj\n');
git('add', '.'); git('commit', '-qm', 'init');

// 暂存一个文档
writeFileSync(join(REPO, 'doc', '非机动车业务操作指南.md'), '# 非机动车业务操作指南\n\n## 注册流程\n\n1. 提交资料\n2. 审核\n');
git('add', 'doc/非机动车业务操作指南.md');

// 未跟踪的一堆图片
for (const n of ['01-login','02-create-partner','03-interface']) {
  writeFileSync(join(REPO, 'doc','assets', n + '.png'), 'png');
}

const svc = new GitService();
const summary = await svc.collectSummary(REPO, 8000);
console.log('stagedOnly:', summary.stagedOnly, '| files:', summary.files.map(f=>f.path));

const client = new AIClient();
const res = await client.generateCommitMessage(
  { ...DEFAULT_SETTINGS, timeoutMs: 120000, maxRetries: 0, gitLanguage: 'zh-CN' },
  summary,
);
console.log();
console.log('=== 生成的消息 ===');
console.log(res.message);
