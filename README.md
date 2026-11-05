> **Language / 语言:** **English** | [简体中文](README.zh-CN.md)

# TabAI

AI inline completion and AI commit messages for VS Code.

- **Inline completion** — suggestions as you type, accept with `Tab`
- **AI commit messages** — generated from your staged diff, in English or Chinese
- **Any OpenAI-compatible server** — LM Studio, Ollama, vLLM, OpenAI
- **Zero runtime dependencies** — uses Node's built-in `fetch`

---

## Contents

- [Quick start](#quick-start)
- [Feature 1: Inline completion](#feature-1-inline-completion)
- [Feature 2: AI commit messages](#feature-2-ai-commit-messages)
- [Commands](#commands)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick start

### 1. Run an AI server

You need an **OpenAI-compatible** inference server. With LM Studio:

1. Load a code model (Qwen2.5-Coder / Qwen3 / DeepSeek-Coder recommended)
2. Start the Local Server and note the port
3. Confirm `http://<host>:<port>/v1/models` returns a model list

> **The path must be `/v1`, not `/api/v1`.** The latter is LM Studio's native API;
> the completion endpoints do not exist there.

### 2. Install the extension

```bash
code --install-extension tabai-0.1.0.vsix --force
```

Or in VS Code: **Extensions → ⋯ → Install from VSIX**.

**Restart VS Code afterwards.** This is required.

### 3. Point it at your server

Open settings (`Cmd+,`) and search for `tabai`:

```json
{
  "tabai.provider.baseUrl": "http://192.168.2.101:1234/v1",
  "tabai.provider.completionModel": "qwen3.6-35b-a3b",
  "tabai.provider.commitModel": "qwen3.6-35b-a3b"
}
```

### 4. Verify the connection

`Cmd+Shift+P` → **TabAI: Show Provider Status**

You should see:

```
Provider: http://192.168.2.101:1234/v1
Protocol: fim
Completion model: qwen3.6-35b-a3b ✓
Commit model: qwen3.6-35b-a3b ✓
Models: qwen3.6-35b-a3b, ...
```

A check mark means the model exists on the server. No check mark means the model name is wrong.

---

## Feature 1: Inline completion

Grey suggestion text appears at the cursor as you write code.

### Controls

| Action | Shortcut |
| --- | --- |
| Accept the whole completion | `Tab` |
| Trigger manually | Ctrl+Alt+\ (Mac: Cmd+Alt+\) |
| Dismiss | `Esc`, or keep typing |
| Accept only the next line | `Shift+Tab` |

### When it fires

- **While typing**: roughly 75 ms after you stop
- **After moving the cursor**: on a new line, or when diagnostics are nearby
- **Manually**: Ctrl+Alt+\

### Files it skips

These languages are ignored to avoid wasting requests:

`log`, `output`, `plaintext`, `search-result`, `git-commit`, `git-rebase`

…plus the `output` panel. Everything else gets completions.

### Two request protocols

Controlled by `tabai.provider.type`:

| Value | Endpoint | Notes | Measured latency |
| --- | --- | --- | --- |
| `fim` (default) | `/v1/completions` | Fill-in-the-middle: the model continues from the cursor. **Faster and more accurate.** | ~115 ms |
| `openai-compatible` | `/v1/chat/completions` | Chat protocol, maximum compatibility | ~220 ms |

**`fim` is recommended.** It lets the model continue directly from the cursor instead of
"understanding a task", so latency is lower and output quality is higher. Only switch to
`openai-compatible` if your server does not implement `/completions`.

### Thinking mode is disabled automatically

Reasoning models (Qwen3, DeepSeek-R1, GLM, Claude, Gemini, o-series) emit a chain of thought
first, and **that trace is billed against your token budget**, which makes completions come
back empty.

Measured with `qwen3.6-35b-a3b` at a 128-token budget:

| Request shape | Reasoning tokens | Latency | Result |
| --- | ---: | ---: | --- |
| No handling | 120 | 2300 ms | **empty** |
| `chat_template_kwargs.enable_thinking=false` | 394 | 8500 ms | usable |
| `reasoning_effort: "none"` | **0** | **115 ms** | usable |

TabAI picks the right switch **per model family**, and escalates to the next one when the
server ignores a field:

```
qwen3         → reasoning_effort=none + enable_thinking=false
deepseek-v3   → chat_template_kwargs.thinking=false
deepseek-r1   → cannot be disabled; warns at runtime
glm-4.5/4.6   → thinking.type=disabled
kimi-k2       → thinking=false
claude        → thinking.type=disabled
gemini        → thinkingBudget=0
gpt-oss       → reasoning_effort=low (cannot fully disable)
o1/o3/gpt-5   → reasoning_effort=minimal (cannot fully disable)
```

**If you switch to a model that cannot disable reasoning** (DeepSeek-R1 and friends), raise
`tabai.completion.maxTokens` to 300 or more, otherwise the trace consumes the whole budget.

### Cross-file context

Before requesting a completion, TabAI scans other files in the workspace for **similar code**
and puts the best matches in the prompt, so the model follows your project's existing naming
and style instead of inventing its own.

Measured: writing a retry helper surfaces the project's own `retry` implementation; writing
an LRU cache surfaces `lruCache`.

Controlled by `tabai.completion.crossFileContext`, on by default.

Turn it off for very large repositories (tens of thousands of files), single-file projects,
or when you do not want your code read at all.

### Caching

Repeated triggers at the same position hit a local cache (100 entries, 60 s TTL) without a
network request.

Use **TabAI: Clear Completion Cache** to empty it.

---

## Feature 2: AI commit messages

### Usage

Open Source Control (`Cmd+Shift+G`) and click the **✨ icon** either to the right of the
message box or in the title bar. The message is filled in for you.

Then press `Cmd+Enter` to commit.

> Both ✨ icons behave identically: they **generate the message only, never commit**.

To generate and commit in one step, use the command palette (`Cmd+Shift+P`) →
**TabAI: Generate Commit Message and Commit**.

### Scope: chosen automatically from the index

| Situation | What gets described |
| --- | --- |
| **Something is staged** | Only the **staged** files |
| **Nothing staged** | **All working-tree changes**, including untracked files |

Example: you stage `a.ts` while also editing `b.ts` and creating an untracked `c.ts`.

- With staged content → the message mentions only `a.ts`
- After unstaging → the message mentions `a.ts`, `b.ts` and `c.ts`

**Why**: when something is staged, that is what the next commit will contain, so the message
should describe exactly that. With nothing staged, the user probably intends to commit
everything, so the message covers everything.

### Output language

Controlled by `tabai.git.language`:

| Value | Example |
| --- | --- |
| `en` (default) | `feat(auth): add token validation utility` |
| `zh-CN` | `feat(auth): 添加令牌验证函数validateToken` |

The Conventional Commits type prefix (`feat`/`fix`/…) **stays in English** because tooling
rejects translated prefixes; only the description after the colon is translated.

### Message format

Controlled by `tabai.git.conventionalCommits`, on by default:

```
feat(auth): add token validation utility

- Implement validateToken with length check
- Reject empty input early
```

Turning it off asks for a plain imperative subject instead.

### It replaces the Copilot button

The sparkle button in VS Code comes from the **Copilot extension**, not the built-in Git
extension. TabAI removes it from the same menu slot with a negative menu declaration, so you
only see one ✨.

Copilot is not uninstalled or disabled: its command still works from the command palette, it
is simply no longer next to your message box.

---

## Commands

| Command | Shortcut | What it does |
| --- | --- | --- |
| **TabAI: Trigger Completion** | Ctrl+Alt+\ | Request a completion now |
| **TabAI: Toggle Completion** | — | Turn completion on or off (writes global settings) |
| **TabAI: Clear Completion Cache** | — | Empty the completion cache |
| **TabAI: Show Provider Status** | — | Check connectivity and list available models |
| **TabAI: Generate Commit Message** | ✨ button | Generate and fill the SCM input box |
| **TabAI: Generate Commit Message and Commit** | — | Generate and commit immediately |

---

## Settings

24 settings. Search for `tabai` in the settings UI, or edit `settings.json` directly.

### Connection

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tabai.provider.type` | `fim` \| `openai-compatible` | `fim` | Request protocol. `fim` is faster and more accurate; only change it if your server lacks `/completions` |
| `tabai.provider.baseUrl` | string | `http://192.168.2.101:1234/v1` | Server address. **Must end with `/v1`** |
| `tabai.provider.apiKey` | string | `""` | Bearer token. Leave empty for local servers |
| `tabai.provider.completionModel` | string | `qwen3.6-35b-a3b` | Model for completion; must match `/v1/models` |
| `tabai.provider.commitModel` | string | `qwen3.6-35b-a3b` | Model for commit messages; may be a stronger model |
| `tabai.provider.timeoutMs` | number | `20000` | Per-request timeout (ms). Raise to 60000 if the model loads slowly |
| `tabai.provider.maxRetries` | number (0-5) | `1` | Retries on transient failures. Only 408/429/5xx are retried |

### Completion behaviour

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tabai.completion.enabled` | boolean | `true` | Master switch. When off, no requests are made at all |
| `tabai.completion.debounceMs` | number (0-1000) | `75` | Total debounce. Raise to send fewer requests, lower for snappier suggestions |
| `tabai.completion.contextDebounceMs` | number (0-500) | `25` | First debounce phase, before context collection starts. **Must be less than `debounceMs`** |
| `tabai.completion.maxPrefixLines` | number | `120` | Lines before the cursor sent to the model. Lower it on huge files to save tokens |
| `tabai.completion.maxSuffixLines` | number | `20` | Lines after the cursor. FIM needs them to continue correctly |
| `tabai.completion.maxTokens` | number | `128` | Max tokens per completion. Raise it for multi-line output or reasoning models |
| `tabai.completion.temperature` | number (0-2) | `0.2` | Sampling temperature. **Keep it low**; high values produce erratic code |
| `tabai.completion.multiline` | boolean | `true` | Allow multi-line completions. Off limits output to the current line |
| `tabai.completion.crossFileContext` | boolean | `true` | Scan the workspace for similar code. Disable on huge repositories |
| `tabai.completion.reasoningMode` | `auto` \| `default` | `auto` | `auto` suppresses thinking; `default` keeps the server default (slower, may return empty) |

### Cache

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tabai.completion.cacheSize` | number | `100` | LRU entries. `0` disables caching entirely |
| `tabai.completion.cacheTtlMs` | number | `60000` | Entry TTL (ms). `0` never expires |

### Commit messages

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tabai.git.maxDiffChars` | number | `12000` | Diff character budget. Raise to 30000 for large changes |
| `tabai.git.conventionalCommits` | boolean | `true` | Request Conventional Commits format (`feat(scope): ...`) |
| `tabai.git.language` | `en` \| `zh-CN` | `en` | Message language |
| `tabai.git.autoCommit` | boolean | `false` | Skip the confirmation dialog for generate-and-commit. **Enable with care** |

### Logging

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tabai.logLevel` | `debug` \| `info` \| `warn` \| `error` \| `none` | `info` | Output channel verbosity. **Set to `debug` when diagnosing** |

---

## How it works

```
keystroke
  → 25 ms context debounce
  → collect prefix/suffix/current line/imports
  → cache lookup (return on hit)
  → top the wait up to 75 ms total
  → cross-file retrieval of similar code (optional)
  → request the AI server
  → post-process (strip FIM sentinels, fences, repeated prefix)
  → return ghost text
```

### Two-phase debounce

The first 25 ms phase collapses rapid keystrokes; the second tops the wait up to 75 ms and
runs **concurrently with context collection**. As long as collection beats the remaining
50 ms, perceived latency stays at a constant 75 ms.

### Post-processing

Model output carries artefacts that are removed before display:

| Artefact | Handling |
| --- | --- |
| `<|fim_pad|>` and friends | Stripped |
| ```typescript ... ``` fences | Stripped |
| Code already present before the cursor | Overlap removed |
| Repetition of the current line | Dropped |
| Consecutive duplicate lines | Collapsed to one |
| Punctuation or whitespace only | Discarded |

### What inline completion cannot do

Inline completion is a **single-line-range insert or replace**, limited by the VS Code API:

- Cross-line replacement (turning 3 lines into 1) — not supported
- Deleting existing code — not supported

This is a hard constraint of `InlineCompletionItem.range`: *"Must begin and end on the same
line"*. Supporting it would require a custom canvas decoration layer, at the cost of pulling
in Skia wasm (~7 MB).

---

## Troubleshooting

### The ✨ icon does nothing, or errors

Check the output channel first: **View → Output** → select **TabAI**.

### No completions appear

1. Confirm `tabai.completion.enabled` is `true`
2. Set `tabai.logLevel` to `debug`
3. Look at the `reason=` in the output channel:

| reason | Meaning | Action |
| --- | --- | --- |
| `disabled` | Completion is switched off | Run Toggle Completion |
| `cancelled` | You moved the cursor | Normal; hold still and retry |
| `skipped` | Position not suitable | Move to the end of a line |
| `rejected` | Output failed post-processing | Try another position |
| `empty` | Model returned nothing | See "empty string" below |
| `error:network` | Cannot reach the server | Check `baseUrl` |
| `error:timeout` | Request timed out | Raise `timeoutMs` |

### The model returns an empty string

This is the classic **reasoning-trace-exhausts-the-budget** symptom.

1. Confirm `tabai.completion.reasoningMode` is `auto`
2. Raise `tabai.completion.maxTokens` to 300 or more
3. Or switch to a non-reasoning model

### Status says "did not return a model list"

- The URL must end with `/v1`, **not `/api/v1`** (that is LM Studio's native API)
- Confirm the server is up: `curl http://<host>:<port>/v1/models`

### Completions are slow

| Symptom | Cause | Action |
| --- | --- | --- |
| Every request >2 s | Using `openai-compatible` with a reasoning model | Switch back to `fim`, verify `reasoningMode` is `auto` |
| Slow first, fast afterwards | Model cold start | Normal; raise `timeoutMs` |
| Always slow | Model too large | Use a smaller model |

### The commit message mentions files that are not staged

Fixed in v0.1.0: with staged content only the index is described. If it still happens,
confirm:

1. You are on the latest build (restart VS Code)
2. The output channel shows `scope=staged` or `scope=all-changes`

### Please restart VS Code before reinstalling

The extensions directory is locked by a running VS Code. Quit VS Code completely
(`Cmd+Q`) and install again.

---

## Development

```bash
cd plugin
npm install
npm run build          # development build
npm run build:prod     # production build (minified)
npm test               # 608 unit tests
npm run test:coverage  # coverage report
npm run typecheck      # type checking
npm run package        # produce a .vsix
```

Coverage: 97.27% statements, 92.94% branches, 97.07% functions.

### Project layout

```
src/
├── extension.ts          activation and wiring
├── core/                 VS Code-free primitives
│   ├── types.ts          shared types + TabAIError
│   ├── logger.ts         logger with a swappable sink
│   ├── cancellation.ts   token → AbortSignal bridge
│   ├── debounce.ts       two-phase debounce
│   ├── lruCache.ts       LRU + TTL cache
│   └── hashing.ts        cache keys
├── config/settings.ts    settings reader and normalisation
├── ai/
│   ├── client.ts         FIM / chat / commit requests
│   ├── httpClient.ts     timeout, retry, error normalisation
│   ├── prompts.ts        prompt construction
│   ├── parsers.ts        response parsing
│   └── reasoning.ts      per-family thinking suppression
├── completion/
│   ├── context.ts        context collection
│   ├── similarity.ts     Jaccard similarity
│   ├── neighborContext.ts cross-file retrieval
│   ├── postProcess.ts    output cleaning
│   ├── engine.ts         completion orchestration
│   └── vscodeProvider.ts VS Code adapter
├── git/
│   ├── diffSummary.ts    porcelain/numstat/diff parsing
│   ├── gitService.ts     git command wrapper
│   ├── commitService.ts  generate + commit orchestration
│   └── gitCommands.ts    command handlers
└── commands/extensionCommands.ts
```

**Layering rule**: only `extension.ts`, `completion/vscodeProvider.ts`,
`git/gitCommands.ts` and `commands/extensionCommands.ts` import `vscode`. Everything else
takes plain data, which is why the whole engine is testable with fake timers and a stubbed
fetch.

### Further reading

- [docs/LOGGING.md](docs/LOGGING.md) — logging and diagnostics
- [docs/CROSS-FILE-CONTEXT.md](docs/CROSS-FILE-CONTEXT.md) — cross-file context internals
- [docs/COMMIT-SCOPE-AND-LANGUAGE.md](docs/COMMIT-SCOPE-AND-LANGUAGE.md) — commit scope and language
- [docs/SCM-BUTTON.md](docs/SCM-BUTTON.md) — replacing the SCM button
- [docs/EDIT-RECOMMENDS-ANALYSIS.md](docs/EDIT-RECOMMENDS-ANALYSIS.md) — why cross-line rewrites are unsupported
- [docs/BUG-model-list.md](docs/BUG-model-list.md) — the `/api/v1` and GET-method issues
- [TESTING.md](TESTING.md) — manual test guide

---

## License

MIT
