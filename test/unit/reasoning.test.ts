import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  applyPromptSuffix,
  buildReasoningPlans,
  cannotDisableReasoning,
  describeFamily,
  detectModelFamily,
  isReasoningOnlyResponse,
  normaliseModelId,
  primaryPlan,
} from '../../src/ai/reasoning.js';

describe('normaliseModelId', () => {
  it('lower-cases and trims', () => {
    expect(normaliseModelId('  Qwen3.6-35B-A3B  ')).toBe('qwen3.6-35b-a3b');
  });

  it('handles an empty string', () => {
    expect(normaliseModelId('')).toBe('');
  });
});

describe('detectModelFamily', () => {
  it('detects the bundled local model as Qwen 3', () => {
    expect(detectModelFamily('qwen3.6-35b-a3b')).toBe('qwen3');
  });

  it('detects other Qwen spellings', () => {
    expect(detectModelFamily('Qwen2.5-Coder-7B')).toBe('unknown');
    expect(detectModelFamily('qwen-3-32b')).toBe('qwen3');
    expect(detectModelFamily('Qwen3')).toBe('qwen3');
  });

  it('detects DeepSeek R1 before the generic DeepSeek pattern', () => {
    expect(detectModelFamily('deepseek-r1-distill-llama-8b')).toBe('deepseek-reasoner');
    expect(detectModelFamily('deepseek-reasoner')).toBe('deepseek-reasoner');
  });

  it('detects DeepSeek V3 and chat models', () => {
    expect(detectModelFamily('deepseek-v3.1')).toBe('deepseek-v3');
    expect(detectModelFamily('deepseek-chat')).toBe('deepseek-v3');
  });

  it('detects GLM 4.x and 5.x', () => {
    expect(detectModelFamily('glm-4.6')).toBe('glm');
    expect(detectModelFamily('glm-5')).toBe('glm');
  });

  it('detects Kimi and Moonshot', () => {
    expect(detectModelFamily('kimi-k2-instruct')).toBe('kimi');
    expect(detectModelFamily('moonshot-v1-8k')).toBe('kimi');
  });

  it('detects Claude', () => {
    expect(detectModelFamily('claude-sonnet-4')).toBe('claude');
    expect(detectModelFamily('anthropic/claude-3-5-sonnet')).toBe('claude');
  });

  it('detects Gemini', () => {
    expect(detectModelFamily('gemini-2.5-pro')).toBe('gemini');
  });

  it('detects gpt-oss before generic gpt patterns', () => {
    expect(detectModelFamily('gpt-oss-120b')).toBe('gpt-oss');
  });

  it('detects OpenAI reasoning models', () => {
    expect(detectModelFamily('o1-mini')).toBe('openai-reasoning');
    expect(detectModelFamily('o3')).toBe('openai-reasoning');
    expect(detectModelFamily('gpt-5')).toBe('openai-reasoning');
  });

  it('detects Mistral and Magistral', () => {
    expect(detectModelFamily('magistral-small')).toBe('mistral');
    expect(detectModelFamily('mistral-small-3')).toBe('mistral');
  });

  it('returns unknown for an unrecognised id', () => {
    expect(detectModelFamily('some-unknown-model')).toBe('unknown');
  });

  it('returns unknown for an empty id', () => {
    expect(detectModelFamily('')).toBe('unknown');
  });
});

describe('cannotDisableReasoning', () => {
  it('is true for DeepSeek R1', () => {
    expect(cannotDisableReasoning('deepseek-r1')).toBe(true);
  });

  it('is true for gpt-oss', () => {
    expect(cannotDisableReasoning('gpt-oss-20b')).toBe(true);
  });

  it('is true for OpenAI reasoning models', () => {
    expect(cannotDisableReasoning('o1')).toBe(true);
  });

  it('is false for Qwen 3', () => {
    expect(cannotDisableReasoning('qwen3.6-35b-a3b')).toBe(false);
  });

  it('is false for an unknown model', () => {
    expect(cannotDisableReasoning('mystery-model')).toBe(false);
  });
});

