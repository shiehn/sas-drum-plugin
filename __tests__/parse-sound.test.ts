/**
 * Phase-2 parser coverage: the optional `sound` sonic descriptor.
 *
 * Critically asserts the field is non-breaking — a response that omits
 * `sound` (older prompt, or the LLM choosing not to emit it) still parses
 * exactly as before.
 */

import { describe, it, expect } from '@jest/globals';
import { parseLLMDrumResponse } from '../src/parse-llm-response';

const NOTE = { pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 110 };

describe('parseLLMDrumResponse — sound field', () => {
  it('extracts a non-empty sound descriptor', () => {
    const parsed = parseLLMDrumResponse(
      JSON.stringify({ notes: [NOTE], role: 'kick', sound: 'vintage warm analog tape' }),
    );
    expect(parsed?.sound).toBe('vintage warm analog tape');
    expect(parsed?.role).toBe('kick');
  });

  it('trims surrounding whitespace', () => {
    const parsed = parseLLMDrumResponse(
      JSON.stringify({ notes: [NOTE], role: 'kick', sound: '  punchy 909  ' }),
    );
    expect(parsed?.sound).toBe('punchy 909');
  });

  it('is undefined when omitted (non-breaking with older output)', () => {
    const parsed = parseLLMDrumResponse(JSON.stringify({ notes: [NOTE], role: 'kick' }));
    expect(parsed?.sound).toBeUndefined();
    expect(parsed?.notes).toHaveLength(1);
  });

  it('is undefined for an empty or non-string sound', () => {
    expect(parseLLMDrumResponse(JSON.stringify({ notes: [NOTE], sound: '' }))?.sound).toBeUndefined();
    expect(parseLLMDrumResponse(JSON.stringify({ notes: [NOTE], sound: 42 }))?.sound).toBeUndefined();
  });
});
