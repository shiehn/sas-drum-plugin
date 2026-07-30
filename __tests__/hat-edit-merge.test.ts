/**
 * Edit-merge tests: piano-roll edits (which see only RESOLVED notes) are
 * translated into SOURCE mutations without ever touching suppressed hits.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { mergeResolvedEditIntoSource } from '../src/hat-edit-merge';
import type { ResolvedHatNote } from '../src/hat-interplay';

function note(startBeat: number, durationBeats = 0.15, velocity = 100): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

function resolved(startBeat: number, sourceIndex: number, durationBeats = 0.15, velocity = 100): ResolvedHatNote {
  return { pitch: 60, startBeat, durationBeats, velocity, sourceIndex };
}

describe('mergeResolvedEditIntoSource', () => {
  // Source: closed hits at 0 (SUPPRESSED by an open elsewhere), 1, 2.
  // The editor therefore shows only the hits at 1 and 2.
  const source = [note(0, 0.15, 90), note(1, 0.15, 100), note(2, 0.15, 100)];
  const shown = [resolved(1, 1), resolved(2, 2)];

  it('writes velocity/duration edits through to the matching source note', () => {
    const result = mergeResolvedEditIntoSource(shown, [note(1, 0.3, 55), note(2)], source);
    expect(result.changed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    const edited = result.nextSource.find(n => n.startBeat === 1)!;
    expect(edited.velocity).toBe(55);
    expect(edited.durationBeats).toBeCloseTo(0.3, 6);
  });

  it('appends a drawn note as a new source note', () => {
    const result = mergeResolvedEditIntoSource(shown, [note(1), note(2), note(3.5)], source);
    expect(result.added).toBe(1);
    expect(result.nextSource.map(n => n.startBeat)).toEqual([0, 1, 2, 3.5]);
  });

  it('deletes the source note behind a removed resolved note', () => {
    const result = mergeResolvedEditIntoSource(shown, [note(2)], source);
    expect(result.removed).toBe(1);
    expect(result.nextSource.map(n => n.startBeat)).toEqual([0, 2]);
  });

  it('treats a dragged note as remove+add', () => {
    const result = mergeResolvedEditIntoSource(shown, [note(1.25), note(2)], source);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.nextSource.map(n => n.startBeat)).toEqual([0, 1.25, 2]);
  });

  it('never touches suppressed source notes — even a clear-all keeps them', () => {
    const result = mergeResolvedEditIntoSource(shown, [], source);
    expect(result.removed).toBe(2);
    // The suppressed hit at 0 survives every edit the editor could express.
    expect(result.nextSource.map(n => n.startBeat)).toEqual([0]);
    expect(result.nextSource[0].velocity).toBe(90);
  });

  it('is a no-op when the editor hands back exactly what it was shown', () => {
    const result = mergeResolvedEditIntoSource(shown, [note(1), note(2)], source);
    expect(result.added + result.removed + result.changed).toBe(0);
    expect(result.nextSource.map(n => n.startBeat)).toEqual([0, 1, 2]);
  });
});
