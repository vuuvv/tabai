import { describe, expect, it } from 'vitest';
import {
  AIClient,
  normaliseCommitMessage,
  stripMarkdownFences,
} from '../../src/ai/client.js';
import type { CompletionContext, GitDiffSummary, TabAISettings } from '../../src/core/types.js';
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

/**
 * Creates a fetch stub that captures the request and returns a canned body.
 *
 * @param body Response body to return.
 * @param status HTTP status.
 * @returns A fetch implementation plus accessors for the captured request.
 */
function capturingFetch(
  body: unknown,
  status = 200,
): {
  fetchImpl: typeof fetch;
  url: () => string;
  parsedBody: () => Record<string, unknown>;
} {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  const impl = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    // GET requests carry no body; default to an empty object so callers can
    // still assert on the parsed shape without a null check.
    capturedBody =
      init.body === undefined || init.body === null
        ? {}
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return {
    fetchImpl: impl,
    url: () => capturedUrl,
    parsedBody: () => capturedBody,
  };
}

describe('AIClient.complete with the fim protocol', () => {
  it('posts to /completions', async () => {
    const stub = capturingFetch({
      model: 'qwen',
      choices: [{ text: 'return 1;', finish_reason: 'stop' }],
    });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    const result = await client.complete(settingsWith({ providerType: 'fim' }), context());

    expect(stub.url()).toBe('http://192.168.2.101:1234/v1/completions');
    expect(result.text).toBe('return 1;');
    expect(result.model).toBe('qwen');
  });

  it('sends a FIM-wrapped prompt', async () => {
    const stub = capturingFetch({ choices: [{ text: '', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(settingsWith({ providerType: 'fim' }), context());

    const prompt = String(stub.parsedBody()['prompt']);
    expect(prompt).toContain('<|fim_prefix|>');
    expect(prompt).toContain('<|fim_suffix|>');
    expect(prompt).toContain('<|fim_middle|>');
  });

  it('passes the configured token and temperature settings', async () => {
    const stub = capturingFetch({ choices: [{ text: 'x', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(
      settingsWith({ providerType: 'fim', maxTokens: 64, temperature: 0.5 }),
      context(),
    );

    expect(stub.parsedBody()['max_tokens']).toBe(64);
    expect(stub.parsedBody()['temperature']).toBe(0.5);
    expect(stub.parsedBody()['stream']).toBe(false);
  });

  it('includes stop sequences', async () => {
    const stub = capturingFetch({ choices: [{ text: 'x', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(settingsWith({ providerType: 'fim' }), context());

    const stops = stub.parsedBody()['stop'] as string[];
    expect(stops).toContain('<|fim_pad|>');
  });

  it('trims the prefix to the configured line budget', async () => {
    const stub = capturingFetch({ choices: [{ text: 'x', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    const longPrefix = Array.from({ length: 50 }, (_, i) => 'line' + i).join('\n');
    await client.complete(
      settingsWith({ providerType: 'fim', maxPrefixLines: 3 }),
      { ...context(), prefix: longPrefix },
    );

    const prompt = String(stub.parsedBody()['prompt']);
    expect(prompt).toContain('line49');
    expect(prompt).not.toContain('line0');
  });

  it('measures latency', async () => {
    const stub = capturingFetch({ choices: [{ text: 'x', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    const result = await client.complete(settingsWith({ providerType: 'fim' }), context());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.fromCache).toBe(false);
  });
});

describe('AIClient.complete with the chat protocol', () => {
  it('posts to /chat/completions', async () => {
    const stub = capturingFetch({
      model: 'qwen',
      choices: [{ message: { content: 'return 1;' }, finish_reason: 'stop' }],
    });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    const result = await client.complete(
      settingsWith({ providerType: 'openai-compatible' }),
      context(),
    );

    expect(stub.url()).toBe('http://192.168.2.101:1234/v1/chat/completions');
    expect(result.text).toBe('return 1;');
  });

  it('sends system and user messages', async () => {
    const stub = capturingFetch({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(settingsWith({ providerType: 'openai-compatible' }), context());

    const messages = stub.parsedBody()['messages'] as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('<CURSOR>');
  });

  it('disables thinking for reasoning models', async () => {
    const stub = capturingFetch({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(settingsWith({ providerType: 'openai-compatible' }), context());

    expect(stub.parsedBody()['chat_template_kwargs']).toEqual({ enable_thinking: false });
  });
});

describe('AIClient.complete error handling', () => {
  it('propagates a TabAIError from the transport', async () => {
    const impl = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const client = new AIClient({ fetchImpl: impl });
    await expect(
      client.complete(settingsWith({ maxRetries: 0 }), context()),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('normalises the base url trailing slash', async () => {
    const stub = capturingFetch({ choices: [{ text: 'x', finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.complete(
      settingsWith({ providerType: 'fim', baseUrl: 'http://host:1/v1/' }),
      context(),
    );
    expect(stub.url()).toBe('http://host:1/v1/completions');
  });
});

describe('AIClient.generateCommitMessage', () => {
  /**
   * Builds a diff summary for the commit tests.
   *
   * @returns A one-file summary.
   */
  function summary(): GitDiffSummary {
    return {
      repoRoot: '/repo',
      branch: 'main',
      files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }],
      diff: '+const a = 1;',
      truncated: false,
    stagedOnly: false,
    };
  }

  it('returns the parsed subject and body', async () => {
    const stub = capturingFetch({
      model: 'qwen',
      choices: [
        {
          message: { content: 'feat(auth): add login\n\n- add form\n- add test' },
          finish_reason: 'stop',
        },
      ],
    });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    const result = await client.generateCommitMessage(settingsWith(), summary());

    expect(result.subject).toBe('feat(auth): add login');
    expect(result.body).toBe('- add form\n- add test');
    expect(result.message).toBe('feat(auth): add login\n\n- add form\n- add test');
  });

  it('throws when there is nothing to commit', async () => {
    const client = new AIClient();
    await expect(
      client.generateCommitMessage(settingsWith(), { ...summary(), files: [] }),
    ).rejects.toMatchObject({ kind: 'not-configured' });
  });

  it('throws when the model returns an empty message', async () => {
    const stub = capturingFetch({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await expect(
      client.generateCommitMessage(settingsWith(), summary()),
    ).rejects.toMatchObject({ kind: 'parse' });
  });

  it('uses the commit model, not the completion model', async () => {
    const stub = capturingFetch({ choices: [{ message: { content: 'fix: x' }, finish_reason: 'stop' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    await client.generateCommitMessage(
      settingsWith({ completionModel: 'completion-model', commitModel: 'commit-model' }),
      summary(),
    );
    expect(stub.parsedBody()['model']).toBe('commit-model');
  });
});

describe('AIClient.listModels', () => {
  it('returns the advertised ids', async () => {
    const stub = capturingFetch({ data: [{ id: 'a' }, { id: 'b' }] });
    const client = new AIClient({ fetchImpl: stub.fetchImpl });
    expect(await client.listModels(settingsWith())).toEqual(['a', 'b']);
  });

  it('returns an empty array when the endpoint fails', async () => {
    const impl = (async () => {
      throw new TypeError('down');
    }) as unknown as typeof fetch;
    const client = new AIClient({ fetchImpl: impl });
    expect(await client.listModels(settingsWith())).toEqual([]);
  });
});

describe('stripMarkdownFences', () => {
  it('removes a fenced block', () => {
    expect(stripMarkdownFences('\u0060\u0060\u0060ts\nconst a = 1;\n\u0060\u0060\u0060')).toBe(
      'const a = 1;',
    );
  });

  it('removes wrapping double quotes', () => {
    expect(stripMarkdownFences('"feat: x"')).toBe('feat: x');
  });

  it('removes wrapping single quotes', () => {
    expect(stripMarkdownFences("'fix: y'")).toBe('fix: y');
  });

  it('leaves plain text alone', () => {
    expect(stripMarkdownFences('feat: x')).toBe('feat: x');
  });
});

describe('normaliseCommitMessage', () => {
  it('splits subject and body at the first blank line', () => {
    const result = normaliseCommitMessage('feat: x\n\nbody line');
    expect(result.subject).toBe('feat: x');
    expect(result.body).toBe('body line');
    expect(result.message).toBe('feat: x\n\nbody line');
  });

  it('handles a subject-only message', () => {
    const result = normaliseCommitMessage('feat: x');
    expect(result.subject).toBe('feat: x');
    expect(result.body).toBe('');
    expect(result.message).toBe('feat: x');
  });

  it('strips leading bullet noise from the subject', () => {
    expect(normaliseCommitMessage('- feat: x').subject).toBe('feat: x');
  });

  it('strips numbered list prefixes from the subject', () => {
    expect(normaliseCommitMessage('1. feat: x').subject).toBe('feat: x');
  });

  it('trims trailing whitespace on each line', () => {
    expect(normaliseCommitMessage('feat: x   \n\nbody   ').subject).toBe('feat: x');
  });

  it('returns empty parts for empty input', () => {
    expect(normaliseCommitMessage('   ')).toEqual({ message: '', subject: '', body: '' });
  });
});
