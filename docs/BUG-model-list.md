# 故障记录：Show Provider Status 报「did not return a model list」

## 症状

执行 **TabAI: Show Provider Status** 后弹出：

```
TabAI: provider at http://192.168.2.101:1234/api/v1 did not return a model list.
Check the URL and that the server is running.
```

把 URL 改成 `http://192.168.2.101:1234/v1` 后**仍然报同样的错**。

## 两个独立问题

### 问题 1：URL 写成了 `/api/v1`（配置问题）

LM Studio 同时暴露两套 API：

| 路径 | 类型 | 用途 |
| --- | --- | --- |
| `/v1` | OpenAI 兼容 | `/v1/chat/completions`、`/v1/completions`、`/v1/models` |
| `/api/v1` | LM Studio 原生 | `/api/v1/chat`、`/api/v1/models` |
| `/api/v0` | LM Studio 原生（旧） | `/api/v0/models` |

本扩展用的是 **OpenAI 兼容**协议，所以必须填 `/v1`。

```bash
# 正确
curl http://192.168.2.101:1234/v1/models           # 200, {data:[...]}

# 原生 API，扩展的补全端点在这里不存在
curl -X POST http://192.168.2.101:1234/api/v1/chat/completions
# {"error":"Unexpected endpoint or method. (POST /api/v1/chat/completions)"}
```

### 问题 2：`listModels` 用了 POST（代码 bug）

**这才是改成 `/v1` 仍然失败的原因。**

`/v1/models` 只接受 GET。原来的 `listModels` 复用了 `postJson`，发的是 POST：

```bash
curl -X POST http://192.168.2.101:1234/v1/models -d '{}'
# HTTP 200
# {"error":"Unexpected endpoint or method. (POST /v1/models)"}
```

注意 **HTTP 状态码是 200**，不是 4xx。所以 `httpClient` 认为请求成功，
把 `{"error": "..."}` 交给 `parseModelList`，后者找不到 `data` 数组，
返回空数组 —— 最终表现为「没有模型」，而不是「请求失败」。

这是个典型的「静默失败」：错误信息被吞掉，只留下一个误导性的结果。

## 修复

### 1. `httpClient` 支持 GET

```ts
export interface PostJsonOptions {
  // ...
  /** HTTP method. Defaults to `POST`. */
  method?: 'GET' | 'POST';
}
```

GET 请求不再携带 body（带 body 会被部分服务端直接拒绝）：

```ts
const response = await fetchImpl(options.url, {
  method,
  headers,
  ...(method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
  signal: controller.signal,
});
```

### 2. `listModels` 改用 GET

```ts
const response = await postJson({
  url: this.endpoint(settings, '/models'),
  method: 'GET',
  body: {},
  // ...
});
```

### 3. 兼容两种响应形状

`/v1/models` 返回 `{data: [{id}]}`，`/api/v1/models` 返回 `{models: [{key}]}`：

```ts
const collection = Array.isArray(payload['data'])
  ? payload['data']
  : Array.isArray(payload['models'])
    ? payload['models']
    : undefined;
// ...
const id = entry['id'] ?? entry['key'] ?? entry['model_key'];
```

### 4. 状态命令给出可操作的提示

检测到 `/api/v1` 时直接告诉用户应该填什么：

```
TabAI: provider at .../api/v1 did not return a model list.
The URL ends with "/api/v1", which is LM Studio's native API.
Inline completion needs the OpenAI-compatible endpoint: use "...:1234/v1" instead.
```

连接正常但 URL 形状可疑时，状态对话框里也会插入 WARNING 行。

## 验证

```bash
cd plugin && npm run build:e2e && node test/fixtures/checkModels.mjs
```

```
http://192.168.2.101:1234/v1      => qwen3.6-35b-a3b, text-embedding-baai-bge-m3-568m, ...
http://192.168.2.101:1234/api/v1  => qwen3.6-35b-a3b, text-embedding-baai-bge-m3-568m, ...
```

两种 URL 现在都能列出模型（第二种仅用于状态检查；**补全仍须用 `/v1`**）。

新增测试：

| 文件 | 覆盖点 |
| --- | --- |
| `test/unit/httpMethod.test.ts` | GET 无 body、默认 POST、GET 仍带鉴权头 |
| `test/unit/modelList.test.ts` | OpenAI / 原生两种形状、`id` 优先于 `key`、错误体返回空数组 |
| `test/unit/statusDiagnostics.test.ts` | `/api/v1` 提示、通用提示、对话框内 WARNING |

测试总数 492，覆盖率 98.5%。

## 教训

1. **HTTP 200 不等于成功。** 有些服务端把错误塞进 200 响应体里，
   所以解析层必须校验形状，不能只看状态码。
2. **「没数据」和「请求失败」要区分开。** 现在的实现里，
   解析失败返回空数组，调用方无法区分两种情况。可以考虑让
   `parseModelList` 在遇到 `error` 字段时抛错。
3. **URL 形状是可预判的错误。** `/api/v1` 是 LM Studio 用户的高频误配，
   值得在 UI 层直接给出修正建议。
