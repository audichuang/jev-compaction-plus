import { describe, expect, it } from 'vitest';
import { buildJevRequest, previewOf, sliceSurrogateSafe } from '../src/index.js';

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('surrogate-safe cuts (upstream #128)', () => {
  it('never splits a pair at a head or tail cut', () => {
    const text = 'a'.repeat(9) + '🔥' + 'b'.repeat(20) + '🔥' + 'c'.repeat(9);
    expect(sliceSurrogateSafe(text, 0, 10)).not.toMatch(lone);
    expect(sliceSurrogateSafe(text, text.length - 10, text.length)).not.toMatch(lone);
    for (let chars = 1; chars < text.length; chars++) expect(previewOf(text, chars)).not.toMatch(lone);
  });

  it('escapes a lone surrogate that reaches the request body as U+FFFD', () => {
    const state = { context: 'x', goal: '\ud83d broken', history: [] };
    const { body } = buildJevRequest({ apiKey: 'k' }, state as never, {});
    expect(body).not.toMatch(/\\ud83d/i);
    expect(body).toContain('\\ufffd');
  });
});
