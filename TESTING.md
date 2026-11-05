# TabAI 测试指南

扩展已安装到你的 VS Code（`tabai.tabai-0.1.0`），AI 服务 `http://192.168.2.101:1234` 在线，
模型 `qwen3.6-35b-a3b` 可用。

---

## 第 0 步：重启 VS Code

**这一步不能跳过。** 扩展是刚安装的，VS Code 需要重启才能加载。

完全退出 VS Code（<kbd>Cmd</kbd>+<kbd>Q</kbd>）再打开，或执行
**Developer: Reload Window**（<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → 输入 `Reload Window`）。

---

## 第 1 步：确认扩展已激活（30 秒）

按 <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>，输入 **TabAI: Show Provider Status** 并回车。

预期：弹出对话框显示

```
Provider: http://192.168.2.101:1234/v1
Protocol: fim
Completion model: qwen3.6-35b-a3b ✓
Commit model: qwen3.6-35b-a3b ✓
Models: qwen3.6-35b-a3b, text-embedding-...
```

如果显示警告「did not return a model list」，说明服务没连上，先检查服务。

---

## 第 2 步：体验补全（核心功能）

打开 `plugin/demo/demo.py`，把光标放到下面这行的末尾：

```python
def format_currency(amount, currency="USD"):
    """Format an amount as a currency string."""
    █                    ← 光标放这里
```

**方式 A：等它自己出现**（自动触发）
光标停下约 100–300ms 后，应出现灰色 ghost text，例如：

```python
    return f"{currency}{amount:.2f}"
```

**方式 B：手动触发**（更可靠）
按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>\</kbd>。

**方式 C：打字触发**
敲几个字符，比如输入 `ret`，然后停下。

**接受补全**：按 <kbd>Tab</kbd>。

### 该看什么

| 观察点 | 预期 |
| --- | --- |
| 首次出现延迟 | 约 100–800ms（FIM 模式，模型已加载后约 100–200ms） |
| 补全内容 | 与上下文风格一致，缩进正确 |
| 是否带 ```python 包裹 | **不应该有**——后处理会剥离 |
| 是否重复已输入的代码 | **不应该**——`stripPrefixOverlap` 会去掉 |

### 如果没反应

1. 打开输出面板：**View → Output**，右上角下拉选 **TabAI**
2. 看是否有 `completion shown` 或 `no completion: reason=...`
3. 常见 reason 含义：
   - `disabled` — 补全被关了，见第 5 步
   - `cancelled` — 你移动了光标，正常
   - `rejected` — 模型输出被后处理判定为无效
   - `error:network` — 服务连不上
   - `error:timeout` — 超时（默认 20s）

---

## 第 3 步：体验 commit message

在一个 **git 仓库**里（本项目的 `plugin/` 目录就是），随便改一个文件：

```bash
cd plugin
echo "// test change" >> src/core/logger.ts
```

然后在 VS Code 里：

1. 打开源代码管理面板（<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>）
2. 按 <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → **TabAI: Generate Commit Message**
3. 预期：SCM 输入框自动填入类似
   ```
   chore(logger): add test comment to logger module
   ```

想一步到位（生成 + 提交）：**TabAI: Generate Commit Message and Commit**，
会先弹确认框显示 subject，点 **Commit** 才真正提交。

---

## 第 4 步：切换协议对比性能

FIM 和 chat 两种模式延迟差异很大，值得对比。

打开设置（<kbd>Cmd</kbd>+<kbd>,</kbd>），搜索 `tabai.provider.type`：

| 值 | 端点 | 实测延迟 |
| --- | --- | --- |
| `fim`（默认） | `/completions` | ~115–800ms |
| `openai-compatible` | `/chat/completions` | ~220ms（已禁用思考） |

切到 `openai-compatible` 后再试第 2 步，观察质量差异。

**注意**：如果切成 `openai-compatible` 后补全变成空/极慢，说明思考模式没被抑制。
检查 `tabai.completion.reasoningMode` 是否为 `auto`（默认值）。

---

## 第 5 步：验证开关是否生效

| 操作 | 命令 | 预期 |
| --- | --- | --- |
| 关闭补全 | **TabAI: Toggle Completion** | 弹「disabled」，补全不再出现 |
| 重新开启 | 再执行一次 | 弹「enabled」，补全恢复 |
| 清缓存 | **TabAI: Clear Completion Cache** | 弹「cache cleared」 |

关闭后再试第 2 步，应该**完全没有** ghost text，输出面板显示 `no completion: reason=disabled`。

---

## 第 6 步：跑自动化测试（可选，验证代码质量）

```bash
cd plugin
npm test                # 480 个单元测试
npm run test:coverage   # 覆盖率报告，会在 coverage/ 生成 HTML
npm run typecheck       # 类型检查
```

覆盖率应显示：

```
All files   |  98.58 % stmts |  93.6 % branch |  97.38 % funcs |  98.58 % lines
```

打开 `coverage/index.html` 可以点进每个文件看具体哪行被覆盖。

### 真实服务端到端测试

```bash
npm run test:e2e
```

会真实请求你的 AI 服务，输出类似：

```
=== FIM completion ===
text: "return a - b"    latency: 727ms
=== chat completion ===
text: "return a - b"    latency: 221ms
=== commit message ===
subject: "feat(auth): add validateToken function and tests"
```

---

## 调试技巧

### 看实时日志

**View → Output** → 下拉选 **TabAI**。每次补全都会打印：

```
[DEBUG] [tabai] fim request model=qwen3.6-35b-a3b promptChars=412
[DEBUG] [tabai] completion ok in 187ms, chars=31, multiline=false
[DEBUG] [tabai] completion shown: reason=ok fromCache=false duration=187ms triggerKind=0
```

想看更详细的？在设置里把 `tabai.completion` 相关日志级别调高——
目前默认是 `info`，debug 级别需要在 `extension.ts` 里改 `setLogLevel('debug')` 后重新构建。

### 验证思考模式是否真的关了

这是本项目最容易出问题的地方。用 curl 直接测：

```bash
# 带 reasoning_effort=none（扩展用的方式）
curl -s http://192.168.2.101:1234/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"def add(a,b):\n    return a+b\n\ndef sub(a,b):\n    "}],"max_tokens":100,"reasoning_effort":"none"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('reasoning_tokens:', d['usage']['completion_tokens_details']['reasoning_tokens']); print('content:', repr(d['choices'][0]['message']['content']))"

