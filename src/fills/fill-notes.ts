/**
 * Fill note post-processing — pure helpers keeping generated fill MIDI
 * inside the loop TAIL it belongs to.
 *
 * The fill prompt states the tail placement numerically, but the prompt is
 * best-effort — THIS clamp is authoritative. Placement matters doubly for
 * fills: musically they answer the loop's end, and mechanically the per-loop
 * unit-rotation mute flip lands ~10ms after the downbeat (deckBoundary is a
 * 10ms poll), so a fill note ON beat 1 could get chopped — tail-only notes
 * are settled long before they sound.
 */

export interface FillNoteLike {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}

/** Float slack for LLM-emitted beat positions sitting exactly on the tail edge. */
const EDGE_EPSILON = 1e-3;

/**
 * Keep only notes inside the loop's final `fillBeats` beats and clamp their
 * durations to the loop end. `totalBeats` = bars × quarter-notes-per-bar.
 */
export function clampToTail<T extends FillNoteLike>(
  notes: readonly T[],
  totalBeats: number,
  fillBeats: number
): T[] {
  const tailStart = Math.max(0, totalBeats - fillBeats);
  const out: T[] = [];
  for (const note of notes) {
    if (note.startBeat < tailStart - EDGE_EPSILON) continue;
    if (note.startBeat >= totalBeats - EDGE_EPSILON) continue;
    const maxDuration = totalBeats - note.startBeat;
    out.push(
      note.durationBeats > maxDuration ? { ...note, durationBeats: maxDuration } : note
    );
  }
  return out;
}
