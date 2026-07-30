/**
 * Piano-roll edit merge for hat tracks.
 *
 * The piano roll shows a hat track's RESOLVED notes (the interplay
 * projection), but edits must land on the track's SOURCE (the authored
 * pattern persisted in scene data) so that hits currently suppressed by a
 * higher-rank collision are never lost by an edit that couldn't even see
 * them. This module diffs the edited note list against the resolution the
 * editor was showing and translates it into source mutations:
 *
 *   - kept   (same startBeat)            → copy velocity/duration onto the
 *                                          matching source note (duration
 *                                          write-through is harmless for
 *                                          opens — the resolver recomputes it)
 *   - new    (no resolved note at start) → append to source
 *   - gone   (resolved note unmatched)   → delete its source note
 *
 * Matching keys on exact startBeat (float tolerance): the piano roll returns
 * untouched notes with unchanged startBeats, and pitch is useless as a key
 * (drum notes are all pitch 60). A dragged note therefore degrades to
 * remove+add — semantically lossless here. Suppressed source notes are never
 * in the resolution, so the diff cannot touch them by construction.
 *
 * Pure function, no I/O — shared by the panel and any future host-side edit
 * path, like the other extracted drum modules.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import type { ResolvedHatNote } from './hat-interplay';

/** Float tolerance for "same startBeat". */
const START_MATCH_TOLERANCE = 1e-6;

export interface HatEditMergeResult {
  /** The updated authored pattern, sorted by startBeat. */
  nextSource: PluginMidiNote[];
  added: number;
  removed: number;
  changed: number;
}

function toPlainNote(note: PluginMidiNote): PluginMidiNote {
  const plain: PluginMidiNote = {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  };
  if (note.channel !== undefined) plain.channel = note.channel;
  return plain;
}

export function mergeResolvedEditIntoSource(
  prevResolved: readonly ResolvedHatNote[],
  editedNotes: readonly PluginMidiNote[],
  sourceNotes: readonly PluginMidiNote[],
): HatEditMergeResult {
  const consumed = new Array<boolean>(prevResolved.length).fill(false);
  const updates = new Map<number, PluginMidiNote>();
  const additions: PluginMidiNote[] = [];

  for (const edited of editedNotes) {
    let matchIdx = -1;
    for (let i = 0; i < prevResolved.length; i++) {
      if (consumed[i]) continue;
      if (Math.abs(prevResolved[i].startBeat - edited.startBeat) <= START_MATCH_TOLERANCE) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx >= 0) {
      consumed[matchIdx] = true;
      updates.set(prevResolved[matchIdx].sourceIndex, edited);
    } else {
      additions.push(toPlainNote(edited));
    }
  }

  const removedSourceIndexes = new Set<number>();
  prevResolved.forEach((resolved: ResolvedHatNote, i: number) => {
    if (!consumed[i]) removedSourceIndexes.add(resolved.sourceIndex);
  });

  let changed = 0;
  const nextSource: PluginMidiNote[] = [];
  sourceNotes.forEach((source: PluginMidiNote, sourceIndex: number) => {
    if (removedSourceIndexes.has(sourceIndex)) return;
    const update = updates.get(sourceIndex);
    if (!update) {
      nextSource.push(toPlainNote(source));
      return;
    }
    const next = toPlainNote(source);
    if (
      next.velocity !== update.velocity ||
      Math.abs(next.durationBeats - update.durationBeats) > START_MATCH_TOLERANCE ||
      next.pitch !== update.pitch
    ) {
      changed++;
    }
    next.velocity = update.velocity;
    next.durationBeats = update.durationBeats;
    next.pitch = update.pitch;
    if (update.channel !== undefined) next.channel = update.channel;
    nextSource.push(next);
  });
  nextSource.push(...additions);
  nextSource.sort((a: PluginMidiNote, b: PluginMidiNote) => a.startBeat - b.startBeat);

  return {
    nextSource,
    added: additions.length,
    removed: removedSourceIndexes.size,
    changed,
  };
}
