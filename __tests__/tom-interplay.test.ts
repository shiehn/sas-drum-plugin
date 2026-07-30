/**
 * Pure-resolver tests for tom interplay: the two-hands limit
 * (MAX_SIMULTANEOUS_TOMS = 2), the velocity→depth→dbId→sourceIndex
 * survivor order, ε-window boundaries, determinism/order-independence, and
 * the recompute-restores property that makes the projection lossless.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import {
  MAX_SIMULTANEOUS_TOMS,
  TOM_COLLISION_EPSILON_BEATS,
  resolveTomInterplay,
  tomDepthForRole,
  normalizeTomRole,
} from '../src/tom-interplay';
import type { TomTrackSource, TomTrackResolution } from '../src/tom-interplay';

function note(startBeat: number, velocity = 100, durationBeats = 0.15): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

function track(dbId: string, role: TomTrackSource['role'], sourceNotes: PluginMidiNote[]): TomTrackSource {
  return { trackId: `engine-${dbId}`, dbId, role, sourceNotes };
}

function byDbId(resolutions: TomTrackResolution[]): Map<string, TomTrackResolution> {
  return new Map(resolutions.map(r => [r.dbId, r]));
}

const CLIP_LEN = 4;

describe('role mapping', () => {
  it('normalizes tom folder roles and rejects everything else', () => {
    expect(normalizeTomRole('tom-hi')).toBe('tom-hi');
    expect(normalizeTomRole(' Tom-Low ')).toBe('tom-low');
    expect(normalizeTomRole('hat-open')).toBeNull();
    expect(normalizeTomRole(null)).toBeNull();
    expect(tomDepthForRole('tom-low')).toBe(3);
    expect(tomDepthForRole('tom-mid')).toBe(2);
    expect(tomDepthForRole('tom-hi')).toBe(1);
    expect(tomDepthForRole('kick')).toBeNull();
  });
});

describe('resolveTomInterplay — two-hands limit', () => {
  it('exports the agreed constant', () => {
    expect(MAX_SIMULTANEOUS_TOMS).toBe(2);
  });

  it('a two-tom unison is untouched', () => {
    const res = byDbId(resolveTomInterplay(
      [track('hi', 'tom-hi', [note(0, 110)]), track('low', 'tom-low', [note(0, 90)])],
      CLIP_LEN,
    ));
    expect(res.get('hi')!.notes).toHaveLength(1);
    expect(res.get('low')!.notes).toHaveLength(1);
    expect(res.get('hi')!.suppressedSourceIndexes).toEqual([]);
    expect(res.get('low')!.suppressedSourceIndexes).toEqual([]);
  });

  it('three simultaneous toms keep the top two by velocity', () => {
    const res = byDbId(resolveTomInterplay(
      [
        track('hi', 'tom-hi', [note(0, 120)]),
        track('mid', 'tom-mid', [note(0, 100)]),
        track('low', 'tom-low', [note(0, 80)]),
      ],
      CLIP_LEN,
    ));
    expect(res.get('hi')!.notes).toHaveLength(1);
    expect(res.get('mid')!.notes).toHaveLength(1);
    expect(res.get('low')!.notes).toHaveLength(0);
    expect(res.get('low')!.suppressedSourceIndexes).toEqual([0]);
  });

  it('four simultaneous toms suppress two', () => {
    const res = resolveTomInterplay(
      [
        track('a', 'tom-hi', [note(0, 120)]),
        track('b', 'tom-mid', [note(0, 110)]),
        track('c', 'tom-low', [note(0, 100)]),
        track('d', 'tom-low', [note(0, 90)]),
      ],
      CLIP_LEN,
    );
    const surviving = res.reduce((sum, r) => sum + r.notes.length, 0);
    const suppressed = res.reduce((sum, r) => sum + r.suppressedSourceIndexes.length, 0);
    expect(surviving).toBe(2);
    expect(suppressed).toBe(2);
  });

  it('velocity tie breaks by depth — the LOWER drum survives', () => {
    const res = byDbId(resolveTomInterplay(
      [
        track('hi', 'tom-hi', [note(0, 100)]),
        track('mid', 'tom-mid', [note(0, 100)]),
        track('low', 'tom-low', [note(0, 100)]),
      ],
      CLIP_LEN,
    ));
    expect(res.get('low')!.notes).toHaveLength(1);
    expect(res.get('mid')!.notes).toHaveLength(1);
    expect(res.get('hi')!.notes).toHaveLength(0);
  });

  it('same-depth tracks suppress each other (two tom-mids still share two hands)', () => {
    const res = byDbId(resolveTomInterplay(
      [
        track('mid-a', 'tom-mid', [note(0, 100)]),
        track('mid-b', 'tom-mid', [note(0, 100)]),
        track('low', 'tom-low', [note(0, 100)]),
      ],
      CLIP_LEN,
    ));
    // Total order: low (depth) > mid-a (dbId) > mid-b.
    expect(res.get('low')!.notes).toHaveLength(1);
    expect(res.get('mid-a')!.notes).toHaveLength(1);
    expect(res.get('mid-b')!.notes).toHaveLength(0);
  });

  it('non-colliding hits on the same tracks are untouched', () => {
    const res = byDbId(resolveTomInterplay(
      [
        track('hi', 'tom-hi', [note(0, 120), note(1, 90)]),
        track('mid', 'tom-mid', [note(0.5, 100), note(2, 100)]),
        track('low', 'tom-low', [note(3, 100)]),
      ],
      CLIP_LEN,
    ));
    expect(res.get('hi')!.notes).toHaveLength(2);
    expect(res.get('mid')!.notes).toHaveLength(2);
    expect(res.get('low')!.notes).toHaveLength(1);
  });
});

describe('resolveTomInterplay — epsilon window', () => {
  it('0.1 qn apart still collides; a true 32nd pair (0.125) does not', () => {
    const collides = byDbId(resolveTomInterplay(
      [
        track('hi', 'tom-hi', [note(0, 120)]),
        track('mid', 'tom-mid', [note(0.05, 110)]),
        track('low', 'tom-low', [note(TOM_COLLISION_EPSILON_BEATS, 80)]),
      ],
      CLIP_LEN,
    ));
    expect(collides.get('low')!.notes).toHaveLength(0);

    const separate = byDbId(resolveTomInterplay(
      [
        track('hi', 'tom-hi', [note(0, 120)]),
        track('mid', 'tom-mid', [note(0.05, 110)]),
        track('low', 'tom-low', [note(0.125 + 0.05, 80)]),
      ],
      CLIP_LEN,
    ));
    expect(separate.get('low')!.notes).toHaveLength(1);
  });
});

describe('resolveTomInterplay — purity and losslessness', () => {
  const TRACKS = [
    track('hi', 'tom-hi', [note(0, 120), note(1.5, 95)]),
    track('mid', 'tom-mid', [note(0, 100), note(2, 100)]),
    track('low', 'tom-low', [note(0, 80), note(3, 100)]),
  ];

  it('is order-independent: shuffled input produces identical resolutions', () => {
    const forward = byDbId(resolveTomInterplay(TRACKS, CLIP_LEN));
    const reversed = byDbId(resolveTomInterplay([...TRACKS].reverse(), CLIP_LEN));
    for (const dbId of ['hi', 'mid', 'low']) {
      expect(reversed.get(dbId)!.notes).toEqual(forward.get(dbId)!.notes);
      expect(reversed.get(dbId)!.suppressedSourceIndexes).toEqual(forward.get(dbId)!.suppressedSourceIndexes);
    }
  });

  it('never mutates source notes', () => {
    const snapshot = JSON.parse(JSON.stringify(TRACKS));
    resolveTomInterplay(TRACKS, CLIP_LEN);
    expect(TRACKS).toEqual(snapshot);
  });

  it('recompute restores: dropping the suppressing tracks brings the victim back', () => {
    const withAll = byDbId(resolveTomInterplay(TRACKS, CLIP_LEN));
    expect(withAll.get('low')!.suppressedSourceIndexes).toEqual([0]);

    // The low tom's track set no longer includes the louder colliders.
    const lowOnly = byDbId(resolveTomInterplay([TRACKS[2]], CLIP_LEN));
    expect(lowOnly.get('low')!.notes).toHaveLength(2);
    expect(lowOnly.get('low')!.suppressedSourceIndexes).toEqual([]);
  });
});

describe('resolveTomInterplay — durations', () => {
  it('clamps to clip end but never rewrites ring lengths otherwise', () => {
    const res = byDbId(resolveTomInterplay(
      [track('low', 'tom-low', [note(1, 100, 0.6), note(3.9, 100, 0.5)])],
      CLIP_LEN,
    ));
    const [inside, atEdge] = res.get('low')!.notes;
    expect(inside.durationBeats).toBeCloseTo(0.6, 9);
    expect(atEdge.durationBeats).toBeCloseTo(0.1, 9);
  });
});
