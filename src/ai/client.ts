/**
 * The AI provider client.
 *
 * One class covers both supported protocols so the rest of the extension does
 * not need to branch on the provider type. Every public method takes a settings
 * snapshot, which keeps requests immune to mid-flight configuration changes.
 */

import type {
  CommitMessageResult,
  CompletionContext,
  CompletionResult,
  GitDiffSummary,
  TabAISettings,
} from '../core/types.js';
import { TabAIError } from '../core/types.js';
import { logger } from '../core/logger.js';
import { postJson } from './httpClient.js';
import type { ReasoningPlan } from './reasoning.js';
import {
  applyPlan,
  applyPromptSuffix,
  buildReasoningPlans,
  cannotDisableReasoning,
  detectModelFamily,
  isReasoningOnlyResponse,
} from './reasoning.js';
import { parseChatCompletion, parseModelList, parseTextCompletion } from './parsers.js';
import {
  buildChatSystemPrompt,
  buildChatUserPrompt,
  buildCommitPrompt,
  buildFimPrompt,
  buildFimStopSequences,
  formatNeighborBlock,
  trimLines,
} from './prompts.js';

/** Constructor options for {@link AIClient}. */
export interface AIClientOptions {
  /** Injected fetch implementation, used by tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Talks to an OpenAI-compatible inference server.
 *
 * All methods are pure with respect to instance state: the only field is the
 * optional injected `fetch`, so a single instance can serve concurrent
 * requests safely.
 */
export class AIClient {
  /** Fetch implementation used for every request. */
  private readonly fetchImpl: typeof fetch | undefined;

  /**
   * @param options Optional dependency injection.
   */
  public constructor(options: AIClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
  }

  /**
   * Builds the absolute URL for an endpoint path.
   *
   * @param settings Settings snapshot providing the base URL.
   * @param path Endpoint path, for example `/chat/completions`.
   * @returns The absolute URL.
   */
  private endpoint(settings: TabAISettings, path: string): string {
    return settings.baseUrl.replace(/\/+$/, '') + path;
  }

  /**
   * Issues a completion request and normalises the result.
   *
   * @param settings Settings snapshot.
   * @param context The completion context.
   * @param signal Optional abort signal.
   * @returns The completion result.
   * @throws TabAIError when the request or the response is unusable.
   */
  public async complete(
    settings: TabAISettings,
    context: CompletionContext,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const result =
      settings.providerType === 'fim'
        ? await this.completeWithFim(settings, context, signal)
        : await this.completeWithChat(settings, context, signal);
    return {
      text: result.text,
      model: result.model,
      finishReason: result.finishReason,
      latencyMs: Date.now() - startedAt,
      fromCache: false,
    };
  }

  /**
   * Issues a raw FIM text-completion request.
   *
   * @param settings Settings snapshot.
   * @param context The completion context.
   * @param signal Optional abort signal.
   * @returns Normalised text plus metadata.
   */
  private async completeWithFim(
    settings: TabAISettings,
    context: CompletionContext,
    signal?: AbortSignal,
  ): Promise<{ text: string; finishReason: string; model: string }> {
    const prefix = trimLines(context.prefix, settings.maxPrefixLines, true);
    const suffix = trimLines(context.suffix, settings.maxSuffixLines, false);
    const neighborBlock = formatNeighborBlock(context.neighbors ?? []);
    const prompt = buildFimPrompt(prefix, suffix, undefined, neighborBlock);

    logger.debug(
      'fim request model=' +
        settings.completionModel +
        ' promptChars=' +
        prompt.length +
        ' neighborSnippets=' +
        String(context.neighbors?.length ?? 0),
    );

    const response = await postJson({
      url: this.endpoint(settings, '/completions'),
      body: {
        model: settings.completionModel,
        prompt,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stop: buildFimStopSequences(undefined, settings.multiline),
        stream: false,
      },
      apiKey: settings.apiKey,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
      ...(signal === undefined ? {} : { signal }),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });

    const parsed = parseTextCompletion(response.data);
    return { text: parsed.text, finishReason: parsed.finishReason, model: parsed.model };
  }

