# 跨文件上下文（Cross-file Context）

## 问题

默认情况下，补全只能看到**当前文件**。模型不知道：

- 项目里已经有 `calculateTotal` 这个函数，它会再造一个 `computeTotal`
- 项目用 `toCents`/`fromCents` 处理金额，它会直接用浮点运算
- 项目的工具函数用 snake_case + docstring，它会写成 camelCase

## 解法

在发请求前扫描工作区，找出与光标周围代码**相似的片段**，放进 prompt。
机制与参考项目（MarsCode）的 `neighborSnippet` 一致：**Jaccard 相似度 + 滑动窗口**。

---

## 实现

### 1. 相似度计算（`src/completion/similarity.ts`）

```ts
tokenize('calculateTotal')  // -> {calculatetotal, calculate, total}
tokenize('calculate_total') // -> {calculate_total, calculate, total}
jaccard(camel, snake)       // -> 0.5  ← 能识别为相关
```

分词策略：
- 保留完整标识符
- 同时按 camelCase / snake_case 拆成词
- 丢弃长度 < 3 的标识符和所有标点

这样 `calculateTotal`、`calculate_total`、`CALCULATE_TOTAL` 都能互相匹配。

### 2. 滑动窗口（`splitIntoWindows`）

一个邻居文件整体看通常不相似——有用的往往只是其中某个函数。
所以按 40 行窗口、20 行步长切分，逐窗比对：

```
文件 200 行 -> 窗口 [0..40] [20..60] [40..80] ... [160..200]
```

这比接 AST 简单得多，且对任何语言都有效。

### 3. 采集流程（`src/completion/neighborContext.ts`）

```
1. 取光标 ±20 行作为查询窗口
2. 遍历工作区源文件（上限 20 个）
3. 每个文件切成 40 行窗口
4. 计算每个窗口与查询的 Jaccard 相似度
5. 过滤 threshold=0.1，按分数排序
6. 取前 3 个，单条 ≤2000 字符，总计 ≤4000 字符
```

### 4. 注入 prompt

FIM 模式下，邻居片段放在 **prefix 之前**：

```
<|fim_prefix|>
// Related code from this project:
// src/internal/money.ts (line 11)
export function sumMoney(amounts: number[]): number {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0));
}

<当前文件 prefix>
<|fim_suffix|><suffix><|fim_middle|>
```

**为什么放在 prefix 之前**：FIM 模型被训练成"从 prefix 之后续写"。
如果把参考代码放在 prefix 之后，模型会把它当作要续写的代码，而不是参考资料。

chat 模式则用标签包裹：

```
<RELATED_CODE_FROM_PROJECT>
// src/internal/money.ts (line 11)
...
</RELATED_CODE_FROM_PROJECT>

<CODE_BEFORE_CURSOR>...</CODE_BEFORE_CURSOR>
<CURSOR>
<CODE_AFTER_CURSOR>...</CODE_AFTER_CURSOR>
```

### 5. VS Code 层文件读取（`gatherNeighborContext`）

只有这一层能访问文件系统：

- `vscode.workspace.findFiles` —— 自动遵守用户的 `files.exclude` / `search.exclude`
- **优先读打开着的文档** —— 未保存的编辑也能看到
- 只扫源码扩展名（`.ts/.py/.go/.rs/...`），跳过 `node_modules`
- 单文件上限 100000 字符
- 读失败的文件静默跳过

### 6. 缓存

补全几乎每次按键都触发，每次都扫工作区会拖垮延迟。
所以按「文件 URI + 行号」缓存 3 秒：

```ts
key = uri + ':' + line
TTL = 3000ms
```

用户在同一行连续打字时复用结果，换行后自动失效。

---

## 实测效果

用插件自身源码测试（24 个 .ts 文件）：