describe('describeFamily', () => {
  it('explains the Qwen switch', () => {
    expect(describeFamily('qwen3.6-35b-a3b')).toContain('reasoning_effort=none');
  });

  it('explains that R1 cannot be disabled', () => {
    expect(describeFamily('deepseek-r1')).toContain('no supported off switch');
  });

  it('falls back for an unknown family', () => {
    expect(describeFamily('mystery')).toContain('generic suppression fields');
  });
});

describe('primaryPlan', () => {
  it('returns the Qwen plan with all three Qwen fields', () => {
    const plan = primaryPlan('qwen3.6-35b-a3b');
    expect(plan.name).toBe('qwen3');
    expect(plan.fields['reasoning_effort']).toBe('none');
    expect(plan.fields['chat_template_kwargs']).toEqual({ enable_thinking: false });
    expect(plan.fields['enable_thinking']).toBe(false);
    expect(plan.canDisable).toBe(true);
  });

  it('returns the DeepSeek R1 plan with no fields', () => {
    const plan = primaryPlan('deepseek-r1');
    expect(plan.name).toBe('deepseek-reasoner');
    expect(plan.fields).toEqual({});
    expect(plan.canDisable).toBe(false);
  });

  it('uses thinking.type for GLM', () => {
    const plan = primaryPlan('glm-4.6');
    expect(plan.fields['thinking']).toEqual({ type: 'disabled' });
  });

  it('uses thinking.type for Claude', () => {
    const plan = primaryPlan('claude-sonnet-4');
    expect(plan.fields['thinking']).toEqual({ type: 'disabled' });
  });

  it('uses thinkingBudget for Gemini', () => {
    const plan = primaryPlan('gemini-2.5-pro');
    expect(plan.fields['generationConfig']).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it('uses reasoning_effort=minimal for o-series', () => {
    const plan = primaryPlan('o3');
    expect(plan.fields['reasoning_effort']).toBe('minimal');
    expect(plan.canDisable).toBe(false);
  });

  it('falls back to the generic plan for an unknown model', () => {
    const plan = primaryPlan('mystery');
    expect(plan.name).toBe('unknown');
    expect(plan.fields['reasoning_effort']).toBe('none');
  });
});

describe('buildReasoningPlans', () => {
  it('starts with the family plan', () => {
    const plans = buildReasoningPlans('qwen3.6-35b-a3b', 'auto');
    expect(plans[0]?.name).toBe('qwen3');
  });

  it('includes generic fallbacks for a model that can disable reasoning', () => {
    const plans = buildReasoningPlans('qwen3.6-35b-a3b', 'auto');
    const names = plans.map((plan) => plan.name);
    expect(names).toContain('reasoning-effort-none');
    expect(names).toContain('thinking-type-disabled');
    expect(names).toContain('no-think-suffix');
  });

  it('ends with the no-op default plan', () => {
    const plans = buildReasoningPlans('qwen3.6-35b-a3b', 'auto');
    expect(plans[plans.length - 1]?.name).toBe('default');
    expect(plans[plans.length - 1]?.fields).toEqual({});
  });

  it('returns only the family plan for an always-reasoning model', () => {
    const plans = buildReasoningPlans('deepseek-r1', 'auto');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.name).toBe('deepseek-reasoner');
  });

  it('returns only the no-op plan in default mode', () => {
    const plans = buildReasoningPlans('qwen3.6-35b-a3b', 'default');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.name).toBe('default');
  });

  it('treats off as auto', () => {
    const auto = buildReasoningPlans('qwen3.6-35b-a3b', 'auto');
    const off = buildReasoningPlans('qwen3.6-35b-a3b', 'off');
    expect(off.map((plan) => plan.name)).toEqual(auto.map((plan) => plan.name));
  });

  it('de-duplicates plans with identical fields', () => {
    const plans = buildReasoningPlans('mystery-model', 'auto');
    const keys = plans.map((plan) => JSON.stringify(plan.fields) + plan.promptSuffix);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers every family without throwing', () => {
    const ids = [
      'qwen3.6-35b-a3b',
      'deepseek-r1',
      'deepseek-v3.1',
      'glm-4.6',
      'kimi-k2',
      'claude-sonnet-4',
      'gemini-2.5-pro',
      'gpt-oss-120b',
      'o3',
      'magistral-small',
      'mystery',
    ];
    for (const id of ids) {
      expect(() => buildReasoningPlans(id, 'auto')).not.toThrow();
      expect(buildReasoningPlans(id, 'auto').length).toBeGreaterThan(0);
    }
  });
});