  /**
   * Issues a chat-completion request.
   *
   * @param settings Settings snapshot.
   * @param context The completion context.
   * @param signal Optional abort signal.
   * @returns Normalised text plus metadata.
   */
  private async completeWithChat(
    settings: TabAISettings,
    context: CompletionContext,
    signal?: AbortSignal,
  ): Promise<{ text: string; finishReason: string; model: string }> {
    const prefix = trimLines(context.prefix, settings.maxPrefixLines, true);
    const suffix = trimLines(context.suffix, settings.maxSuffixLines, false);
    const trimmedContext: CompletionContext = { ...context, prefix, suffix };

    logger.debug('chat request model=' + settings.completionModel);

    const messages = [
      {
        role: 'system',
        content: buildChatSystemPrompt(trimmedContext, settings.multiline),
      },
      { role: 'user', content: buildChatUserPrompt(trimmedContext) },
    ];

    const parsed = await this.chatWithReasoningSuppressed(
      settings,
      settings.completionModel,
      messages,
      settings.maxTokens,
      settings.temperature,
      signal,
    );
    return { text: parsed.content, finishReason: parsed.finishReason, model: parsed.model };
  }

  /**
   * Sends a chat request, escalating through reasoning-suppression plans until
   * the model returns visible content instead of a pure reasoning trace.
   *
   * Each model family needs a different switch (see `reasoning.ts`), and some
   * servers silently ignore the field they do not recognise. Rather than
   * guessing once, this walks the plan list and stops at the first response
   * that contains real content. Models that cannot disable reasoning are not
   * retried, because every plan would fail the same way.
   *
   * @param settings Settings snapshot.
   * @param modelId The model being called.
   * @param messages Chat messages.
   * @param maxTokens Token budget for the answer.
   * @param temperature Sampling temperature.
   * @param signal Optional abort signal.
   * @returns The parsed response from the first successful attempt.
   * @throws TabAIError when every plan fails.
   */
  private async chatWithReasoningSuppressed(
    settings: TabAISettings,
    modelId: string,
    messages: { role: string; content: string }[],
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal,
  ): Promise<{ content: string; finishReason: string; model: string }> {
    const plans = buildReasoningPlans(modelId, settings.reasoningMode);
    const family = detectModelFamily(modelId);

    if (cannotDisableReasoning(modelId) && settings.reasoningMode !== 'default') {
      logger.warn(
        'model "' +
          modelId +
          '" cannot disable reasoning (' +
          family +
          '); expect slower responses and lower effective token budget',
      );
    }

    let lastParsed: { content: string; finishReason: string; model: string } | undefined;
    let lastPlan: ReasoningPlan | undefined;

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index] as ReasoningPlan;
      lastPlan = plan;

      const body = applyPlan(
        {
          model: modelId,
          messages: applyPromptSuffix(messages, plan),
          max_tokens: maxTokens,
          temperature,
          stream: false,
        },
        plan,
      );

      const response = await postJson({
        url: this.endpoint(settings, '/chat/completions'),
        body,
        apiKey: settings.apiKey,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
        ...(signal === undefined ? {} : { signal }),
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });

      const parsed = parseChatCompletion(response.data);
      lastParsed = parsed;

      if (!isReasoningOnlyResponse(response.data)) {
        if (index > 0) {
          logger.info(
            'reasoning suppressed with plan "' + plan.name + '" (family=' + family + ')',
          );
        }
        return parsed;
      }

      const isLast = index === plans.length - 1;
      if (!isLast) {
        logger.debug(
          'plan "' + plan.name + '" did not suppress reasoning for ' + modelId + '; escalating',
        );
      }
    }

