import { describe, expect, it } from 'vitest';
import { parseModelList } from '../../src/ai/parsers.js';

describe('parseModelList response shapes', () => {
  it('parses the OpenAI shape', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });

  it('parses the LM Studio native shape', () => {
    expect(
      parseModelList({ models: [{ key: 'qwen3.6-35b-a3b' }, { key: 'other' }] }),
    ).toEqual(['qwen3.6-35b-a3b', 'other']);
  });

  it('prefers id over key when both exist', () => {
    expect(parseModelList({ models: [{ id: 'from-id', key: 'from-key' }] })).toEqual(['from-id']);
  });

  it('returns an empty array for an error payload', () => {
    // LM Studio answers a bad POST with HTTP 200 and this body.
    expect(parseModelList({ error: 'Unexpected endpoint or method.' })).toEqual([]);
  });

  it('returns an empty array for an unknown shape', () => {
    expect(parseModelList({ items: [] })).toEqual([]);
  });
});
