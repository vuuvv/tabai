/**
 * Shared type definitions for the TabAI extension.
 *
 * Everything in this module is dependency-free so it can be imported by unit
 * tests without a running VS Code instance.
 */

/**
 * The API shape used to talk to the configured AI provider.
 *
 * - `openai-compatible` sends a chat completion request with a system prompt
 *   and a user message. Slower but universally supported.
 * - `fim` sends a raw text completion request using fill-in-the-middle tokens.
 *   Much faster because the model starts generating at the cursor immediately.
 */
export type ProviderType = 'openai-compatible' | 'fim';

/** A single document position, 0-based, mirroring the VS Code convention. */
export interface CursorPosition {
  /** Zero-based line number. */
  line: number;
  /** Zero-based character offset inside the line. */
  character: number;
}

/** A text range expressed with two positions. */
export interface CursorRange {
  /** Inclusive start position. */
  start: CursorPosition;
  /** Exclusive end position. */
  end: CursorPosition;
}

/**
 * The full set of settings the extension reads from the workspace
 * configuration. A snapshot is taken per request so that a settings change
 * cannot corrupt an in-flight completion.
 */
export interface TabAISettings {
  /** Which provider protocol to use. */
  providerType: ProviderType;
  /** Base URL of the OpenAI-compatible endpoint, without a trailing slash. */
  baseUrl: string;
  /** Optional bearer token; empty string means "no auth header". */
  apiKey: string;
  /** Model id used for inline completion requests. */
  completionModel: string;
  /** Model id used for commit message generation. */
  commitModel: string;
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs: number;
  /** How many times a transient failure is retried. */
  maxRetries: number;
  /** Master switch for inline completion. */
  completionEnabled: boolean;
  /** Total debounce applied before a request is issued. */
  debounceMs: number;
  /** First debounce phase, after which context collection starts. */
  contextDebounceMs: number;
  /** Maximum number of prefix lines sent to the model. */
  maxPrefixLines: number;
  /** Maximum number of suffix lines sent to the model. */
  maxSuffixLines: number;
  /** Maximum tokens the model may generate for a completion. */
  maxTokens: number;
  /** Sampling temperature for completion. */
  temperature: number;
  /** Whether multi-line completions are allowed. */
  multiline: boolean;
  /**
   * Whether to scan the workspace for similar code and include it in the
   * prompt.
   *
   * Costs a filesystem pass per request, so it is opt-out for very large
   * repositories.
   */
  crossFileContext: boolean;
  /**
   * How to handle a reasoning model's chain of thought.
   *
   * `auto` suppresses it using the switch for the detected model family and
   * escalates through alternatives when the server ignores that switch;
   * `off` is treated as `auto`; `default` leaves the server's own default.
   */
  reasoningMode: ReasoningMode;
  /** Maximum number of cached completion results. */
  cacheSize: number;
  /** Time-to-live of a cache entry in milliseconds. */
  cacheTtlMs: number;
  /** Maximum number of diff characters sent for commit generation. */
  gitMaxDiffChars: number;
  /** Whether to request a Conventional Commits subject line. */
  gitConventionalCommits: boolean;
  /** Language of the generated commit message. */
  gitLanguage: 'en' | 'zh-CN';
  /** Whether the generate-and-commit command commits without confirmation. */
  gitAutoCommit: boolean;
  /**
   * Verbosity of the TabAI output channel.
   *
   * `debug` is what you want when diagnosing why a completion did not appear;
   * every request logs its outcome and reason at that level.
   */
  logLevel: LogLevelName;
}

/**
 * The verbosity of the extension log.
 *
 * Mirrors `core/logger`'s levels without importing it, so this module stays
 * dependency-free.
 */
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'none';

/**
 * The minimum information the completion engine needs about the document.
 * Decoupling from the VS Code `TextDocument` makes the engine testable.
 */
export interface DocumentSnapshot {
  /** The document URI as a string, used for cache keys and telemetry. */
  uri: string;
  /** The VS Code language id, for example `typescript`. */
  languageId: string;
  /** Monotonic document version, used to detect stale results. */
  version: number;
  /** The full document text. */
  text: string;
  /** The file name including extension, used to derive the path marker. */
  fileName: string;
}

