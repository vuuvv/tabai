# 日志与诊断

## 为什么之前看不到 debug 信息

`extension.ts` 里日志级别是硬编码的：

```ts
setLogLevel(settingsForLog().completionEnabled ? 'info' : 'warn');
```

而所有请求级诊断（14 处 `logger.debug`）都在 `debug` 级别。级别被钉死在 `info`，
所以那些行**永远不会输出**——包括「为什么没有补全」这个最关键的信息。

修复：新增 `tabai.logLevel` 配置项，启动时从设置读取，改动后实时生效。

---

## 如何开启 debug 日志

### 方式 1：设置界面

<kbd>Cmd</kbd>+<kbd>,</kbd> → 搜索 `tabai.logLevel` → 选 **debug**

### 方式 2：settings.json

```json
{
  "tabai.logLevel": "debug"
}
```

### 方式 3：临时验证

改完设置**不需要重启**，下一次补全请求就会用新级别。
配置变更时输出通道会打印一行确认：

```
[INFO] [tabai] log level changed to "debug"
```

---

## 在哪里看

**View → Output**（<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>），右上角下拉框选 **TabAI**。

---

## 一次成功补全的完整日志

```
[DEBUG] [tabai] request: line=3 char=4 lang=python triggerKind=0
[DEBUG] [tabai] engine: context prefix=123 chars suffix=52 chars middleOfLine=false
[DEBUG] [tabai] engine: sending request after 1ms (model=qwen3.6-35b-a3b)
[DEBUG] [tabai] fim request model=qwen3.6-35b-a3b promptChars=217
[DEBUG] [tabai] completion ok in 1558ms, chars=100, multiline=true
[DEBUG] [tabai] completion shown: reason=ok fromCache=false duration=1558ms triggerKind=0
```

实测该请求返回：

```python
tax_amount = subtotal * (tax_rate / 100)
total = subtotal + tax_amount
return f"{total:.2f}"
```

---

## 日志行含义速查

| 日志 | 含义 |
| --- | --- |
| `request: line=... char=... lang=...` | 收到补全请求 |
| `skip: unsupported document ...` | 语言/scheme 被过滤（日志类文件、output 面板等） |
| `skip: completion disabled ...` | `tabai.completion.enabled` 为 false |
| `engine: token already cancelled before start` | 请求还没开始就被取消（通常是快速连打） |
| `engine: cancelled during context debounce` | 25ms 去抖期间被取消 |
| `engine: skipped middle-of-line position ...` | 光标在行中且 `multiline=false` |
| `engine: context prefix=... suffix=...` | 上下文采集完成 |
| `completion served from cache` | 命中缓存，未发请求 |
| `engine: sending request after Nms` | 去抖结束，即将发请求 |
| `fim request ... promptChars=N` | FIM 请求已构造 |
| `chat request model=...` | chat 请求已构造 |
| `retry N/M in Xms: ...` | 可重试失败，正在退避重试 |
| `completion ok in Nms, chars=N` | 请求成功 |
| `completion rejected: <reason>` | 后处理判定无效 |
| `completion shown: reason=...` | 已返回给 VS Code 显示 |
| `no completion: reason=...` | 没有返回补全，**看 reason** |

## `reason` 取值

| reason | 原因 | 处理 |
| --- | --- | --- |
| `ok` | 成功 | — |
| `cached` | 命中缓存 | — |
| `disabled` | 补全被关闭 | 执行 Toggle Completion |
| `cancelled` | 被取消（移动光标/继续打字） | 正常，静止后再试 |
| `skipped` | 位置不适合补全 | 换到行尾试 |
| `rejected` | 后处理判定无效（空/噪声/重复） | 换位置或调 temperature |
| `empty` | 模型返回空 | 见下方「模型返回空」 |
| `error:network` | 连不上服务 | 检查 baseUrl 和服务 |
| `error:timeout` | 超时 | 调大 `tabai.provider.timeoutMs` |
| `error:http` | 服务端拒绝 | 看完整错误消息 |
| `error:parse` | 响应无法解析 | 服务端返回了非预期格式 |

---

## 常见问题

### 日志里什么都没有

说明 provider 根本没被调用。检查：

1. 文件是否被过滤——日志类语言（`log`、`output`、`plaintext`）会被跳过
2. 扩展是否激活——执行 **TabAI: Show Provider Status** 看有无响应
3. 是否需要重启——新装/重装扩展后必须重启 VS Code

### 有 `request:` 但没有 `engine:`

去抖阶段被取消了，说明你在 25ms 内又触发了新的请求。
把光标停稳再试。

### `completion ok` 但界面没显示

如果日志里是 `completion ok` 紧接着 `completion shown`，但界面没出现 ghost text，
这是 VS Code 的 inline suggest 渲染问题，不是扩展的问题。尝试：

- 手动触发 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>\</kbd>
- 确认 `editor.inlineSuggest.enabled` 为 true
- 检查是否被其他补全扩展抢占（Copilot 等）

### 模型返回空字符串

这是思考模式耗尽 token 预算的典型症状。检查日志里是否有：

```
[INFO] [tabai] reasoning suppressed with plan "..." (family=qwen3)
```

如果没有这行，或者有：

```
[WARN] [tabai] all reasoning-suppression plans failed for "..."
```

说明思考没被关掉。确认 `tabai.completion.reasoningMode` 是 `auto`（默认），
并把 `tabai.completion.maxTokens` 调大（至少 300）。

### 换成 DeepSeek-R1 后特别慢

该模型无法关闭思考。日志会警告：

```
[WARN] [tabai] model "deepseek-r1" cannot disable reasoning (deepseek-reasoner);
       expect slower responses and lower effective token budget
```

换非推理模型，或把 `maxTokens` 调到 500 以上。

---

## 验证日志确实在工作

不启动 VS Code 也能验证：

```bash
cd plugin
npm run build:e2e
node test/fixtures/verifyLogging.mjs   # 离线，验证引擎日志
node test/fixtures/verifyReal.mjs      # 真实请求 AI 服务
```

`verifyLogging.mjs` 输出：

```
=== 捕获到的日志行 ===
  [DEBUG] [tabai] engine: context prefix=19 chars suffix=0 chars middleOfLine=false
  [DEBUG] [tabai] engine: sending request after 2ms (model=qwen3.6-35b-a3b)
  [DEBUG] [tabai] completion ok in 2ms, chars=12, multiline=false
  [DEBUG] [tabai] engine: completion disabled
  [DEBUG] [tabai] engine: completion served from cache
```

---

## 日志级别对照

| 级别 | 内容 | 适用场景 |
| --- | --- | --- |
| `debug` | 每个请求的完整生命周期 + 跳过原因 | 排查「为什么不补全」 |
| `info` | 生命周期事件、思考抑制计划、提交信息生成 | 日常使用（默认） |
| `warn` | 警告（无法关闭思考、重试） | 减少噪音 |
| `error` | 仅错误 | 生产环境 |
| `none` | 完全静默 | — |
