import { describe, expect, it } from 'vitest';
import {
  parseChatCompletion,
  parseModelList,
  parseTextCompletion,
} from '../../src/ai/parsers.js';
import { TabAIError } from '../../src/core/types.js';

describe('parseTextCompletion', () => {
  it('extracts text, finish reason and model', () => {
    const parsed = parseTextCompletion({
      model: 'qwen',
      choices: [{ text: 'return a + b;', finish_reason: 'stop' }],
    });
    expect(parsed).toEqual({ text: 'return a + b;', finishReason: 'stop', model: 'qwen' });
  });

  it('defaults the finish reason when missing', () => {
    const parsed = parseTextCompletion({ choices: [{ text: 'x' }] });
    expect(parsed.finishReason).toBe('unknown');
  });

  it('defaults the model when missing', () => {
    const parsed = parseTextCompletion({ choices: [{ text: 'x' }] });
    expect(parsed.model).toBe('unknown');
  });

  it('accepts an empty text', () => {
    const parsed = parseTextCompletion({ choices: [{ text: '', finish_reason: 'stop' }] });
    expect(parsed.text).toBe('');
  });

  it('throws when there are no choices', () => {
    expect(() => parseTextCompletion({ choices: [] })).toThrow(TabAIError);
  });

  it('throws when choices is missing', () => {
    expect(() => parseTextCompletion({})).toThrow(TabAIError);
  });

  it('throws for a non-object payload', () => {
    expect(() => parseTextCompletion('nope')).toThrow(TabAIError);
  });

  it('throws when the choice has no text field', () => {
    expect(() => parseTextCompletion({ choices: [{ finish_reason: 'stop' }] })).toThrow(TabAIError);
  });

  it('ignores a non-object first choice', () => {
    expect(() => parseTextCompletion({ choices: ['bad'] })).toThrow(TabAIError);
  });
});

describe('parseChatCompletion', () => {
  it('extracts the assistant content', () => {
    const parsed = parseChatCompletion({
      model: 'qwen',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    });
    expect(parsed).toEqual({ content: 'hello', finishReason: 'stop', model: 'qwen' });
  });

  it('ignores reasoning_content', () => {
    const parsed = parseChatCompletion({
      choices: [
        {
          message: { content: 'real answer', reasoning_content: 'thinking...' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(parsed.content).toBe('real answer');
  });

  it('throws when the message is missing', () => {
    expect(() => parseChatCompletion({ choices: [{}] })).toThrow(TabAIError);
  });

  it('throws when content is not a string', () => {
    expect(() => parseChatCompletion({ choices: [{ message: { content: null } }] })).toThrow(
      TabAIError,
    );
  });

  it('throws when there are no choices', () => {
    expect(() => parseChatCompletion({ choices: [] })).toThrow(TabAIError);
  });
});

describe('parseModelList', () => {
  it('extracts model ids in order', () => {
    const ids = parseModelList({
      data: [{ id: 'a' }, { id: 'b' }],
    });
    expect(ids).toEqual(['a', 'b']);
  });

  it('skips entries without an id', () => {
    const ids = parseModelList({ data: [{ id: 'a' }, {}, { id: 42 }] });
    expect(ids).toEqual(['a']);
  });

  it('returns an empty array for a malformed payload', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList({ data: 'nope' })).toEqual([]);
  });
});
