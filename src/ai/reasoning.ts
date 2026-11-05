/**
 * Reasoning ("thinking") control for chat-completion requests.
 *
 * Reasoning models emit a private chain of thought before the answer. On an
 * OpenAI-compatible server that trace is billed against `max_tokens`, so a
 * completion with a small budget returns an empty string once the budget is
 * consumed by thinking. Measured against the bundled local model
 * (qwen3.6-35b-a3b served by LM Studio, `max_tokens` 120-1200):
 *
 *   | request shape                              | reasoning tok | latency | content |
 *   | ------------------------------------------ | ------------- | ------- | ------- |
 *   | no flag, max_tokens=120                    |           120 |  2300ms | empty   |
 *   | chat_template_kwargs.enable_thinking=false |           394 |  8500ms | usable  |
 *   | top-level enable_thinking=false            |           394 | 11000ms | usable  |
 *   | user message suffix "/no_think"            |           783 | 14700ms | usable  |
 *   | reasoning_effort="none"                    |             0 |   115ms | usable  |
 *
 * No single field works everywhere: each model family exposes its own switch,
 * and some models (DeepSeek-R1, o1) cannot disable reasoning at all. This
 * module therefore maps a model id onto an ordered list of candidate plans and
 * lets the caller escalate until the trace disappears.
 */

/** How the user wants reasoning handled. */
export type ReasoningMode = 'auto' | 'off' | 'default';

/** One attempt at suppressing reasoning. */
export interface ReasoningPlan {
  /** Short label used in logs and diagnostics. */
  name: string;
  /** JSON fields merged into the chat-completion request body. */
  fields: Record<string, unknown>;
  /** Text appended to the last user message, when the family needs it. */
  promptSuffix: string;
  /**
   * False when the model has no supported way to disable reasoning.
   *
   * Callers use this to warn the user rather than retrying pointlessly.
   */
  canDisable: boolean;
}

/** A model family together with its preferred suppression plan. */
interface FamilyDefinition {
  /** Stable family id. */
  id: string;
  /** Ordered patterns matched against the lower-cased model id. */
  patterns: RegExp[];
  /** The plan to try first for this family. */
  plan: Omit<ReasoningPlan, 'name'>;
  /** Human-readable explanation of the family's switch. */
  note: string;
}

/**
 * The family registry, evaluated top to bottom.
 *
 * Order matters: `deepseek-r1` must be tested before the generic
 * `deepseek` pattern, and `gpt-oss` before `gpt-`.
 */