/** Everything collected locally before a completion request is built. */
export interface CompletionContext {
  /** Snapshot of the document at request time. */
  document: DocumentSnapshot;
  /** The cursor position the completion is requested for. */
  position: CursorPosition;
  /** Text from the beginning of the document up to the cursor. */
  prefix: string;
  /** Text from the cursor to the end of the document. */
  suffix: string;
  /** The text of the line the cursor sits on. */
  currentLine: string;
  /** Whether the cursor is inside a line rather than at its end. */
  isMiddleOfLine: boolean;
  /** Import-like lines extracted from the prefix, used as a hint. */
  imports: string[];
  /**
   * Snippets from other files in the workspace that resemble the code around
   * the cursor.
   *
   * Empty when cross-file context is disabled or nothing scored above the
   * threshold. Populated by the VS Code adapter, which is the only layer with
   * access to the other open/on-disk files.
   */
  neighbors: NeighborSnippetSummary[];
}

/**
 * A cross-file snippet attached to a completion request.
 *
 * Declared here rather than imported from the completion layer so the AI
 * client and the prompt builders can depend on it without a cycle.
 */
export interface NeighborSnippetSummary {
  /** Repository-relative path of the file the snippet came from. */
  path: string;
  /** The snippet text. */
  content: string;
  /** Zero-based line where the snippet starts in its file. */
  startLine: number;
  /** Jaccard similarity against the cursor window, in `[0, 1]`. */
  score: number;
}

/** A single completion candidate returned by a provider. */
export interface CompletionResult {
  /** The text that should be inserted at the cursor. */
  text: string;
  /** Free-form model name for telemetry. */
  model: string;
  /** Why generation stopped. */
  finishReason: string;
  /** Wall-clock duration of the HTTP request in milliseconds. */
  latencyMs: number;
  /** True when the result was served from the local cache. */
  fromCache: boolean;
}

/** A completion that has been validated and is ready to be shown. */
export interface ProcessedCompletion {
  /** The insertion text after post-processing. */
  text: string;
  /** The range that the ghost text will occupy. */
  range: CursorRange;
  /** True when the completion spans more than one line. */
  multiline: boolean;
  /** The original provider result, kept for telemetry. */
  raw: CompletionResult;
}

/** A single file change inside a commit. */
export interface GitFileChange {
  /** Repository-relative path of the file. */
  path: string;
  /** Porcelain status code, for example `M`, `A`, `D`, `R`. */
  status: string;
  /** Number of inserted lines, when available. */
  insertions: number;
  /** Number of deleted lines, when available. */
  deletions: number;
}

/** Aggregated repository state used to build the commit prompt. */
export interface GitDiffSummary {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Currently checked out branch, or `HEAD` when detached. */
  branch: string;
  /** All staged and unstaged changes. */
  files: GitFileChange[];
  /** Unified diff text, already truncated to the configured limit. */
  diff: string;
  /** True when the diff was truncated before being sent to the model. */
  truncated: boolean;
  /**
   * True when the summary describes the index only (something is staged).
   *
   * When false the summary covers every working-tree change, which is what the
   * message should describe if the user has not staged anything yet.
   */
  stagedOnly: boolean;
}

/** The outcome of a commit message generation request. */
export interface CommitMessageResult {
  /** The full message: subject line, blank line, then optional body. */
  message: string;
  /** Just the first line, used as the SCM input box value. */
  subject: string;
  /** The generated body, empty when the model produced a single line. */
  body: string;
  /** The model that produced the message. */
  model: string;
  /** Wall-clock duration of the HTTP request in milliseconds. */
  latencyMs: number;
}

/**
 * How a request should treat a reasoning model's chain of thought.
 *
 * - `auto`: suppress it, choosing the switch for the detected model family.
 * - `off`: alias of `auto`, kept so the intent reads clearly in settings.
 * - `default`: send nothing and let the server decide.
 */
export type ReasoningMode = 'auto' | 'off' | 'default';

/** Normalised error categories so callers can react without string matching. */
export type TabAIErrorKind =
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'aborted'
  | 'not-configured';

/**
 * The single error type thrown by the provider layer.
 *
 * Keeping one error class lets the UI map failures to user-facing messages in
 * one place, and lets tests assert on `kind` rather than on message text.
 */
export class TabAIError extends Error {
  /** The normalised category of the failure. */
  public readonly kind: TabAIErrorKind;

  /** The HTTP status code, when the failure came from a response. */
  public readonly statusCode: number | undefined;

  /** The underlying cause, when one exists. */
  public override readonly cause: unknown;

  /**
   * @param kind Normalised failure category.
   * @param message Human-readable message safe to show to the user.
   * @param options Optional status code and underlying cause.
   */
  public constructor(
    kind: TabAIErrorKind,
    message: string,
    options: { statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'TabAIError';
    this.kind = kind;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }
}

/**
 * Tests whether an unknown value is a `TabAIError`.
 *
 * @param value Any value.
 * @returns True when the value is a `TabAIError`.
 */
export function isTabAIError(value: unknown): value is TabAIError {
  return value instanceof TabAIError;
}