# 不带（会思考，可能返回空）
curl -s http://192.168.2.101:1234/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"def add(a,b):\n    return a+b\n\ndef sub(a,b):\n    "}],"max_tokens":100}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('reasoning_tokens:', d['usage']['completion_tokens_details']['reasoning_tokens']); print('content:', repr(d['choices'][0]['message']['content']))"
```

预期：第一条 `reasoning_tokens: 0` 且有内容，第二条 `reasoning_tokens: 100` 且 content 为空。

### 换模型测试

如果你的服务上有别的模型，改设置：

```json
{
  "tabai.provider.completionModel": "其他模型名"
}
```

扩展会自动识别模型族并选择对应的思考抑制开关（Qwen / DeepSeek / GLM / Claude / Gemini / o系列）。
如果换成 DeepSeek-R1 这类**无法关闭思考**的模型，输出面板会警告：

```
[WARN] [tabai] model "deepseek-r1" cannot disable reasoning (deepseek-reasoner);
       expect slower responses and lower effective token budget
```

---

## 卸载 / 重新安装

```bash
code --uninstall-extension tabai.tabai

# 重新打包安装
cd plugin
npm run build:prod
npx vsce package --no-dependencies --allow-missing-repository --out tabai-0.1.0.vsix
code --install-extension tabai-0.1.0.vsix --force
```

改完代码后记得 **Developer: Reload Window** 才会生效。

---

## 已知限制

1. **自动触发依赖 VS Code 的 inline suggest 机制**。某些情况下（比如刚打开文件）不会自动弹出，
   用 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>\</kbd> 手动触发。
2. **commit 命令要求打开的是 git 仓库**。多根工作区会取当前编辑器所在的仓库。
3. **思考抑制不能 100% 保证**。服务端实现差异大，扩展会逐级重试，
   但 DeepSeek-R1 / o1 这类模型本身不支持关闭。
4. **补全是单光标 ghost text**，不支持参考项目那种跨文件多行改写（那是 CueFlow 的能力，本项目未实现）。
