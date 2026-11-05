# 改用 `edit_recommends` 模式的问题分析

## 结论先行

**不能直接换。** 不是一个数据结构的替换，而是一次架构变更：
VS Code 的 `InlineCompletionItem` API 在物理上无法表达 `edit_recommends` 的核心语义
（跨行替换 / 删除），必须额外引入**自绘装饰层**才能支撑。

参考项目（MarsCode）正是这么做的：它同时有两条渲染路径，ghost text 只走
"纯插入"的子集，其余全部走 canvas 自绘。

---

## 一、根本约束：VS Code API 只支持单行范围

```ts
// @types/vscode/index.d.ts:5346-5352
export class InlineCompletionItem {
  /**
   * The range to replace.
   * Must begin and end on the same line.        ← 硬约束
   */
  range?: Range;
  insertText: string | SnippetString;
}
```

而 `edit_recommends` 的定义是：

```ts
{
  edit_before: string,          // 原代码（可多行）
  edit_after: string,           // 新代码（可多行）
  edit_area_range: {            // 替换范围（可跨行）
    start: { line, character },
    end:   { line, character },
  }
}
```

**矛盾点**：`edit_area_range.start.line !== end.line` 时，VS Code 会拒绝或忽略这个 range。

实测当前实现的行为：

```
edit_area_range: {start:{line:1,char:0}, end:{line:3,char:0}}   ← 跨 3 行
computeInsertionRange 产出: {start:{line:1,char:4}, end:{line:1,char:13}}
                              ↑ 完全丢弃了 end.line=3
```

也就是说，**「把第 2、3 行删掉」这个操作当前根本无法表达**。

---

## 二、四个具体问题

### 问题 1：跨行替换无法表达（最严重）

场景：用户写了

```python
def foo(x):
    a = x + 1
    return a
```

希望改成

```python
def foo(x):
    return x + 1
```

这是 `edit_recommends` 最擅长的事（`edit_area_range` 覆盖 2..3 行）。
但 ghost text 只能在第 2 行内替换，无法删掉第 3 行。
**结果：用户接受后得到错误的代码。**

### 问题 2：只能"加"不能"减"

`edit_recommends` 天然支持删除（`edit_after` 为空或更短）。
`InlineCompletionItem` 的 `insertText` 必须非空，range 又限定单行。

参考项目对此有明确规则——它在 `checkDiffType` 里直接拒绝：

```js
// 来自 MarsCode 的 deobfuscated 代码
if (block.edit_after.length < block.edit_before.length) return block;  // 纯删除，不支持
if (afterLines.length < beforeLines.length) return block;              // 行数减少，不支持
// 每一行都不能变短
for (let i = 0; i < beforeLines.length; i++) {
  if (beforeLines[i].length > afterLines[i].length) return block;
}
// 字符级 diff 不能有 removed
if (!diffChars(before, after).some(d => d.removed)) { ... }
```

注释写得很清楚：**"内联 ghost text 只能加东西，任何需要删除/改写已有代码的推荐
都不能用 ghost text 显示"**。

### 问题 3：必须引入第二套渲染系统

参考项目的 `_showType` 有三个值：

| showType | 渲染方式 | 能表达什么 |
| --- | --- | --- |
| `inline-text` | 原生 ghost text | 单行插入/替换 |
| `deco-img` | **CanvasKit 自绘图片装饰** | 多行替换、复杂 diff |
| `cursor-jump-tip` | 跳转提示 | 推荐在别处 |

要支持 `edit_recommends` 的全集，就必须实现 `deco-img` 这条路：

- 引入 **CanvasKit（Skia wasm，6.7 MB）** 或等效方案
- 自己做语法高亮 token 着色（参考项目复用了 TextMate 的 token 颜色）
- 自己做逐像素对齐（字体、行高、连字）
- 自己做点击/接受/取消的命中测试

这不是"改个数据结构"，而是**从零实现一个编辑器内渲染引擎**。

### 问题 4：接受逻辑要重写

当前接受流程是 VS Code 原生行为：按 Tab → VS Code 把 `insertText` 替换 `range`。

改成 `edit_recommends` 后，接受必须自己实现：

```ts
// 伪代码
onAccept(editRecommend) {
  const range = toVsCodeRange(editRecommend.edit_area_range);  // 可能跨行
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, editRecommend.edit_after);
  await vscode.workspace.applyEdit(edit);
}
```

连带要处理的：

- **撤销栈**：`WorkspaceEdit` 的撤销粒度 vs 用户期望的"一次撤销"
- **光标位置**：接受后光标该放哪（参考项目为此专门做了 `positionAfterApply` 计算）
- **部分接受**：逐词/逐行接受需要自己按 diff 切分
- **并发编辑**：接受期间用户又打字了怎么办（版本校验）