const FAMILIES: FamilyDefinition[] = [
  {
    id: 'deepseek-reasoner',
    patterns: [/deepseek[-_.]?r1/, /deepseek[-_.]?reasoner/],
    plan: { fields: {}, promptSuffix: '', canDisable: false },
    note: 'DeepSeek-R1 always reasons; there is no supported off switch.',
  },
  {
    id: 'deepseek-v3',
    patterns: [/deepseek[-_.]?v3/, /deepseek[-_.]?chat/],
    plan: {
      fields: { chat_template_kwargs: { thinking: false } },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'DeepSeek V3.1 honours chat_template_kwargs.thinking=false.',
  },
  {
    id: 'qwen3',
    patterns: [/qwen[-_.]?3/, /qwen3/],
    plan: {
      fields: {
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        enable_thinking: false,
      },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'Qwen 3 honours reasoning_effort=none; enable_thinking is the template-level fallback.',
  },
  {
    id: 'glm',
    patterns: [/glm[-_.]?4/, /glm[-_.]?5/],
    plan: {
      fields: {
        thinking: { type: 'disabled' },
        chat_template_kwargs: { enable_thinking: false },
      },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'GLM 4.5/4.6 accept thinking.type=disabled.',
  },
  {
    id: 'kimi',
    patterns: [/kimi/, /moonshot/, /k2/],
    plan: {
      fields: {
        chat_template_kwargs: { thinking: false },
        thinking: { type: 'disabled' },
      },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'Kimi K2 accepts both chat_template_kwargs.thinking and thinking.type.',
  },
  {
    id: 'claude',
    patterns: [/claude/, /anthropic/],
    plan: {
      fields: { thinking: { type: 'disabled' } },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'Claude extended thinking is disabled with thinking.type=disabled.',
  },
  {
    id: 'gemini',
    patterns: [/gemini/],
    plan: {
      fields: {
        reasoning_effort: 'none',
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'Gemini uses thinkingBudget=0 on the native shape; reasoning_effort covers the OpenAI-compatible gateway.',
  },
  {
    id: 'gpt-oss',
    patterns: [/gpt[-_.]?oss/],
    plan: {
      fields: { reasoning_effort: 'low' },
      promptSuffix: '',
      canDisable: false,
    },
    note: 'gpt-oss cannot fully disable reasoning; low is the cheapest level.',
  },
  {
    id: 'openai-reasoning',
    patterns: [/^o[134]([-_.]|$)/, /gpt[-_.]?5/, /gpt5/],
    plan: {
      fields: { reasoning_effort: 'minimal' },
      promptSuffix: '',
      canDisable: false,
    },
    note: 'OpenAI reasoning models floor at reasoning_effort=minimal.',
  },
  {
    id: 'mistral',
    patterns: [/magistral/, /mistral/],
    plan: {
      fields: { reasoning_effort: 'none' },
      promptSuffix: '',
      canDisable: true,
    },
    note: 'Magistral follows the reasoning_effort convention.',
  },
];

/** The plan used when no family matches. */
const UNKNOWN_PLAN: ReasoningPlan = {
  name: 'unknown',
  fields: {
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    enable_thinking: false,
  },
  promptSuffix: '',
  canDisable: true,
};

/**
 * Normalises a model id for matching.
 *
 * @param modelId The raw model id from settings or the server.
 * @returns A lower-cased id with vendor prefixes stripped where possible.
 */
export function normaliseModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Detects the model family from a model id.
 *
 * @param modelId The model id, for example `qwen3.6-35b-a3b`.
 * @returns The family id, or `unknown` when nothing matches.
 */
export function detectModelFamily(modelId: string): string {
  const id = normaliseModelId(modelId);
  if (id.length === 0) {
    return 'unknown';
  }
  for (const family of FAMILIES) {
    if (family.patterns.some((pattern) => pattern.test(id))) {
      return family.id;
    }
  }
  return 'unknown';
}

/**
 * Returns the human-readable note for a model family.
 *
 * @param modelId The model id.
 * @returns A sentence describing how reasoning is disabled for that family.
 */
export function describeFamily(modelId: string): string {
  const familyId = detectModelFamily(modelId);
  const family = FAMILIES.find((entry) => entry.id === familyId);
  return family?.note ?? 'Unknown model family; generic suppression fields are used.';
}

/**
 * Returns true when the model exposes no way to disable reasoning.
 *
 * @param modelId The model id.
 * @returns True for always-reasoning models.
 */
export function cannotDisableReasoning(modelId: string): boolean {
  const familyId = detectModelFamily(modelId);
  const family = FAMILIES.find((entry) => entry.id === familyId);
  return family === undefined ? false : !family.plan.canDisable;
}

/**
 * Builds the family-preferred plan.
 *
 * @param modelId The model id.
 * @returns The first plan to attempt.
 */
export function primaryPlan(modelId: string): ReasoningPlan {
  const familyId = detectModelFamily(modelId);
  const family = FAMILIES.find((entry) => entry.id === familyId);
  if (family === undefined) {
    return UNKNOWN_PLAN;
  }
  return {
    name: family.id,
    fields: family.plan.fields,
    promptSuffix: family.plan.promptSuffix,
    canDisable: family.plan.canDisable,
  };
}

/** The generic fallbacks tried when the family plan fails. */
const GENERIC_FALLBACKS: ReasoningPlan[] = [
  {
    name: 'reasoning-effort-none',
    fields: { reasoning_effort: 'none' },
    promptSuffix: '',
    canDisable: true,
  },
  {
    name: 'enable-thinking-false',
    fields: { chat_template_kwargs: { enable_thinking: false }, enable_thinking: false },
    promptSuffix: '',
    canDisable: true,
  },
  {
    name: 'thinking-type-disabled',
    fields: { thinking: { type: 'disabled' } },
    promptSuffix: '',
    canDisable: true,
  },
  {
    name: 'no-think-suffix',
    fields: {},
    promptSuffix: ' /no_think',
    canDisable: true,
  },
  {
    name: 'default',
    fields: {},
    promptSuffix: '',
    canDisable: false,
  },
];

/**
 * Serialises a plan's fields for de-duplication.
 *
 * @param fields The request fields.
 * @returns A stable string key.
 */
function fieldsKey(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  return JSON.stringify(keys.map((key) => [key, fields[key]]));
}

/**
 * Builds the ordered list of plans to try for a model.
 *
 * The list always starts with the family plan and ends with the no-op plan, so
 * a caller can walk it until the response stops being reasoning-only. For
 * models that cannot disable reasoning the list is reduced to the family plan
 * alone, because retrying is guaranteed to fail.
 *
 * @param modelId The model id.
 * @param mode `off` to suppress, `default` to send nothing, `auto` to suppress.
 * @returns Ordered, de-duplicated plans.
 */
export function buildReasoningPlans(
  modelId: string,
  mode: ReasoningMode,
): ReasoningPlan[] {
  if (mode === 'default') {
    return [GENERIC_FALLBACKS[GENERIC_FALLBACKS.length - 1] as ReasoningPlan];
  }

  const first = primaryPlan(modelId);
  if (!first.canDisable) {
    return [first];
  }

  const seen = new Set<string>();
  const plans: ReasoningPlan[] = [];
  for (const plan of [first, ...GENERIC_FALLBACKS]) {
    const key = fieldsKey(plan.fields) + '|' + plan.promptSuffix;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    plans.push(plan);
  }
  return plans;
}

/**
 * Merges a plan's fields into a request body.
 *
 * @param body The base request body.
 * @param plan The plan to apply.
 * @returns A new body object.
 */
export function applyPlan(
  body: Record<string, unknown>,
  plan: ReasoningPlan,
): Record<string, unknown> {
  return { ...body, ...plan.fields };
}

/**
 * Appends a plan's prompt suffix to the last user message.
 *
 * @param messages Chat messages.
 * @param plan The plan whose suffix should be appended.
 * @returns A new message array; the original is not mutated.
 */
export function applyPromptSuffix(
  messages: { role: string; content: string }[],
  plan: ReasoningPlan,
): { role: string; content: string }[] {
  if (plan.promptSuffix.length === 0) {
    return messages;
  }
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUser = index;
      break;
    }
  }
  if (lastUser === -1) {
    return messages;
  }
  return messages.map((message, index) =>
    index === lastUser
      ? { role: message.role, content: message.content + plan.promptSuffix }
      : message,
  );
}

/**
 * Detects whether a response consumed its whole budget on reasoning.
 *
 * A server that ignores the suppression fields reports reasoning tokens equal
 * to the completion tokens and an empty content string. Detecting that lets
 * the caller escalate to the next plan instead of showing an empty completion.
 *
 * @param payload The raw chat-completion response body.
 * @returns True when the response was entirely reasoning.
 */
export function isReasoningOnlyResponse(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return false;
  }
  const message = (first as Record<string, unknown>)['message'];
  const content =
    typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>)['content']
      : undefined;
  const hasVisibleContent = typeof content === 'string' && content.trim().length > 0;
  if (hasVisibleContent) {
    return false;
  }

  const usage = record['usage'];
  if (typeof usage !== 'object' || usage === null) {
    // No usage block: treat an empty answer as reasoning-only so the caller
    // still escalates rather than silently returning nothing.
    return true;
  }
  const usageRecord = usage as Record<string, unknown>;
  const details = usageRecord['completion_tokens_details'];
  if (typeof details !== 'object' || details === null) {
    return true;
  }
  const reasoningTokens = (details as Record<string, unknown>)['reasoning_tokens'];
  if (typeof reasoningTokens !== 'number') {
    return true;
  }
  return reasoningTokens > 0;
}