    // Every plan produced a reasoning-only answer. Returning the empty content
    // lets the caller's post-processing reject it with a clear reason instead
    // of surfacing a confusing blank completion.
    logger.warn(
      'all reasoning-suppression plans failed for "' +
        modelId +
        '" (last plan: ' +
        (lastPlan?.name ?? 'none') +
        ')',
    );
    if (lastParsed === undefined) {
      throw new TabAIError('parse', 'No chat completion response was produced');
    }
    return lastParsed;
  }

  /**
   * Generates a commit message from a repository diff.
   *
   * @param settings Settings snapshot.
   * @param summary Aggregated repository state.
   * @param signal Optional abort signal.
   * @returns The parsed commit message.
   * @throws TabAIError when the request fails or the model returns nothing.
   */
  public async generateCommitMessage(
    settings: TabAISettings,
    summary: GitDiffSummary,
    signal?: AbortSignal,
  ): Promise<CommitMessageResult> {
    if (summary.files.length === 0) {
      throw new TabAIError('not-configured', 'There are no changes to commit');
    }

    const startedAt = Date.now();
    const prompt = buildCommitPrompt(
      summary,
      settings.gitConventionalCommits,
      settings.gitLanguage,
    );

    const parsed = await this.chatWithReasoningSuppressed(
      settings,
      settings.commitModel,
      [
        {
          role: 'system',
          content:
            'You are a senior engineer writing a git commit message. ' +
            'You output only the message, never an explanation.',
        },
        { role: 'user', content: prompt },
      ],
      512,
      0.3,
      signal,
    );

    const normalised = normaliseCommitMessage(parsed.content);
    if (normalised.subject.length === 0) {
      throw new TabAIError('parse', 'The model returned an empty commit message');
    }
    return {
      message: normalised.message,
      subject: normalised.subject,
      body: normalised.body,
      model: parsed.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Lists the model ids advertised by the server.
   *
   * Used by the status command to validate that the configured model exists.
   *
   * @param settings Settings snapshot.
   * @param signal Optional abort signal.
   * @returns Model identifiers; an empty array when the endpoint is unsupported.
   */
  public async listModels(
    settings: TabAISettings,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const response = await postJson({
        url: this.endpoint(settings, '/models'),
        // Discovery is a GET; a POST here returns HTTP 200 with an error body
        // on some servers, which would silently look like "no models".
        method: 'GET',
        body: {},
        apiKey: settings.apiKey,
        timeoutMs: Math.min(settings.timeoutMs, 5000),
        maxRetries: 0,
        ...(signal === undefined ? {} : { signal }),
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
      return parseModelList(response.data);
    } catch (error) {
      logger.debug('listModels failed: ' + String(error));
      return [];
    }
  }
}

/**
 * Strips markdown fences and surrounding quotes from model output.
 *
 * Models frequently wrap code in fences even when told not to, so every
 * consumer funnels through this helper.
 *
 * @param text Raw model output.
 * @returns Text with fences and wrapping quotes removed.
 */
export function stripMarkdownFences(text: string): string {
  let result = text.trim();
  const fence = /^```[a-zA-Z0-9+#-]*\n([\s\S]*?)\n?```$/;
  const match = result.match(fence);
  if (match !== null && typeof match[1] === 'string') {
    result = match[1];
  }
  if (
    result.length >= 2 &&
    ((result.startsWith('"') && result.endsWith('"')) ||
      (result.startsWith("'") && result.endsWith("'")))
  ) {
    result = result.slice(1, -1);
  }
  return result;
}

/**
 * Normalises a raw commit message into subject and body.
 *
 * Drops markdown fences, leading bullet noise on the subject and trailing
 * whitespace, then splits at the first blank line.
 *
 * @param raw Raw model output.
 * @returns The normalised message parts.
 */
export function normaliseCommitMessage(raw: string): {
  message: string;
  subject: string;
  body: string;
} {
  const cleaned = stripMarkdownFences(raw)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();

  if (cleaned.length === 0) {
    return { message: '', subject: '', body: '' };
  }

  const lines = cleaned.split('\n');
  const subject = (lines[0] ?? '').replace(/^[-*\d.\s]+/, '').trim();
  const rest = lines.slice(1).join('\n').trim();
  const message = rest.length === 0 ? subject : subject + '\n\n' + rest;
  return { message, subject, body: rest };
}