describe('applyPlan', () => {
  it('merges plan fields into the body', () => {
    const body = { model: 'qwen', max_tokens: 100 };
    const merged = applyPlan(body, primaryPlan('qwen3.6-35b-a3b'));
    expect(merged['model']).toBe('qwen');
    expect(merged['max_tokens']).toBe(100);
    expect(merged['reasoning_effort']).toBe('none');
  });

  it('does not mutate the input body', () => {
    const body = { model: 'qwen' };
    applyPlan(body, primaryPlan('qwen3.6-35b-a3b'));
    expect(body).toEqual({ model: 'qwen' });
  });

  it('leaves the body unchanged for the no-op plan', () => {
    const body = { model: 'qwen' };
    const merged = applyPlan(body, { name: 'default', fields: {}, promptSuffix: '', canDisable: false });
    expect(merged).toEqual({ model: 'qwen' });
  });
});

describe('applyPromptSuffix', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ];

  it('appends the suffix to the last user message only', () => {
    const result = applyPromptSuffix(messages, {
      name: 'x',
      fields: {},
      promptSuffix: ' /no_think',
      canDisable: true,
    });
    expect(result[3]?.content).toBe('second /no_think');
    expect(result[1]?.content).toBe('first');
  });

  it('returns the original array when there is no suffix', () => {
    const result = applyPromptSuffix(messages, {
      name: 'x',
      fields: {},
      promptSuffix: '',
      canDisable: true,
    });
    expect(result).toBe(messages);
  });

  it('returns the original array when there is no user message', () => {
    const noUser = [{ role: 'system', content: 'sys' }];
    const result = applyPromptSuffix(noUser, {
      name: 'x',
      fields: {},
      promptSuffix: ' /no_think',
      canDisable: true,
    });
    expect(result).toBe(noUser);
  });

  it('does not mutate the input messages', () => {
    applyPromptSuffix(messages, {
      name: 'x',
      fields: {},
      promptSuffix: ' /no_think',
      canDisable: true,
    });
    expect(messages[3]?.content).toBe('second');
  });
});

describe('isReasoningOnlyResponse', () => {
  /**
   * Builds a chat-completion payload.
   *
   * @param content The assistant content.
   * @param reasoningTokens Reported reasoning tokens.
   * @param completionTokens Reported completion tokens.
   * @returns A response payload.
   */
  function payload(
    content: string,
    reasoningTokens: number,
    completionTokens: number,
  ): unknown {
    return {
      choices: [{ message: { role: 'assistant', content } }],
      usage: {
        completion_tokens: completionTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
    };
  }

  it('is true when content is empty and reasoning was consumed', () => {
    expect(isReasoningOnlyResponse(payload('', 120, 120))).toBe(true);
  });

  it('is false when content is present', () => {
    expect(isReasoningOnlyResponse(payload('return a;', 10, 20))).toBe(false);
  });

  it('is true when there is no usage block and content is empty', () => {
    expect(
      isReasoningOnlyResponse({ choices: [{ message: { content: '' } }] }),
    ).toBe(true);
  });

  it('is false for whitespace-free real content with zero reasoning', () => {
    expect(isReasoningOnlyResponse(payload('x', 0, 5))).toBe(false);
  });

  it('is true for whitespace-only content', () => {
    expect(isReasoningOnlyResponse(payload('   ', 5, 5))).toBe(true);
  });

  it('is false for a malformed payload', () => {
    expect(isReasoningOnlyResponse(null)).toBe(false);
    expect(isReasoningOnlyResponse('nope')).toBe(false);
    expect(isReasoningOnlyResponse({})).toBe(false);
    expect(isReasoningOnlyResponse({ choices: [] })).toBe(false);
  });

  it('is true when the usage block lacks reasoning details but content is empty', () => {
    expect(
      isReasoningOnlyResponse({
        choices: [{ message: { content: '' } }],
        usage: { completion_tokens: 10 },
      }),
    ).toBe(true);
  });
});
