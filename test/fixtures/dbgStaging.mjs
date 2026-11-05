import { GitService } from '../../dist-src/git/gitService.js';

const calls = [];
const runner = async (args) => {
  const key = args.join(' ');
  calls.push(key);
  const table = {
    'rev-parse --show-toplevel': { stdout: '/repo\n', code: 0 },
    'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', code: 0 },
    'rev-parse --verify HEAD': { stdout: 'abc', code: 0 },
    'diff --cached --quiet': { code: 1 },
    'diff --cached --name-status -z': { stdout: 'M\0src/a.ts\0', code: 0 },
    'diff --cached --numstat --': { stdout: '3\t1\tsrc/a.ts\n', code: 0 },
    'diff --cached --no-color --unified=3 --': { stdout: '+staged line', code: 0 },
  };
  const r = table[key];
  if (r === undefined) return { stdout: '', stderr: 'unexpected: ' + key, code: 128 };
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
};

const svc = new GitService({ runner });
const summary = await svc.collectSummary('/repo', 1000);
console.log('calls:', calls);
console.log('summary:', summary === null ? 'null' : { stagedOnly: summary.stagedOnly, files: summary.files.map(f => f.path) });
