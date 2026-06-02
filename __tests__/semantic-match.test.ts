/**
 * Unit tests for the SDK's semantic-match helper (pure scoring + selection).
 *
 * The SDK ships no jest runner of its own, so its pure utilities are
 * exercised here — the drum plugin is the canonical consumer and already
 * imports SDK utils in its other tests. Prompts below are real examples from
 * the StableAudio drum corpus (sas-sample-generator/prompts/kick.txt) so the
 * scoring is validated against the vocabulary it will see in production.
 */

import { describe, it, expect } from '@jest/globals';
import {
  tokenizePrompt,
  scorePromptMatch,
  pickTopKWeighted,
  type ScoredCandidate,
} from '@signalsandsorcery/plugin-sdk';

const KICK_PROMPTS = [
  'tight 909-style kick drum one shot, hard click transient, short punchy body, dry, no hi hats, no snare, no cymbals, no loop',
  'deep 808-style kick drum one shot, long sub bass decay, smooth sine low end, clean transient, dry, no melody, no loop',
  'analog techno kick one shot, vintage saturation, tight punch, warm body, dry, no melody',
  'boom bap kick one shot, dusty sampler texture, tight punchy body, vintage character, dry, no hi hats, no snare, no loop',
  'electro kick one shot, vintage analog character, punchy attack, tight body, dry, no melody, no loop',
];

const argmax = (scores: number[]): number =>
  scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0);

describe('tokenizePrompt', () => {
  it('strips comma-delimited negative clauses ("no hi hats", "no loop")', () => {
    const tokens = tokenizePrompt('punchy 909-style kick, no hi hats, no loop');
    expect(tokens).toEqual(expect.arrayContaining(['punchy', '909', 'style', 'kick']));
    expect(tokens).not.toContain('loop');
    expect(tokens).not.toContain('hats');
    expect(tokens).not.toContain('no');
  });

  it('drops stop-words and 1-2 digit numeric noise but keeps meaningful numerics', () => {
    const tokens = tokenizePrompt('give me a deep 808 kick 01');
    expect(tokens).toContain('808'); // meaningful 3-digit numeric kept
    expect(tokens).toContain('deep');
    expect(tokens).toContain('kick');
    expect(tokens).not.toContain('01'); // sequence noise dropped
    expect(tokens).not.toContain('me'); // stop-word
    expect(tokens).not.toContain('a');
  });

  it('returns empty for empty input', () => {
    expect(tokenizePrompt('')).toEqual([]);
  });
});

describe('scorePromptMatch', () => {
  it('ranks the 808/sub prompt highest for a "deep sub 808" query', () => {
    const scores = scorePromptMatch('deep sub 808', KICK_PROMPTS);
    expect(argmax(scores)).toBe(1);
    expect(scores[1]).toBeGreaterThan(scores[0]);
  });

  it('ranks the boom-bap prompt highest for a "dusty boom bap" query', () => {
    const scores = scorePromptMatch('dusty boom bap', KICK_PROMPTS);
    expect(argmax(scores)).toBe(3);
  });

  it('demonstrates the descriptor bridge: "vintage warm" prefers vintage prompts over the plain 909/808 ones', () => {
    const scores = scorePromptMatch('vintage warm', KICK_PROMPTS);
    // prompts 2,3,4 carry "vintage"; 0,1 do not.
    expect(Math.max(scores[2], scores[3], scores[4])).toBeGreaterThan(Math.max(scores[0], scores[1]));
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBe(0);
  });

  it('returns all-zero (no signal) when the query shares no token with any candidate', () => {
    const scores = scorePromptMatch('xylophone harpsichord bagpipes', KICK_PROMPTS);
    expect(scores).toHaveLength(KICK_PROMPTS.length);
    expect(Math.max(...scores)).toBe(0);
  });

  it('keeps every score within [0, 1]', () => {
    const scores = scorePromptMatch('tight punchy 909 kick', KICK_PROMPTS);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('handles an empty candidate pool', () => {
    expect(scorePromptMatch('anything', [])).toEqual([]);
  });
});

describe('pickTopKWeighted', () => {
  const scored: ScoredCandidate<string>[] = [
    { item: 'a', score: 0.9, key: 'a' },
    { item: 'b', score: 0.5, key: 'b' },
    { item: 'c', score: 0.1, key: 'c' },
    { item: 'd', score: 0.0, key: 'd' },
  ];

  it('with rng=0 returns the highest-scored candidate', () => {
    expect(pickTopKWeighted(scored, { rng: () => 0 })).toBe('a');
  });

  it('respects excludeKeys', () => {
    const pick = pickTopKWeighted(scored, { rng: () => 0, excludeKeys: new Set(['a']) });
    expect(pick).toBe('b'); // 'a' excluded → next highest at rng=0
  });

  it('returns null only when the pool is empty after exclusion', () => {
    expect(pickTopKWeighted([], {})).toBeNull();
    const allExcluded = pickTopKWeighted(scored, { excludeKeys: new Set(['a', 'b', 'c', 'd']) });
    expect(allExcluded).toBeNull();
  });

  it('distributes across the top-k when scores are flat (variety preserved)', () => {
    const flat: ScoredCandidate<string>[] = [
      { item: 'x', score: 0.4, key: 'x' },
      { item: 'y', score: 0.4, key: 'y' },
      { item: 'z', score: 0.4, key: 'z' },
    ];
    // Equal scores → equal weights → each third of the cumulative range.
    expect(pickTopKWeighted(flat, { rng: () => 0.1, k: 3 })).toBe('x');
    expect(pickTopKWeighted(flat, { rng: () => 0.5, k: 3 })).toBe('y');
    expect(pickTopKWeighted(flat, { rng: () => 0.9, k: 3 })).toBe('z');
  });

  it('limits selection to the top-k by score', () => {
    // k=1 → only the top candidate is ever eligible, regardless of rng.
    expect(pickTopKWeighted(scored, { rng: () => 0.99, k: 1 })).toBe('a');
  });
});
