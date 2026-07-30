/**
 * Pure-rule tests for the hat-interplay resolver: suppression (open replaces
 * closed on the same step), computed open-hat tails (ring until the next hat
 * hit), grouping semantics, epsilon boundaries, and determinism.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import {
  HAT_COLLISION_EPSILON_BEATS,
  hatArticulationForRole,
  resolveHatInterplay,
} from '../src/hat-interplay';
import type { HatTrackSource } from '../src/hat-interplay';

const CLIP_BEATS = 4; // one 4/4 bar

function note(startBeat: number, durationBeats = 0.15, velocity = 100): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

/** Constant closed 8ths across one bar: 0, 0.5, … 3.5. */
function closedEighths(): PluginMidiNote[] {
  return Array.from({ length: 8 }, (_, i) => note(i * 0.5, 0.15, i % 2 === 0 ? 105 : 82));
}

function track(
  dbId: string,
  articulation: 'open' | 'closed',
  sourceNotes: PluginMidiNote[],
): HatTrackSource {
  return { trackId: `engine-${dbId}`, dbId, articulation, sourceNotes };
}

function byDbId(resolutions: ReturnType<typeof resolveHatInterplay>, dbId: string) {
  const found = resolutions.find(r => r.dbId === dbId);
  expect(found).toBeDefined();
  return found!;
}

describe('hatArticulationForRole', () => {
  it('maps the canonical hat roles and rejects everything else', () => {
    expect(hatArticulationForRole('hat-open')).toBe('open');
    expect(hatArticulationForRole('hat-closed')).toBe('closed');
    expect(hatArticulationForRole(' HAT-OPEN ')).toBe('open'); // tolerant of case/whitespace
    expect(hatArticulationForRole('kick')).toBeNull();
    expect(hatArticulationForRole(undefined)).toBeNull();
    expect(hatArticulationForRole(null)).toBeNull();
  });
});

describe('resolveHatInterplay — headline case', () => {
  it('open hat on beat 1 suppresses the closed 8th there and rings to the next closed hit', () => {
    const resolutions = resolveHatInterplay(
      [track('closed', 'closed', closedEighths()), track('open', 'open', [note(0, 0.2, 110)])],
      CLIP_BEATS,
    );

    const closed = byDbId(resolutions, 'closed');
    expect(closed.suppressedSourceIndexes).toEqual([0]); // the hit at beat 0
    expect(closed.notes.map(n => n.startBeat)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5]);

    const open = byDbId(resolutions, 'open');
    expect(open.suppressedSourceIndexes).toEqual([]);
    expect(open.notes).toHaveLength(1);
    // Authored duration (0.2) is ignored — ring ends at the surviving closed 8th.
    expect(open.notes[0].durationBeats).toBeCloseTo(0.5, 6);
  });

  it('closed notes pass through verbatim (micro-timing, velocity, duration)', () => {
    const authored = [note(0.04, 0.11, 91), note(1.483, 0.2, 64)];
    const resolutions = resolveHatInterplay([track('closed', 'closed', authored)], CLIP_BEATS);
    expect(byDbId(resolutions, 'closed').notes.map(({ sourceIndex: _s, ...n }) => n)).toEqual(authored);
  });
});

describe('resolveHatInterplay — grouping', () => {
  it('one open suppresses colliding hits on EVERY closed track (one hi-hat per scene)', () => {
    const resolutions = resolveHatInterplay(
      [
        track('closed-a', 'closed', closedEighths()),
        track('closed-b', 'closed', [note(1.0, 0.1, 70), note(3.0, 0.1, 70)]),
        track('open', 'open', [note(1.0, 0.2, 112)]),
      ],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'closed-a').suppressedSourceIndexes).toEqual([2]); // 1.0
    expect(byDbId(resolutions, 'closed-b').suppressedSourceIndexes).toEqual([0]); // 1.0
    // Ring ends at the earliest surviving hit anywhere in the group (closed-a @1.5).
    expect(byDbId(resolutions, 'open').notes[0].durationBeats).toBeCloseTo(0.5, 6);
  });

  it('same articulation never suppresses: two closed tracks layer on the same step', () => {
    const hits = [note(0), note(2)];
    const resolutions = resolveHatInterplay(
      [track('closed-a', 'closed', hits), track('closed-b', 'closed', hits)],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'closed-a').suppressedSourceIndexes).toEqual([]);
    expect(byDbId(resolutions, 'closed-b').suppressedSourceIndexes).toEqual([]);
  });

  it('two open tracks layer, and each open still chokes at the next hat hit on any track', () => {
    const resolutions = resolveHatInterplay(
      [track('open-a', 'open', [note(0)]), track('open-b', 'open', [note(1.5)])],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'open-a').notes[0].durationBeats).toBeCloseTo(1.5, 6);
    // Last hat hit in the group rings to the clip end.
    expect(byDbId(resolutions, 'open-b').notes[0].durationBeats).toBeCloseTo(2.5, 6);
  });
});

