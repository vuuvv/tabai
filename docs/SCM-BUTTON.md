# 替换 SCM 面板的「生成提交消息」按钮

## 背景

VS Code 源代码管理（SCM）输入框右侧那颗 sparkle（✨）按钮，**不是 VS Code 内置 Git 扩展提供的**。
排查结果：

```bash
# 内置 git 扩展没有任何 scm/inputBox 菜单贡献
$ python3 -c "...menus.get('scm/inputBox', [])"    # -> []

# 这颗按钮来自 Copilot 扩展
$ python3 -c "...copilot/package.json...['menus']['scm/inputBox']"
{"command": "github.copilot.git.generateCommitMessage",
 "when": "scmProvider == git && chatSetupCompleted"}
```

所以「替换」在实现上有两条路：

1. **隐藏 Copilot 的按钮** + **加上自己的按钮**（本方案）
2. 直接复用 Copilot 的命令（做不到，那是别人的私有命令）

---

## 实现

### 1. 在输入框添加自己的按钮

```json
"menus": {
  "scm/inputBox": [
    { "command": "tabai.generateCommitMessage", "when": "scmProvider == git" }
  ]
}
```

`scm/inputBox` 是 VS Code 公开的菜单位置，正好是提交消息输入框那一条。
命令需要声明 `icon`，否则显示文字而不显示图标：

```json
{
  "command": "tabai.generateCommitMessage",
  "title": "TabAI: Generate Commit Message",
  "icon": "$(sparkle)"
}
```

### 2. 隐藏 Copilot 的原按钮

菜单贡献支持**负向声明**：命令名以 `-` 开头即表示「从该位置移除」。

```json
"scm/inputBox": [
  { "command": "tabai.generateCommitMessage", "when": "scmProvider == git" },
  { "command": "-github.copilot.git.generateCommitMessage", "when": "scmProvider == git" }
]
```

注意负向声明只影响**菜单显示**，不卸载 Copilot，也不影响它从命令面板调用。

### 3. 标题栏同样使用「只生成」命令

SCM 标题栏也挂同一个命令，图标一致都是 ✨：

```json
"scm/title": [
  {
    "command": "tabai.generateCommitMessage",
    "when": "scmProvider == git",
    "group": "navigation@10"
  }
]
```

两处入口共用一条命令，所以行为完全一致——**都只生成消息写入输入框，不提交**。

`tabai.generateCommitMessageAndCommit`（生成并提交）仍然存在，但**不再出现在任何菜单里**，
只能从命令面板手动调用。这是刻意的：提交是破坏性操作，不该在一键可达的位置。

> 早期版本曾把「生成并提交」放在标题栏（✓ 图标）。后来改掉了，因为用户容易误点，
> 而且 ✔ 图标容易被理解成"确认提交"而不是"生成并提交"。

---

## 顺带修复：多根工作区写错输入框

从 SCM 面板触发时，活动编辑器可能是任意文件，原实现总是取 `repositories[0]`：

```ts
// 修复前
const repository = api?.repositories[0];
return repository?.inputBox;
```

多根工作区里这会把提交消息写进**错误的仓库输入框**。

修复后按 cwd 匹配所属仓库：

```ts
export function getScmInputBox(cwd?: string): vscode.SourceControlInputBox | undefined {
  const repositories = api?.repositories;
  // ...
  if (cwd !== undefined) {
    const match = repositories.find(
      (repository) =>
        cwd === repository.rootUri.fsPath ||
        cwd.startsWith(repository.rootUri.fsPath + '/'),
    );
    if (match !== undefined) return match.inputBox;
  }
  return repositories[0]?.inputBox;
}
```

用 `fsPath + '/'` 而不是裸 `startsWith`，避免 `/repo` 错误匹配 `/repo-other`。

---

## 使用

重启 VS Code 后：

1. 打开源代码管理面板（<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>）
2. 改几个文件
3. 点击 **✨ 图标** —— 输入框右侧和标题栏各有一个，行为相同
4. 提交消息自动填入输入框，**不会自动提交**

想提交就按 <kbd>Cmd</kbd>+<kbd>Enter</kbd>（VS Code 原生）或点 ✓ 按钮。

需要「生成并提交」时，用命令面板：<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> →
`TabAI: Generate Commit Message and Commit`。

### 验证按钮归属

点击后看输出面板（**View → Output → TabAI**）：

```
[INFO] [tabai] commit message generated in 708ms using qwen3.6-35b-a3b
```

有这行就是 TabAI 在处理。如果是 Copilot 在跑，日志里不会有这行。

---

## 局限

### 1. 负向声明依赖 VS Code 的实现细节

`-` 前缀是 VS Code 菜单系统的既有行为（`extensions/git` 自身也用这种方式隐藏命令），
但它**不在公开 API 文档里**。VS Code 升级后有失效的可能。

如果某天发现两个 sparkle 图标同时出现，说明负向声明失效了，此时可以：
- 禁用整个 Copilot 扩展，或者
- 改用 `when` 让条件互斥（例如设一个自定义 context key）

### 2. 无法真正"替换" Copilot 的命令

Copilot 的命令 `github.copilot.git.generateCommitMessage` 仍可从命令面板调起。
负向声明只隐藏菜单项。如果想连命令面板也去掉，可以在 `commandPalette` 里加负向声明，
但那会影响用户显式使用 Copilot 的预期，所以**没有做**。

### 3. Copilot 未安装时

负向声明指向一个不存在的命令，VS Code 会静默忽略，不报错。
所以没装 Copilot 的用户也能正常使用。

---

## 测试覆盖

`test/unit/manifest.test.ts`（10 个）验证清单契约：

| 断言 | 目的 |
| --- | --- |
| `tabai.generateCommitMessage` 出现在 `scm/inputBox` | 按钮真的会渲染 |
| `when` 为 `scmProvider == git` | 不会在 Mercurial 等其他 provider 下误显示 |
| 负向声明的 Copilot 命令存在 | 不会出现两个 sparkle |
| 命令声明了 `icon: $(sparkle)` | 显示图标而非文字 |
| 菜单里引用的每个命令都已声明 | 避免"命令不存在"的空按钮 |
| 键位引用的命令都已声明 | 同上 |

`test/unit/scmInputBox.test.ts`（6 个）验证多根工作区解析：

| 场景 | 期望 |
| --- | --- |
| 无 cwd | 取第一个仓库 |
| cwd 在第二仓库内 | 取第二仓库 |
| cwd 等于仓库根 | 匹配成功 |
| `/repo-other` 与 `/repo` | 不误匹配 |
| cwd 不在任何仓库 | 回退第一个 |
| 无仓库 | 返回 undefined |

---

## 如果不想隐藏 Copilot

只想**加**一个按钮、保留 Copilot 的，删掉这一行即可：

```json
{ "command": "-github.copilot.git.generateCommitMessage", "when": "scmProvider == git" }
```

两个 sparkle 并排显示，用户自己选。这也是更"礼貌"的做法——不覆盖其他扩展的行为。
