/**
 * Reuse contract: mergeResolvedEditIntoSource (hat-edit-merge) is
 * articulation-agnostic and works over TOM projections unchanged — it
 * consumes PluginMidiNote & {sourceIndex} and matches on startBeat (all
 * drum pitches are 60). These tests pin that contract so a future
 * hat-motivated change can't silently break the tom piano-roll flow.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { mergeResolvedEditIntoSource } from '../src/hat-edit-merge';
import { resolveTomInterplay } from '../src/tom-interplay';
import type { TomTrackSource } from '../src/tom-interplay';

function note(startBeat: number, velocity = 100, durationBeats = 0.15): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

const CLIP_LEN = 4;

/** A low-tom whose beat-0 hit is suppressed by two louder toms. */
function suppressedLowScenario(): { low: TomTrackSource; colliders: TomTrackSource[] } {
  const low: TomTrackSource = {
    trackId: 'engine-low',
    dbId: 'low',
    role: 'tom-low',
    sourceNotes: [note(0, 80), note(2, 100)],
  };
  const colliders: TomTrackSource[] = [
    { trackId: 'engine-hi', dbId: 'hi', role: 'tom-hi', sourceNotes: [note(0, 120)] },
    { trackId: 'engine-mid', dbId: 'mid', role: 'tom-mid', sourceNotes: [note(0, 110)] },
  ];
  return { low, colliders };
}

describe('mergeResolvedEditIntoSource over tom projections', () => {
  it('a clear-all edit deletes only VISIBLE notes — the suppressed hit survives', () => {
    const { low, colliders } = suppressedLowScenario();
    const resolution = resolveTomInterplay([low, ...colliders], CLIP_LEN)
      .find(r => r.dbId === 'low')!;
    expect(resolution.notes.map(n => n.startBeat)).toEqual([2]); // beat-0 hidden

    const merged = mergeResolvedEditIntoSource(resolution.notes, [], low.sourceNotes);

    expect(merged.nextSource.map(n => n.startBeat)).toEqual([0]); // suppressed note kept
  });

  it('editing a visible note lands on the right source note', () => {
    const { low, colliders } = suppressedLowScenario();
    const resolution = resolveTomInterplay([low, ...colliders], CLIP_LEN)
      .find(r => r.dbId === 'low')!;

    const edited = [{ ...resolution.notes[0], velocity: 45 }];
    const merged = mergeResolvedEditIntoSource(resolution.notes, edited, low.sourceNotes);

    const byStart = new Map(merged.nextSource.map(n => [n.startBeat, n]));
    expect(byStart.get(2)!.velocity).toBe(45);   // the edit landed on beat 2
    expect(byStart.get(0)!.velocity).toBe(80);   // suppressed source untouched
  });

  it('a drawn-in note is appended to the source', () => {
    const { low, colliders } = suppressedLowScenario();
    const resolution = resolveTomInterplay([low, ...colliders], CLIP_LEN)
      .find(r => r.dbId === 'low')!;

    const edited = [...resolution.notes.map(n => ({ ...n })), note(3, 70)];
    const merged = mergeResolvedEditIntoSource(resolution.notes, edited, low.sourceNotes);

    expect(merged.nextSource.map(n => n.startBeat).sort((a, b) => a - b)).toEqual([0, 2, 3]);
  });
});
