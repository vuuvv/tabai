import { describe, expect, it } from 'vitest';
import { AIClient } from '../../src/ai/client.js';
import type { CompletionContext, TabAISettings } from '../../src/core/types.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';

/**
 * Builds a settings object with overrides.
 *
 * @param overrides Fields to override.
 * @returns A complete settings object.
 */
function settingsWith(overrides: Partial<TabAISettings> = {}): TabAISettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/**
 * Builds a completion context.
 *
 * @returns A minimal context.
 */
function context(): CompletionContext {
  return {
    document: {
      uri: 'file:///a.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const a = 1;\n',
      fileName: 'a.ts',
    },
    position: { line: 0, character: 12 },
    prefix: 'const a = 1;\n',
    suffix: '',
    currentLine: 'const a = 1;',
    isMiddleOfLine: false,
    imports: [],
    neighbors: [],
  };
}

/** A chat-completion payload that is entirely reasoning. */
function reasoningOnlyPayload(): unknown {
  return {
    model: 'qwen',
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
    usage: {
      completion_tokens: 120,
      completion_tokens_details: { reasoning_tokens: 120 },
    },
  };
}

/** A chat-completion payload with visible content. */
function contentPayload(text: string): unknown {
  return {
    model: 'qwen',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: {
      completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/**
 * Creates a fetch stub that records bodies and replays payloads in order.
 *
 * @param payloads Payloads to return, in order; the last one repeats.
 * @returns The stub plus captured bodies.
 */
function replayFetch(payloads: unknown[]): {
  fetchImpl: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, bodies };
}

describe('reasoning suppression escalation', () => {
  it('uses the family plan first and succeeds without escalation', async () => {
    const stub = replayFetch([contentPayload('return a;')]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    const result = await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'qwen3.6-35b-a3b' }),
      context(),
    );

    expect(result.text).toBe('return a;');
    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0]?.['reasoning_effort']).toBe('none');
    expect(stub.bodies[0]?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  });

  it('escalates to the next plan when the server ignores the first', async () => {
    const stub = replayFetch([
      reasoningOnlyPayload(),
      contentPayload('return a;'),
    ]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    const result = await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'qwen3.6-35b-a3b' }),
      context(),
    );

    expect(result.text).toBe('return a;');
    expect(stub.bodies.length).toBeGreaterThan(1);
    // The second attempt is the generic reasoning_effort-only plan.
    expect(stub.bodies[1]?.['reasoning_effort']).toBe('none');
  });

  it('keeps escalating through every plan when all fail', async () => {
    const stub = replayFetch([reasoningOnlyPayload()]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    const result = await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'qwen3.6-35b-a3b' }),
      context(),
    );

    // All plans were tried and the final empty answer is returned so
    // post-processing can reject it with a clear reason.
    expect(result.text).toBe('');
    expect(stub.bodies.length).toBeGreaterThan(1);
  });

  it('does not escalate for a model that cannot disable reasoning', async () => {
    const stub = replayFetch([reasoningOnlyPayload()]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'deepseek-r1' }),
      context(),
    );

    // Only the single family plan is attempted for always-reasoning models.
    expect(stub.bodies).toHaveLength(1);
  });

  it('sends no suppression fields in default mode', async () => {
    const stub = replayFetch([contentPayload('return a;')]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    await client.complete(
      settingsWith({
        providerType: 'openai-compatible',
        completionModel: 'qwen3.6-35b-a3b',
        reasoningMode: 'default',
      }),
      context(),
    );

    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0]?.['reasoning_effort']).toBeUndefined();
    expect(stub.bodies[0]?.['chat_template_kwargs']).toBeUndefined();
  });

  it('picks the GLM plan for a GLM model', async () => {
    const stub = replayFetch([contentPayload('x')]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'glm-4.6' }),
      context(),
    );

    expect(stub.bodies[0]?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('picks the Claude plan for a Claude model', async () => {
    const stub = replayFetch([contentPayload('x')]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'claude-sonnet-4' }),
      context(),
    );

    expect(stub.bodies[0]?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('appends the no-think suffix when that plan is reached', async () => {
    // The plan order for Qwen is:
    //   qwen3 -> reasoning-effort-none -> enable-thinking-false
    //         -> thinking-type-disabled -> no-think-suffix -> default
    // so the suffix plan is the fifth attempt.
    const stub = replayFetch([
      reasoningOnlyPayload(),
      reasoningOnlyPayload(),
      reasoningOnlyPayload(),
      reasoningOnlyPayload(),
      contentPayload('return a;'),
    ]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    const result = await client.complete(
      settingsWith({ providerType: 'openai-compatible', completionModel: 'qwen3.6-35b-a3b' }),
      context(),
    );

    expect(result.text).toBe('return a;');
    expect(stub.bodies).toHaveLength(5);
    const withSuffix = stub.bodies.find((body) => {
      const messages = body['messages'] as { role: string; content: string }[];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      return lastUser?.content.includes('/no_think') === true;
    });
    expect(withSuffix).toBeDefined();
  });

  it('applies suppression to commit generation too', async () => {
    const stub = replayFetch([
      reasoningOnlyPayload(),
      contentPayload('feat: add token validation'),
    ]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    const result = await client.generateCommitMessage(
      settingsWith({ completionModel: 'qwen3.6-35b-a3b', commitModel: 'qwen3.6-35b-a3b' }),
      {
        repoRoot: '/repo',
        branch: 'main',
        files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }],
        diff: '+x',
        truncated: false,
    stagedOnly: false,
      },
    );

    expect(result.subject).toBe('feat: add token validation');
    expect(stub.bodies.length).toBe(2);
    expect(stub.bodies[0]?.['reasoning_effort']).toBe('none');
  });

  it('leaves FIM requests untouched by reasoning fields', async () => {
    const stub = replayFetch([
      { model: 'qwen', choices: [{ text: 'return a;', finish_reason: 'stop' }] },
    ]);
    const client = new AIClient({ fetchImpl: stub.fetchImpl });

    await client.complete(
      settingsWith({ providerType: 'fim', completionModel: 'qwen3.6-35b-a3b' }),
      context(),
    );

    expect(stub.bodies[0]?.['reasoning_effort']).toBeUndefined();
    expect(stub.bodies[0]?.['prompt']).toBeDefined();
  });
});
