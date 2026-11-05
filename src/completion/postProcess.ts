/**
 * Post-processing for raw model output.
 *
 * Completion models leak all sorts of artefacts: sentinel tokens, repeated
 * lines, markdown fences, trailing prose. This module turns a raw string into
 * either a clean insertion or `null` when nothing usable remains.
 *
 * The rules are modelled on the reference implementation's post-process
 * pipeline, reduced to the ones that measurably reduce bad completions.
 */

/** The outcome of post-processing. */
export interface PostProcessOutcome {
  /** The cleaned insertion text, or `null` when the completion is unusable. */
  text: string | null;
  /** Machine-readable reason for a rejection, for telemetry. */
  reason: string;
}

/**
 * Removes every known FIM sentinel from a string.
 *
 * @param text Raw model output.
 * @returns Text with sentinels stripped.
 */
export function stripSentinels(text: string): string {
  return text
    .replace(/<\|fim_prefix\|>/g, '')
    .replace(/<\|fim_suffix\|>/g, '')
    .replace(/<\|fim_middle\|>/g, '')
    .replace(/<\|fim_pad\|>/g, '')
    .replace(/<\|endoftext\|>/g, '')
    .replace(/<\|endofprompt\|>/g, '')
    .replace(/<fim_prefix>/g, '')
    .replace(/<fim_suffix>/g, '')
    .replace(/<fim_middle>/g, '')
    .replace(/<fim_pad>/g, '');
}

/**
 * Removes markdown code fences that wrap the whole completion.
 *
 * @param text Raw model output.
 * @returns Text without a wrapping fence.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9+#-]*\n([\s\S]*?)\n?```$/);
  if (match !== null && typeof match[1] === 'string') {
    return match[1];
  }
  return text;
}

/**
 * Removes a leading repetition of the text that already precedes the cursor.
 *
 * Models sometimes re-emit the current line before continuing. Inserting that
 * would duplicate code, so any prefix of the completion that matches the tail
 * of the document prefix is dropped.
 *
 * @param completion The candidate completion text.
 * @param prefix The document text before the cursor.
 * @param maxOverlap Maximum number of characters to consider.
 * @returns The completion with the overlap removed.
 */
export function stripPrefixOverlap(
  completion: string,
  prefix: string,
  maxOverlap = 200,
): string {
  if (completion.length === 0 || prefix.length === 0) {
    return completion;
  }
  const limit = Math.min(
    Math.max(0, maxOverlap),
    completion.length,
    prefix.length,
  );
  for (let length = limit; length > 0; length -= 1) {
    const candidate = completion.slice(0, length);
    if (prefix.endsWith(candidate)) {
      return completion.slice(length);
    }
  }
  return completion;
}

/**
 * Collapses a completion that simply repeats the line already typed.
 *
 * @param completion Candidate completion text.
 * @param currentLine The line the cursor sits on.
 * @returns An empty string when the completion merely repeats the line.
 */
export function dropLineRepetition(completion: string, currentLine: string): string {
  const firstLine = completion.split('\n')[0] ?? '';
  const typed = currentLine.trimEnd();
  if (typed.length === 0) {
    return completion;
  }
  if (firstLine.trimEnd() === typed) {
    const rest = completion.split('\n').slice(1);
    return rest.length === 0 ? '' : rest.join('\n');
  }
  return completion;
}

/**
 * Removes consecutive duplicate lines from a completion.
 *
 * A common failure mode is an infinite loop producing the same statement over
 * and over; keeping one copy is almost always the intended output.
 *
 * @param text Candidate completion text.
 * @returns Text with consecutive duplicate lines collapsed.
 */
export function collapseRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous === line && line.trim().length > 0) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Normalises line endings to `\n`.
 *
 * @param text Text to normalise.
 * @returns Text with `\r\n` and lone `\r` converted to `\n`.
 */
export function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Detects whether a completion is only whitespace or punctuation noise.
 *
 * @param text Candidate completion text.
 * @returns True when there is nothing meaningful to insert.
 */
export function isNoiseOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return /^[\s\p{P}]+$/u.test(trimmed);
}

/**
 * Applies the full post-processing pipeline to a raw completion.
 *
 * The order matters: sentinels are stripped first so that the "noise only"
 * check sees the real payload, and overlap removal runs before the repetition
 * check so that a legitimate continuation is not mistaken for a repeat.
 *
 * @param raw Raw model output.
 * @param options Context used by the individual rules.
 * @param options.prefix Document text before the cursor.
 * @param options.currentLine The line the cursor sits on.
 * @param options.multiline Whether multi-line output is allowed.
 * @param options.minLength Minimum characters required to accept the result.
 * @returns The processed text plus a reason when rejected.
 */
export function postProcessCompletion(
  raw: string,
  options: {
    prefix: string;
    currentLine: string;
    multiline: boolean;
    minLength?: number;
  },
): PostProcessOutcome {
  const minLength = options.minLength ?? 1;

  let text = normaliseEol(raw);
  text = stripSentinels(text);
  text = stripCodeFence(text);

  if (text.trim().length === 0) {
    return { text: null, reason: 'empty' };
  }

  if (!options.multiline) {
    text = text.split('\n')[0] ?? '';
  }

  text = stripPrefixOverlap(text, options.prefix);
  text = dropLineRepetition(text, options.currentLine);
  text = collapseRepeatedLines(text);

  if (text.trim().length === 0) {
    return { text: null, reason: 'empty-after-overlap' };
  }
  if (isNoiseOnly(text)) {
    return { text: null, reason: 'noise-only' };
  }
  if (text.trim().length < minLength) {
    return { text: null, reason: 'too-short' };
  }

  return { text, reason: 'accepted' };
}