```
=== 正在写重试函数 ===
  src/ai/httpClient.ts  score=0.188  line=61    ← 找到了 isRetryableStatus
  src/ai/httpClient.ts  score=0.125  line=221   ← 找到了 retry 主循环
  src/ai/httpClient.ts  score=0.104  line=81    ← 找到了 computeBackoffMs

=== 正在写 LRU 缓存类 ===
  src/core/lruCache.ts  score=0.156  line=21    ← 找到了 cache 实现
  src/core/lruCache.ts  score=0.154  line=81
  src/completion/engine.ts score=0.114 line=321
```

**写重试函数时准确找到项目的重试实现，写 LRU 时找到 LRU 实现。**

### 对模型输出的实际影响

场景：项目约定所有金额运算走 `toCents`/`fromCents` 避免浮点误差。

**无跨文件上下文**：
```typescript
/**
 * Calculates the total of an array of prices with a given tax rate.
 * @param prices - An array of prices to calculate the total for.
 * ...
 */
const sum = prices.reduce((acc, price) => acc + toCents(price), 0);
return fromCents(applyRate(sum, taxRate));
```
（还带了一大段 JSDoc，被后处理判为噪声）

**有跨文件上下文**：
```typescript
return sumMoney(
    prices.map((price) => applyRate(price, taxRate))
  );
```

模型直接用了项目里已有的 `sumMoney` 和 `applyRate`，而不是自己拼 `reduce`。

---

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `tabai.completion.crossFileContext` | `true` | 是否扫描工作区找相似代码 |

关闭后行为与之前完全一致（只用当前文件）。

### 什么时候该关掉

- 超大仓库（几万个文件）——扫描虽有限流，但 `findFiles` 本身可能慢
- 单文件项目——没有邻居可找，白跑一趟
- 隐私敏感场景——不希望代码片段被读出（虽然只在本机内存里）

---

## 调参

如果想调整检索行为，改 `DEFAULT_NEIGHBOR_OPTIONS`：

```ts
export const DEFAULT_NEIGHBOR_OPTIONS = {
  threshold: 0.1,        // 相似度门槛，调高更严格
  maxSnippets: 3,        // 最多几个片段
  maxSnippetChars: 2000, // 单条上限
  maxTotalChars: 4000,   // 总计上限
  windowLines: 40,       // 窗口行数
  maxFiles: 20,          // 最多扫几个文件
  maxFileChars: 100000,  // 单文件读取上限
};
```

调参建议：

| 症状 | 调整 |
| --- | --- |
| 找到的片段不相关 | 提高 `threshold` 到 0.2~0.3 |
| 找不到想要的 | 降低 `threshold` 到 0.05，或加大 `maxFiles` |
| prompt 太长、变慢 | 减少 `maxTotalChars` 到 2000 |
| 大函数被切断 | 加大 `windowLines` 到 60~80 |

---

## 与参考项目的差异

| 方面 | MarsCode | TabAI |
| --- | --- | --- |
| 相似度 | Jaccard v1/v2、Cosine 多种 | Jaccard |
| 检索范围 | 打开标签页 + 工作区 + CKG 索引 | 工作区文件 |
| 索引 | 有本地 embedding 索引 | 无，实时扫描 |
| 窗口 | AST 感知 | 固定行窗口 |
| 缓存 | 多层 | 3 秒 TTL |

**没有实现 embedding 检索**，因为那需要一个向量索引服务（参考项目为此打包了 396MB 的 resources）。
对单个项目规模（几百个文件）来说，Jaccard 实时扫描已经够用，且零依赖。

如果将来需要支持超大仓库，接入 embedding 是下一步。

---

## 验证

```bash
cd plugin
npm run build:e2e
node test/fixtures/verifyNeighbor.mjs      # 在真实源码上测检索
node test/fixtures/verifyNeighborE2E.mjs   # 对比有/无上下文的模型输出
```

单元测试：

```bash
npx vitest run test/unit/similarity.test.ts test/unit/neighborContext.test.ts test/unit/neighborProvider.test.ts
```

覆盖：分词、Jaccard、窗口切分、排序、阈值、预算截断、缓存命中/失效、文件读取失败。
