import { describe, expect, it } from 'vitest';
import {
  offsetAt,
  lineTextAt,
  extractImports,
  isMiddleOfLine,
  collectCompletionContext,
} from '../../src/completion/context.js';

describe('offsetAt', () => {
  const text = 'abc\ndef\nghi';

  it('returns zero for the document start', () => {
    expect(offsetAt(text, { line: 0, character: 0 })).toBe(0);
  });

  it('converts a position on the first line', () => {
    expect(offsetAt(text, { line: 0, character: 2 })).toBe(2);
  });

  it('converts a position on the second line', () => {
    expect(offsetAt(text, { line: 1, character: 0 })).toBe(4);
    expect(offsetAt(text, { line: 1, character: 2 })).toBe(6);
  });

  it('converts a position on the last line', () => {
    expect(offsetAt(text, { line: 2, character: 3 })).toBe(11);
  });

  it('clamps a character beyond the document to the document length', () => {
    expect(offsetAt(text, { line: 0, character: 999 })).toBe(text.length);
    expect(offsetAt(text, { line: 2, character: 999 })).toBe(text.length);
  });

  it('clamps a line beyond the document', () => {
    expect(offsetAt(text, { line: 99, character: 0 })).toBe(text.length);
  });

  it('clamps negative values to zero', () => {
    expect(offsetAt(text, { line: -1, character: -1 })).toBe(0);
  });

  it('handles an empty document', () => {
    expect(offsetAt('', { line: 0, character: 0 })).toBe(0);
    expect(offsetAt('', { line: 5, character: 5 })).toBe(0);
  });

  it('handles a document without trailing newline', () => {
    expect(offsetAt('abc', { line: 0, character: 3 })).toBe(3);
  });
});

describe('lineTextAt', () => {
  it('returns the requested line', () => {
    expect(lineTextAt('a\nb\nc', 1)).toBe('b');
  });

  it('strips a trailing carriage return', () => {
    expect(lineTextAt('a\r\nb', 0)).toBe('a');
  });

  it('returns an empty string for a missing line', () => {
    expect(lineTextAt('a\nb', 10)).toBe('');
  });

  it('clamps a negative line to zero', () => {
    expect(lineTextAt('a\nb', -1)).toBe('a');
  });
});

describe('extractImports', () => {
  it('finds ES module imports', () => {
    const text = "import { a } from 'x';\nimport b from 'y';\nconst c = 1;";
    expect(extractImports(text)).toEqual(["import { a } from 'x';", "import b from 'y';"]);
  });

  it('finds python imports', () => {
    const text = 'from os import path\nimport sys\nprint(1)';
    expect(extractImports(text)).toEqual(['from os import path', 'import sys']);
  });

  it('finds C includes', () => {
    expect(extractImports('#include <stdio.h>\nint main(){}')).toEqual(['#include <stdio.h>']);
  });

  it('finds C# using directives', () => {
    expect(extractImports('using System;\nclass A {}')).toEqual(['using System;']);
  });

  it('finds CommonJS requires', () => {
    expect(extractImports("const fs = require('fs');")).toEqual(["const fs = require('fs');"]);
  });

  it('respects the limit', () => {
    const text = 'import a from "a";\nimport b from "b";\nimport c from "c";';
    expect(extractImports(text, 2)).toHaveLength(2);
  });

  it('returns an empty array for a zero limit', () => {
    expect(extractImports('import a from "a";', 0)).toEqual([]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(extractImports('const a = 1;')).toEqual([]);
  });

  it('only scans the first eighty lines', () => {
    const padding = 'const x = 1;\n'.repeat(100);
    expect(extractImports(padding + 'import a from "a";')).toEqual([]);
  });
});

describe('isMiddleOfLine', () => {
  it('is false at the end of a line', () => {
    expect(isMiddleOfLine('const a = 1;', { line: 0, character: 12 })).toBe(false);
  });

  it('is true when code follows the cursor', () => {
    expect(isMiddleOfLine('const a = 1;', { line: 0, character: 6 })).toBe(true);
  });

  it('is false when only whitespace follows', () => {
    expect(isMiddleOfLine('const a =     ', { line: 0, character: 10 })).toBe(false);
  });

  it('is false on an empty line', () => {
    expect(isMiddleOfLine('', { line: 0, character: 0 })).toBe(false);
  });
});

describe('collectCompletionContext', () => {
  const document = {
    uri: 'file:///a.ts',
    languageId: 'typescript',
    version: 3,
    text: 'import x from "x";\nconst a = 1;\n',
    fileName: 'a.ts',
  };

  it('splits the document at the cursor', () => {
    const context = collectCompletionContext(document, { line: 1, character: 12 });
    expect(context.prefix).toBe('import x from "x";\nconst a = 1;');
    expect(context.suffix).toBe('\n');
  });

  it('captures the current line', () => {
    const context = collectCompletionContext(document, { line: 1, character: 0 });
    expect(context.currentLine).toBe('const a = 1;');
  });

  it('reports middle-of-line state', () => {
    const middle = collectCompletionContext(document, { line: 1, character: 6 });
    expect(middle.isMiddleOfLine).toBe(true);
    const end = collectCompletionContext(document, { line: 1, character: 12 });
    expect(end.isMiddleOfLine).toBe(false);
  });

  it('collects imports', () => {
    const context = collectCompletionContext(document, { line: 1, character: 0 });
    expect(context.imports).toEqual(['import x from "x";']);
  });

  it('preserves the document snapshot by reference', () => {
    const context = collectCompletionContext(document, { line: 0, character: 0 });
    expect(context.document).toBe(document);
    expect(context.position).toEqual({ line: 0, character: 0 });
  });
});
