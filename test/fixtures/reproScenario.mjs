/**
 * Reproduces the reported scenario: one file staged, many untracked files.
 */
import { GitService } from '../../dist-src/git/gitService.js';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/tmp/tabai-repro';
rmSync(REPO, { recursive: true, force: true });
mkdirSync(join(REPO, 'doc', 'assets'), { recursive: true });

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 't@t.com'); git('config', 'user.name', 'T');
writeFileSync(join(REPO, '.gitignore'), '*.log\n');
git('add', '.gitignore'); git('commit', '-qm', 'init');

// 复现截图：暂存一个 docx
writeFileSync(join(REPO, 'doc', 'guide.docx'), 'binary-docx-content');
git('add', 'doc/guide.docx');

// 大量未跟踪的 png（截图里的 assets/partner-onboarding）
for (const name of ['01-login', '02-create-partner', '03-interface-definition', '04-partner-authorizations']) {
  writeFileSync(join(REPO, 'doc', 'assets', name + '.png'), 'png-' + name);
}

// 一个未暂存的已跟踪文件改动
appendFileSync(join(REPO, '.gitignore'), 'temp/\n');

console.log('=== git status ===');
console.log(git('status', '--porcelain=v1'));

console.log('=== git diff --cached --name-status ===');
console.log(git('diff', '--cached', '--name-status'));

const svc = new GitService();
const summary = await svc.collectSummary(REPO, 8000);

console.log('=== collectSummary ===');
console.log('stagedOnly:', summary.stagedOnly);
console.log('files:');
for (const f of summary.files) console.log('  ', f.status, f.path);
console.log();
console.log('含未跟踪的 png?:', summary.files.some(f => f.path.endsWith('.png')));
console.log('含未暂存的 .gitignore 改动?:', summary.files.some(f => f.path === '.gitignore'));
console.log();
console.log('=== diff 内容 ===');
console.log(summary.diff.slice(0, 400));
