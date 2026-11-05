> **语言 / Language:** [English](https://github.com/vuuvv/tabai/blob/HEAD/README.md) | **简体中文**

# TabAI

为 VS Code 提供 AI 代码补全与 AI 提交信息生成。

- **内联补全** —— 边写边提示，按 `Tab` 接受
- **AI 提交信息** —— 从暂存区的 diff 生成 commit message，支持中英文
- **任意 OpenAI 兼容服务** —— LM Studio / Ollama / vLLM / OpenAI 都可以
- **零运行时依赖** —— 只用 Node 内置 `fetch`，装完即用

---

## 目录

- [快速开始](#快速开始)
- [功能一：内联补全](#功能一内联补全)
- [功能二：AI 提交信息](#功能二ai-提交信息)
- [全部命令](#全部命令)
- [全部设置](#全部设置)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [开发](#开发)

---

## 快速开始

### 1. 装好 AI 服务

需要一个 **OpenAI 兼容**的推理服务。以 LM Studio 为例：

1. 加载一个代码模型（推荐 Qwen2.5-Coder / Qwen3 / DeepSeek-Coder 系列）
2. 打开 Local Server，确认端口
3. 访问 `http://<host>:<port>/v1/models` 能看到模型列表

> **路径必须是 `/v1`**，不是 `/api/v1`。后者是 LM Studio 的原生 API，
> 补全端点在那里不存在。

### 2. 安装扩展

```bash
code --install-extension tabai-0.1.0.vsix --force
```

或在 VS Code 里：**Extensions → ⋯ → Install from VSIX**。

装完**必须重启 VS Code**。

### 3. 配置服务地址

打开设置（`Cmd+,`），搜 `tabai`：

```json
{
  "tabai.provider.baseUrl": "http://192.168.2.101:1234/v1",
  "tabai.provider.completionModel": "qwen3.6-35b-a3b",
  "tabai.provider.commitModel": "qwen3.6-35b-a3b"
}
```

### 4. 验证连接

`Cmd+Shift+P` → **TabAI: Show Provider Status**

应该看到：

```
Provider: http://192.168.2.101:1234/v1
Protocol: fim
Completion model: qwen3.6-35b-a3b ✓
Commit model: qwen3.6-35b-a3b ✓
Models: qwen3.6-35b-a3b, ...
```

绿色的 ✓ 表示模型在服务端存在。没有 ✓ 说明模型名写错了。

---

## 功能一：内联补全

在编辑器里写代码时，光标处会出现灰色的建议文本。

### 怎么用

| 操作 | 快捷键 |
| --- | --- |
| 接受整条补全 | `Tab` |
| 手动触发 | Ctrl+Alt+\（Mac: Cmd+Alt+\） |
| 忽略 | `Esc` 或继续打字 |
| 只接受下一行 | `Shift+Tab` |

### 什么时候会触发

- **打字时**：停下约 75ms 后自动请求
- **移动光标后**：换行、或附近有诊断报错时触发
- **手动**：Ctrl+Alt+\

### 什么文件不会补全

以下语言会被跳过，避免浪费请求：

`log`、`output`、`plaintext`、`search-result`、`git-commit`、`git-rebase`

以及 `output` 面板。其他文件都会补全。

### 两种请求协议

由 `tabai.provider.type` 控制：

| 值 | 端点 | 特点 | 实测延迟 |
| --- | --- | --- | --- |
| `fim`（默认） | `/v1/completions` | 用 FIM 标记让模型从光标处续写，**更快更准** | ~115ms |
| `openai-compatible` | `/v1/chat/completions` | 走 chat 协议，兼容性最好 | ~220ms |

**推荐 `fim`**。FIM 让模型直接从光标处续写，不需要"理解任务"，延迟低且输出质量更好。
只有服务端不支持 `/completions` 时才切到 `openai-compatible`。

### 思考模式会被自动关闭

推理模型（Qwen3、DeepSeek-R1、GLM、Claude、Gemini、o 系列）会先输出一大段"思考过程"，
这段内容**会吃掉 token 预算**，导致补全变成空字符串。

实测（`qwen3.6-35b-a3b`，128 token 预算）：

| 请求方式 | 思考 token | 延迟 | 结果 |
| --- | ---: | ---: | --- |
| 不做处理 | 120 | 2300ms | **空** |
| `chat_template_kwargs.enable_thinking=false` | 394 | 8500ms | 可用 |
| `reasoning_effort: "none"` | **0** | **115ms** | 可用 |

TabAI 会**按模型族自动选择正确的开关**，并且服务端不认这个开关时自动降级重试：

```
qwen3         → reasoning_effort=none + enable_thinking=false
deepseek-v3   → chat_template_kwargs.thinking=false
deepseek-r1   → 无法关闭，运行时告警
glm-4.5/4.6   → thinking.type=disabled
kimi-k2       → thinking=false
claude        → thinking.type=disabled
gemini        → thinkingBudget=0
gpt-oss       → reasoning_effort=low（无法完全关闭）
o1/o3/gpt-5   → reasoning_effort=minimal（无法完全关闭）
```

**换成无法关闭思考的模型时**（如 DeepSeek-R1），把 `tabai.completion.maxTokens` 调到 300 以上，
否则思考会耗尽预算。

### 跨文件上下文

补全时会扫描工作区其他文件，找出**相似的代码片段**放进 prompt，
让模型沿用项目已有的命名和写法，而不是自己发明一套。

实测：写重试函数时能找到项目里的 `retry` 实现，写 LRU 缓存时能找到 `lruCache`。

由 `tabai.completion.crossFileContext` 控制，默认开启。

关闭场景：超大仓库（几万文件）、单文件项目、或不想让代码被读取。

### 缓存

同一位置连续触发会命中缓存（默认 100 条，60 秒过期），不发请求。

用 **TabAI: Clear Completion Cache** 手动清空。

---

## 功能二：AI 提交信息

### 怎么用

打开源代码管理面板（`Cmd+Shift+G`），点输入框右侧的 **✨ 图标**
或标题栏的 **✨ 图标**，提交信息会自动填入。

然后按 `Cmd+Enter` 提交。

> 两个 ✨ 图标行为相同，都**只生成消息，不提交**。

需要"生成并提交"时用命令面板：`Cmd+Shift+P` →
**TabAI: Generate Commit Message and Commit**。

### 生成范围：自动按暂存区判断

| 场景 | 描述的内容 |
| --- | --- |
| **有暂存内容** | 只描述**暂存区**的文件 |
| **无暂存内容** | 描述**所有工作区改动**（含未跟踪文件） |

举例：暂存了 `a.ts`，同时又改了 `b.ts`、新建了未跟踪的 `c.ts`：

- 有暂存 → 消息只提 `a.ts`
- 清空暂存区 → 消息提 `a.ts`、`b.ts`、`c.ts`

**为什么这样设计**：有暂存时，这次 commit 只会包含暂存的文件，消息就该只描述这些；
没有暂存时，用户大概想全部提交，消息就覆盖全部。

### 输出语言

由 `tabai.git.language` 控制：

| 值 | 示例输出 |
| --- | --- |
| `en`（默认） | `feat(auth): add token validation utility` |
| `zh-CN` | `feat(auth): 添加令牌验证函数validateToken` |

Conventional Commits 的类型前缀（`feat`/`fix`/...）**保持英文**，因为翻译后工具链会拒绝；
只翻译冒号后的描述。

### 提交信息格式

由 `tabai.git.conventionalCommits` 控制，默认开启：

```
feat(auth): add token validation utility

- Implement validateToken with length check
- Reject empty input early
```

关闭后会要求普通的祈使句风格。

### 替换了 Copilot 的按钮

VS Code 里那颗 sparkle 按钮来自 **Copilot 扩展**（不是内置 Git 扩展）。
TabAI 通过菜单负向声明把它从同一位置移除，所以只会看到一个 ✨。

装了 Copilot 也不冲突：它的命令仍可从命令面板调用，只是不在输入框旁边了。

---

## 全部命令

| 命令 | 快捷键 | 作用 |
| --- | --- | --- |
| **TabAI: Trigger Completion** | Ctrl+Alt+\ | 手动请求一次补全 |
| **TabAI: Toggle Completion** | — | 开关补全（写入全局设置） |
| **TabAI: Clear Completion Cache** | — | 清空补全缓存 |
| **TabAI: Show Provider Status** | — | 检查服务连通性、列出可用模型 |
| **TabAI: Generate Commit Message** | ✨ 按钮 | 生成提交信息填入 SCM 输入框 |
| **TabAI: Generate Commit Message and Commit** | — | 生成并直接提交 |

---

## 全部设置

共 24 项。全部可在设置界面搜索 `tabai` 找到，也可以直接改 `settings.json`。

### 服务连接

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tabai.provider.type` | `fim` \| `openai-compatible` | `fim` | 请求协议。`fim` 更快更准，服务端不支持 `/completions` 时才改 |
| `tabai.provider.baseUrl` | string | `http://192.168.2.101:1234/v1` | 服务地址，**必须以 `/v1` 结尾** |
| `tabai.provider.apiKey` | string | `""` | Bearer token。本地服务留空 |
| `tabai.provider.completionModel` | string | `qwen3.6-35b-a3b` | 补全用的模型名，必须与服务端 `/v1/models` 一致 |
| `tabai.provider.commitModel` | string | `qwen3.6-35b-a3b` | 生成提交信息用的模型。可以换成更强的模型 |
| `tabai.provider.timeoutMs` | number | `20000` | 单次请求超时（毫秒）。模型首次加载慢时调到 60000 |
| `tabai.provider.maxRetries` | number (0-5) | `1` | 网络抖动时的重试次数。只对 408/429/5xx 重试 |

### 补全行为

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tabai.completion.enabled` | boolean | `true` | 补全总开关。关掉后完全不发请求 |
| `tabai.completion.debounceMs` | number (0-1000) | `75` | 总去抖时长。调大减少请求，调小更灵敏 |
| `tabai.completion.contextDebounceMs` | number (0-500) | `25` | 第一阶段去抖，之后开始采集上下文。**必须小于 `debounceMs`** |
| `tabai.completion.maxPrefixLines` | number | `120` | 发给模型的光标**前**行数。大文件可调小省 token |
| `tabai.completion.maxSuffixLines` | number | `20` | 发给模型的光标**后**行数。FIM 需要它来接续 |
| `tabai.completion.maxTokens` | number | `128` | 单次补全的最大 token 数。多行补全或思考模型需调大 |
| `tabai.completion.temperature` | number (0-2) | `0.2` | 采样温度。补全建议**保持低值**，高了会生成发散代码 |
| `tabai.completion.multiline` | boolean | `true` | 是否允许生成多行。关掉只补当前行 |
| `tabai.completion.crossFileContext` | boolean | `true` | 扫描工作区找相似代码。大仓库可关掉提速 |
| `tabai.completion.reasoningMode` | `auto` \| `default` | `auto` | `auto` 自动关闭思考模式；`default` 保持服务端默认（会更慢且可能返回空） |

### 缓存

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tabai.completion.cacheSize` | number | `100` | LRU 缓存条数。`0` 完全禁用缓存 |
| `tabai.completion.cacheTtlMs` | number | `60000` | 缓存过期时间（毫秒）。`0` 永不过期 |

### 提交信息

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tabai.git.maxDiffChars` | number | `12000` | 发给模型的 diff 字符上限。大改动调到 30000 |
| `tabai.git.conventionalCommits` | boolean | `true` | 是否要求 Conventional Commits 格式（`feat(scope): ...`） |
| `tabai.git.language` | `en` \| `zh-CN` | `en` | 提交信息语言 |
| `tabai.git.autoCommit` | boolean | `false` | 「生成并提交」时跳过确认框。**谨慎开启** |

### 日志

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tabai.logLevel` | `debug` \| `info` \| `warn` \| `error` \| `none` | `info` | 输出通道详细程度。**排查问题时改成 `debug`** |

---

## 工作原理

```
按键
  → 25ms 上下文去抖
  → 采集 prefix/suffix/当前行/imports
  → 查缓存（命中则直接返回）
  → 补足等待至 75ms 总计
  → 跨文件检索相似代码（可选）
  → 发请求给 AI 服务
  → 后处理（剥离 FIM 标记/代码围栏/重复前缀）
  → 返回 ghost text
```

### 两级去抖

第一阶段 25ms 用来合并连续按键；第二阶段补足到 75ms，**与上下文采集并行**。
所以只要采集快于剩下的 50ms，用户感知延迟就恒定为 75ms。

### 后处理

模型输出经常带杂质，会被清掉：

| 杂质 | 处理 |
| --- | --- |
| `<|fim_pad|>` 等标记 | 剥离 |
| ```typescript ... ``` 代码围栏 | 剥离 |
| 重复光标前已有的代码 | 去掉重叠部分 |
| 重复当前行 | 去掉 |
| 连续重复行 | 折叠为一行 |
| 纯标点/空白 | 整条丢弃 |

### 补全不能做什么

内联补全是**单行范围的插入/替换**，受 VS Code API 限制：

- 跨行替换（把 3 行改成 1 行）——不支持
- 删除已有代码——不支持

这是 `InlineCompletionItem.range` 的硬约束：*"Must begin and end on the same line"*。
需要这类能力得自绘 canvas 装饰层，代价是引入 Skia wasm（约 7MB）。

---

## 常见问题

### ✨ 图标点击没反应 / 报错

先看输出面板：**View → Output** → 下拉选 **TabAI**。

### 补全不出现

1. 确认 `tabai.completion.enabled` 是 `true`
2. 把 `tabai.logLevel` 改成 `debug`
3. 打开输出面板看 `reason=` 是什么：

| reason | 含义 | 处理 |
| --- | --- | --- |
| `disabled` | 补全被关了 | 执行 Toggle Completion |
| `cancelled` | 你移动了光标 | 正常，停稳再试 |
| `skipped` | 位置不适合补全 | 换到行尾 |
| `rejected` | 输出被后处理判为无效 | 换位置 |
| `empty` | 模型返回空 | 见下方"返回空字符串" |
| `error:network` | 连不上服务 | 检查 `baseUrl` |
| `error:timeout` | 超时 | 调大 `timeoutMs` |

### 模型返回空字符串

这是**思考模式耗尽 token 预算**的典型症状。

1. 确认 `tabai.completion.reasoningMode` 是 `auto`
2. 把 `tabai.completion.maxTokens` 调到 300 以上
3. 换非推理模型

### 状态检查说"did not return a model list"

- URL 结尾必须是 `/v1`，**不能是 `/api/v1`**（那是 LM Studio 原生 API）
- 确认服务已启动：`curl http://<host>:<port>/v1/models`

### 补全很慢

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 每条都 >2s | 用的 `openai-compatible` 且模型在思考 | 切回 `fim`，或确认 `reasoningMode` 是 `auto` |
| 首次很慢之后正常 | 模型冷启动 | 正常，`timeoutMs` 调大 |
| 一直慢 | 模型太大 | 换更小的模型 |

### 提交信息包含了不该有的文件

从 v0.1.0 起已修复：有暂存内容时只描述暂存区。如果仍然不对，确认：

1. 装的是最新版（重启 VS Code）
2. 输出面板日志里是 `scope=staged` 还是 `scope=all-changes`

### Please restart VS Code before reinstalling

扩展目录被运行中的 VS Code 占用。完全退出 VS Code（`Cmd+Q`）再安装。

---

## 开发

```bash
cd plugin
npm install
npm run build          # 开发构建
npm run build:prod     # 生产构建（压缩）
npm test               # 608 个单元测试
npm run test:coverage  # 覆盖率报告
npm run typecheck      # 类型检查
npm run package        # 打包 .vsix
```

覆盖率：语句 97.27%、分支 92.93%、函数 97.07%。

### 项目结构

```
src/
├── extension.ts          激活、接线
├── core/                 无 vscode 依赖的基础层
│   ├── types.ts          类型定义 + TabAIError
│   ├── logger.ts         日志（sink 可替换）
│   ├── cancellation.ts   取消令牌桥接
│   ├── debounce.ts       两级去抖
│   ├── lruCache.ts       LRU + TTL 缓存
│   └── hashing.ts        缓存键
├── config/settings.ts    设置读取与归一化
├── ai/
│   ├── client.ts         FIM / chat / commit 请求
│   ├── httpClient.ts     超时、重试、错误归一化
│   ├── prompts.ts        提示词构造
│   ├── parsers.ts        响应解析
│   └── reasoning.ts      按模型族关闭思考
├── completion/
│   ├── context.ts        上下文采集
│   ├── similarity.ts     Jaccard 相似度
│   ├── neighborContext.ts 跨文件检索
│   ├── postProcess.ts    输出清洗
│   ├── engine.ts         补全编排
│   └── vscodeProvider.ts VS Code 适配
├── git/
│   ├── diffSummary.ts    porcelain/numstat/diff 解析
│   ├── gitService.ts     git 命令封装
│   ├── commitService.ts  生成 + 提交编排
│   └── gitCommands.ts    命令处理
└── commands/extensionCommands.ts
```

**分层原则**：只有 `extension.ts`、`completion/vscodeProvider.ts`、`git/gitCommands.ts`、
`commands/extensionCommands.ts` 导入 `vscode`。其他模块只接受纯数据，
所以整个引擎可以用假定时器和 stub fetch 测试。

### 更多文档

- [docs/LOGGING.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/LOGGING.md) —— 日志与诊断
- [docs/CROSS-FILE-CONTEXT.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/CROSS-FILE-CONTEXT.md) —— 跨文件上下文实现
- [docs/COMMIT-SCOPE-AND-LANGUAGE.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/COMMIT-SCOPE-AND-LANGUAGE.md) —— 提交范围与语言
- [docs/SCM-BUTTON.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/SCM-BUTTON.md) —— 替换 SCM 按钮
- [docs/EDIT-RECOMMENDS-ANALYSIS.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/EDIT-RECOMMENDS-ANALYSIS.md) —— 为何不支持跨行改写
- [docs/BUG-model-list.md](https://github.com/vuuvv/tabai/blob/HEAD/docs/BUG-model-list.md) —— `/api/v1` 与 GET 方法的问题
- [TESTING.md](https://github.com/vuuvv/tabai/blob/HEAD/TESTING.md) —— 手动测试指南

---

## 许可

MIT