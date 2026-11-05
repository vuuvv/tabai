# 提交信息的生成范围与语言

## 规则

| 场景 | 描述范围 | 理由 |
| --- | --- | --- |
| **有 staged 改动** | 只描述**暂存区**内容 | 这正是这次 commit 会包含的内容 |
| **无 staged 改动** | 描述**所有工作区改动**（含未跟踪文件） | 等价于 `git commit -a` 会提交的内容 |

这样设计的好处：先 `git add` 想提交的文件，再生成消息，消息自然只覆盖这部分；
懒得分次提交时直接生成，消息覆盖全部改动。

---

## 实现

### 1. 判定是否有暂存内容

用 `git diff --cached --quiet` 的**退出码**，而不是解析输出：

```ts
public async hasStagedChanges(repoRoot: string): Promise<boolean> {
  const quiet = await this.runner(['diff', '--cached', '--quiet'], repoRoot, this.timeoutMs);
  if (quiet.code === 1) return true;   // 有差异
  if (quiet.code === 0) return false;  // 无差异
  // 其他退出码（如空仓库没有 HEAD）回退到列文件
  const listed = await this.runner(['diff', '--cached', '--name-only'], repoRoot, this.timeoutMs);
  return listed.code === 0 && listed.stdout.trim().length > 0;
}
```

选这个方式是因为**输出格式会变，退出码是契约**。

### 2. 按范围选择 diff

```ts
const stagedOnly = await this.hasStagedChanges(repoRoot);

const numstatArgs = stagedOnly
  ? ['diff', '--cached', '--numstat', '--']
  : ['diff', '--numstat', 'HEAD', '--'];

const diffArgs = stagedOnly
  ? ['diff', '--cached', '--no-color', '--unified=3', '--']
  : ['diff', 'HEAD', '--no-color', '--unified=3', '--'];
```

### 3. 文件列表的来源

这里有个容易踩的坑。**暂存场景不能用 `git status --porcelain`**：

```bash
# 假设 a.ts 暂存了改动，同时又有未暂存改动，外加一个未跟踪文件
$ git status --porcelain=v1
M  a.ts      ← 已暂存
 M a.ts      ← 同一文件还有未暂存改动
?? b.ts      ← 未跟踪

# porcelain 会把 b.ts 也列进来，但 b.ts 不会进这次 commit
```

所以暂存场景改用 `git diff --cached --name-status -z`，它只反映索引：

```ts
const nameStatusStdout = stagedOnly
  ? await this.runOrThrow(['diff', '--cached', '--name-status', '-z', '--'], repoRoot)
  : '';
```

`-z` 用 NUL 分隔，路径含空格/换行也不会截断。
解析时注意 rename/copy 记录会多一个源路径字段：

```ts
export function parseNameStatus(stdout: string): GitFileChange[] {
  const fields = stdout.split('\0');
  const changes: GitFileChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const rawStatus = fields[index] ?? '';
    if (rawStatus.length === 0) continue;
    const path = fields[index + 1] ?? '';
    index += 1;
    if (path.length === 0) continue;
    const letter = rawStatus.charAt(0);
    if (letter === 'R' || letter === 'C') index += 1;  // 跳过源路径
    changes.push({ path, status: normaliseStatusCode(letter, ' '), insertions: 0, deletions: 0 });
  }
  return changes;
}
```

**关键约束**：暂存场景下绝不回退到 porcelain。即使 `--name-status` 返回空，
也只当作"没有可描述的内容"，而不是改用 porcelain——否则会漏进未暂存文件和未跟踪文件。

### 4. 未跟踪文件只在非暂存场景补

```ts
if (!stagedOnly) {
  const untracked = summary.files.filter(f => f.status === 'A' && f.insertions === 0);
  if (untracked.length > 0) {
    summary.diff += '\n' + untracked.map(f => 'new file: ' + f.path).join('\n');
  }
}
```

原因：未跟踪文件永远不会出现在 diff 里，但用户希望消息能提到它们。
暂存场景不存在这个问题（暂存了就一定在 diff 里）。

### 5. 提示词也随范围调整

```ts
const scopeLine = summary.stagedOnly
  ? 'Generate a commit message for the staged changes below.'
  : 'Generate a commit message for the working-tree changes below. ' +
    '(Nothing is staged, so these are all uncommitted changes.)';
```

模型需要知道范围，否则可能写出"添加了 X"但其实 X 没进这次提交。

---

## 语言设置

配置项：`tabai.git.language`

| 值 | 说明 |
| --- | --- |
| `en`（默认） | 英文 |
| `zh-CN` | 简体中文 |

```json
{
  "tabai.git.language": "zh-CN"
}
```

实现上只是在提示词里加一句：

```ts
const languageRule =
  language === 'zh-CN'
    ? 'Write the message in Simplified Chinese.'
    : 'Write the message in English.';
```

两条规则互斥，不会同时出现。

> 注意：Conventional Commits 的类型前缀（`feat`/`fix`/...）保持英文，
> 因为那是约定格式，翻译后会被工具链拒绝。只翻译冒号后的描述。

---

## 实测

用真实 git 仓库 + 真实 AI 服务验证。

### 范围隔离

```
场景 1: 只有未暂存改动
  stagedOnly: false
  files: [ 'M a.txt', 'A b.txt' ]       ← 含未跟踪的 b.txt
  diff 含 b.txt: true

场景 2: 暂存 a.txt，b.txt 仍未跟踪
  stagedOnly: true
  files: [ 'M a.txt' ]                  ← b.txt 被正确排除
  含未跟踪的 b.txt?: false

场景 3: 再暂存 b.txt
  stagedOnly: true
  files: [ 'M a.txt', 'A b.txt' ]

场景 4: 清空暂存区
  stagedOnly: false
  files: [ 'M a.txt', 'A b.txt' ]
```

### 中英文输出

同一个改动（暂存了 `validateToken`，未暂存一个无关函数和一个未跟踪文件）：

```
=== en ===
subject: "feat(auth): add token validation utility"

=== zh-CN ===
subject: "feat(auth): 添加令牌验证函数validateToken"
```

且生成的内容确实**不含**未暂存的 `unrelatedHelper` 和未跟踪的 `scratch.ts`。

---

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `gitStaging.test.ts` | 暂存判定（退出码 0/1/其他）、范围隔离、空列表返回 null、未跟踪文件补充 |
| `commitPromptLanguage.test.ts` | 中英文规则互斥、范围措辞、非暂存时不谎称 staged |
| `diffSummary.test.ts` | `parseNameStatus` 各种状态与 rename |

总计 608 个测试，覆盖率 97.27%。

---

## 已知边界

**部分暂存同一文件**：`git add -p` 只暂存文件的一部分时，`--name-status` 报整个文件，
diff 只含暂存的那几行。消息基于暂存的 diff，所以描述是准确的；文件列表会显示整个路径。