---

## 三、改成 edit_recommends 能换来什么

| 能力 | 当前 | edit_recommends + 自绘 |
| --- | --- | --- |
| 单行插入 | ✅ | ✅ |
| 多行插入 | ✅ | ✅ |
| 跨行替换 | ❌ | ✅ |
| 删除代码 | ❌ | ✅ |
| 跨文件跳转 | ❌ | ✅ |
| 批量多改 | ❌ | ✅ |
| 实现成本 | 已完成 | +2~4 周，+7 MB 依赖 |

**收益只在"改写型"补全场景**：重命名、重构、修 bug 建议。
对"从光标处往下续写"这个主场景，两者能力相同。

---

## 四、推荐路径（渐进式）

不建议一次性重写。建议分三步，每步都可独立交付：

### 第 1 步：数据结构预留（1 天，零风险）

在内部引入 `EditRecommend` 类型，但**渲染时降级**为单行：

```ts
export interface EditRecommend {
  editBefore: string;
  editAfter: string;
  editAreaRange: CursorRange;
  uri: string;
}

/**
 * 判断这条推荐能否用原生 ghost text 表达。
 * 规则与 MarsCode 的 checkDiffType 一致。
 */
export function canRenderAsGhostText(rec: EditRecommend): boolean {
  const range = rec.editAreaRange;
  if (range.start.line !== range.end.line) return false;      // 跨行
  if (rec.editAfter.length < rec.editBefore.length) return false;  // 净删除
  return true;
}
```

无法表达的推荐直接丢弃（而不是错误地显示）。**行为与现在完全一致，但内部契约对了。**

### 第 2 步：单行替换支持（2~3 天，低风险）

利用 `InlineCompletionItem.range` 的替换语义，支持**单行内**的改写：

```ts
// 原来：range 只覆盖光标到行尾
// 改为：range 覆盖 edit_area_range（单行时合法）
const range = new vscode.Range(
  rec.editAreaRange.start.line, rec.editAreaRange.start.character,
  rec.editAreaRange.end.line,   rec.editAreaRange.end.character,
);
```

这一步能覆盖大部分"改这一行"的需求，且**完全用原生 API，无新依赖**。

### 第 3 步：多行/删除（2~4 周，高风险）

只有确认第 2 步不够用时才做。选项：

| 方案 | 成本 | 说明 |
| --- | --- | --- |
| 装饰器 + `TextEditorDecorationType` | 中 | 用 `after` 装饰显示多行，但无法精确对齐字体 |
| CanvasKit 自绘 | 高 | 与参考项目一致，效果最好 |
| **改用 `vscode.diff` 预览** | 低 | 不显示 ghost text，弹出 diff 视图让用户确认 |

第三条常被忽略：**对"改写型"推荐，diff 预览的体验其实比 ghost text 更好**，
因为用户需要看清楚改了什么。参考项目也在用 `vscode.diff`（`onlyUseVscodeDiff` 选项）。

---

## 五、我的建议

**不要现在改。** 理由：

1. 你当前的核心需求是"AI 代码补全"，即从光标续写。`{text, range}` 完全够用。
2. `edit_recommends` 的价值在"改写"，这需要一个能生成改写建议的模型
   （参考项目用的是专门的 `S-CodeFusionContext`，不是通用 chat 模型）。
   你现在的 `qwen3.6-35b-a3b` 做 FIM 续写很好，但让它输出结构化改写建议质量会明显下降。
3. 实现成本不对称：+2~4 周开发 + 7 MB 依赖，换取一个当前用不上的能力。

**如果要做，按上面的第 1、2 步走**，先拿单行替换验证价值，再决定要不要投第 3 步。

---

## 附：当前实现的一处真实缺陷

`computeInsertionRange` 的 `end.character` 取的是**整行长度**：

```ts
end: { line: position.line, character: Math.max(position.character, currentLine.length) }
```

这意味着如果光标在行中间，`range` 会覆盖光标后的所有内容，
`insertText` 会把这些内容**全部替换掉**。

例如：

```python
result = calculate(a, b)   # 光标在 calculate 后
```

补全 `_total` 时，range 覆盖 `(a, b)`，结果是 `result = calculate_total` —— **后面的参数丢了**。

这是引入 `edit_recommends` 思路能顺带修掉的真实 bug：
正确的 range 应该只覆盖"光标处已有的、与补全冲突的文本"，而不是整行。

建议至少先修这个（用 `filterText` 或收窄 range）。
