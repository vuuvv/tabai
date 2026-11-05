/**
 * End-to-end staging-scope test against a real git repository.
 */
import { GitService } from '../../dist-src/git/gitService.js';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/tmp/tabai-git-e2e';
rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

git('init', '-q');
git('config', 'user.email', 't@t.com');
git('config', 'user.name', 'T');
writeFileSync(join(REPO, 'a.txt'), 'line1\n');
git('add', 'a.txt');
git('commit', '-qm', 'init');

const svc = new GitService();

console.log('=== 场景 1: 只有未暂存改动 ===');
appendFileSync(join(REPO, 'a.txt'), 'line2\n');
writeFileSync(join(REPO, 'b.txt'), 'new file\n');
let s = await svc.collectSummary(REPO, 5000);
console.log('stagedOnly:', s.stagedOnly);
console.log('files:', s.files.map(f => f.status + ' ' + f.path));
console.log('diff 含 b.txt:', s.diff.includes('b.txt'));

console.log();
console.log('=== 场景 2: 暂存 a.txt，b.txt 仍未跟踪 ===');
git('add', 'a.txt');
s = await svc.collectSummary(REPO, 5000);
console.log('stagedOnly:', s.stagedOnly);
console.log('files:', s.files.map(f => f.status + ' ' + f.path));
console.log('含未跟踪的 b.txt?:', s.files.some(f => f.path === 'b.txt'));

console.log();
console.log('=== 场景 3: 再暂存 b.txt ===');
git('add', 'b.txt');
s = await svc.collectSummary(REPO, 5000);
console.log('stagedOnly:', s.stagedOnly);
console.log('files:', s.files.map(f => f.status + ' ' + f.path));

console.log();
console.log('=== 场景 4: 清空暂存区 ===');
git('reset', '-q');
s = await svc.collectSummary(REPO, 5000);
console.log('stagedOnly:', s.stagedOnly);
console.log('files:', s.files.map(f => f.status + ' ' + f.path));