describe('resolveHatInterplay — tails', () => {
  it('an open with no following hat rings to the clip end', () => {
    const resolutions = resolveHatInterplay([track('open', 'open', [note(3.0)])], CLIP_BEATS);
    expect(byDbId(resolutions, 'open').notes[0].durationBeats).toBeCloseTo(1.0, 6);
  });

  it('consecutive opens on one track choke each other', () => {
    const resolutions = resolveHatInterplay([track('open', 'open', [note(0), note(1)])], CLIP_BEATS);
    const [first, second] = byDbId(resolutions, 'open').notes;
    expect(first.durationBeats).toBeCloseTo(1.0, 6);
    expect(second.durationBeats).toBeCloseTo(3.0, 6);
  });
});

describe('resolveHatInterplay — epsilon boundaries', () => {
  it('a closed hit exactly epsilon away is still "the same step" (suppressed)', () => {
    const resolutions = resolveHatInterplay(
      [
        track('closed', 'closed', [note(HAT_COLLISION_EPSILON_BEATS)]),
        track('open', 'open', [note(0)]),
      ],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'closed').suppressedSourceIndexes).toEqual([0]);
  });

  it('a closed hit just past epsilon survives and becomes the choke point', () => {
    const closedStart = HAT_COLLISION_EPSILON_BEATS + 0.001;
    const resolutions = resolveHatInterplay(
      [track('closed', 'closed', [note(closedStart)]), track('open', 'open', [note(0)])],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'closed').suppressedSourceIndexes).toEqual([]);
    expect(byDbId(resolutions, 'open').notes[0].durationBeats).toBeCloseTo(closedStart, 6);
  });

  it('micro-timing: a feel-shifted closed at 0.083 is the same step; a true 32nd at 0.125 is not', () => {
    const resolutions = resolveHatInterplay(
      [
        track('closed', 'closed', [note(0.083), note(2 + 0.125)]),
        track('open', 'open', [note(0), note(2)]),
      ],
      CLIP_BEATS,
    );
    expect(byDbId(resolutions, 'closed').suppressedSourceIndexes).toEqual([0]);
    expect(byDbId(resolutions, 'open').notes[1].durationBeats).toBeCloseTo(0.125, 6);
  });
});

describe('resolveHatInterplay — lossless recompute', () => {
  it('a suppressed closed hit reappears when the open pattern moves (no accumulation)', () => {
    const closedSource = closedEighths();
    const withOpenAtZero = resolveHatInterplay(
      [track('closed', 'closed', closedSource), track('open', 'open', [note(0)])],
      CLIP_BEATS,
    );
    expect(byDbId(withOpenAtZero, 'closed').notes).toHaveLength(7);

    // Regenerated open pattern no longer collides at 0 — the closed source was
    // never mutated, so the hit at 0 is back and the one at 2 is now hidden.
    const withOpenAtTwo = resolveHatInterplay(
      [track('closed', 'closed', closedSource), track('open', 'open', [note(2)])],
      CLIP_BEATS,
    );
    const closed = byDbId(withOpenAtTwo, 'closed');
    expect(closed.notes.map(n => n.startBeat)).toContain(0);
    expect(closed.suppressedSourceIndexes).toEqual([4]); // beat 2
  });

  it('is deterministic under shuffled track and note order', () => {
    const closed = closedEighths();
    const opens = [note(1), note(3)];
    const a = resolveHatInterplay(
      [track('closed', 'closed', closed), track('open', 'open', opens)],
      CLIP_BEATS,
    );
    const b = resolveHatInterplay(
      [track('open', 'open', [...opens].reverse()), track('closed', 'closed', [...closed].reverse())],
      CLIP_BEATS,
    );
    for (const dbId of ['closed', 'open']) {
      const notesA = byDbId(a, dbId).notes.map(({ sourceIndex: _s, ...n }) => n);
      const notesB = byDbId(b, dbId).notes.map(({ sourceIndex: _s, ...n }) => n);
      expect(notesB).toEqual(notesA);
    }
  });
});
