/**
 * Hi-hat interplay resolver — open/closed hats behave as ONE physical
 * instrument.
 *
 * Real hats can't sound both articulations at once: an open hat REPLACES the
 * closed hit on its step, and the next hat hit (the pedal closing, a re-strike)
 * CHOKES the open ring. This module computes that behaviour as a pure,
 * stateless projection over every hat track in the scene:
 *
 *   - Each hat track's AUTHORED pattern ("source", persisted in scene data by
 *     the orchestrator) is never mutated — what plays is the RESOLVED view
 *     returned here, recomputed from scratch on every hat-affecting change.
 *     Suppressed hits therefore reappear automatically when the collision
 *     goes away (open pattern regenerated, open track deleted, note moved).
 *   - Suppression: a note is suppressed iff a strictly higher-RANK note
 *     (open > closed; a future half-open slots between) exists anywhere in
 *     the group within EPSILON of its onset. Same-rank notes never suppress
 *     each other — two closed-hat tracks may layer, consecutive opens
 *     re-strike.
 *   - Tail: each surviving open note's duration is COMPUTED — it rings until
 *     the next surviving hat onset (any articulation, any track), else to the
 *     clip end. Authored open durations are ignored; the sampler honors
 *     note-off for open-hat tracks (openEnded=false), which makes the choke
 *     audible.
 *
 * Extracted like drum-system-prompt/kit-resolver/parse-llm-response so the
 * SAME rules back both generation paths (panel + agent skill). Pure function,
 * no I/O — safe to import into either process.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

/** Articulations with interplay semantics. 'half' reserved for a future hat-half role. */
export type HatArticulation = 'open' | 'closed';

/** Canonical drum folder roles that participate in the hat group. */
export const HAT_ROLE_ARTICULATION: Readonly<Record<string, HatArticulation>> = {
  'hat-open': 'open',
  'hat-closed': 'closed',
};

/**
 * Higher rank suppresses lower within EPSILON. A future half-open articulation
 * ranks between closed and open (open=3, half=2, closed=1) with no rule change.
 */
export const HAT_ARTICULATION_RANK: Readonly<Record<HatArticulation, number>> = {
  open: 2,
  closed: 1,
};

/** Articulations whose ring length is computed (note-off choked by the sampler). */
const RINGING_ARTICULATIONS: ReadonlySet<HatArticulation> = new Set(['open']);

/**
 * "Same step" window in quarter-note beats. The drum prompt's own micro-timing
 * idioms are ≤ 0.083 qn (triplet push / pre-hit), so 0.1 catches every
 * feel-shifted placement of the same step, while a true 32nd pair (0.125qn
 * apart) survives as two distinct events — the later one chokes instead.
 */
export const HAT_COLLISION_EPSILON_BEATS = 0.1;

/** Floor for computed durations, mirroring MidiProcessor.removeOverlaps. */
const MIN_DURATION_BEATS = 0.0625;

/** Map a raw track role (on-disk folder name) to its hat articulation, if any. */
export function hatArticulationForRole(role: string | null | undefined): HatArticulation | null {
  if (typeof role !== 'string') return null;
  return HAT_ROLE_ARTICULATION[role.trim().toLowerCase()] ?? null;
}

/** One hat track's authored pattern, as input to the resolver. */
export interface HatTrackSource {
  /** Engine track id (write target for the resolved clip). */
  trackId: string;
  /** Stable DB id (scene-data key id for the persisted source). */
  dbId: string;
  articulation: HatArticulation;
  /** Authored notes — never mutated by the resolver. */
  sourceNotes: readonly PluginMidiNote[];
}

/** A resolved note, tagged with the index of the source note it came from. */
export interface ResolvedHatNote extends PluginMidiNote {
  sourceIndex: number;
}

export interface HatTrackResolution {
  trackId: string;
  dbId: string;
  articulation: HatArticulation;
  /** The projection to write to the clip, sorted by (startBeat, sourceIndex). */
  notes: ResolvedHatNote[];
  /** Indexes into sourceNotes of hits hidden by a higher-rank collision. */
  suppressedSourceIndexes: number[];
}

interface FlatOnset {
  track: HatTrackSource;
  sourceIndex: number;
  startBeat: number;
  rank: number;
}

/**
 * Resolve the hat group. Deterministic and order-independent: the output is
 * a pure function of the (unordered) input set, so callers may recompute at
 * any time without accumulation loss.
 */
export function resolveHatInterplay(
  tracks: readonly HatTrackSource[],
  clipLengthBeats: number,
  epsilon: number = HAT_COLLISION_EPSILON_BEATS,
): HatTrackResolution[] {
  const onsets: FlatOnset[] = [];
  for (const track of tracks) {
    const rank = HAT_ARTICULATION_RANK[track.articulation];
    track.sourceNotes.forEach((note: PluginMidiNote, sourceIndex: number) => {
      onsets.push({ track, sourceIndex, startBeat: note.startBeat, rank });
    });
  }

  const isSuppressed = (onset: FlatOnset): boolean =>
    onsets.some(
      (other: FlatOnset) =>
        other.rank > onset.rank && Math.abs(other.startBeat - onset.startBeat) <= epsilon,
    );

  const surviving = onsets.filter((onset: FlatOnset) => !isSuppressed(onset));
  const survivingStarts = surviving
    .map((onset: FlatOnset) => onset.startBeat)
    .sort((a: number, b: number) => a - b);

  /** Earliest surviving hat onset strictly after start+epsilon, else null. */
  const nextOnsetAfter = (startBeat: number): number | null => {
    for (const candidate of survivingStarts) {
      if (candidate > startBeat + epsilon) return candidate;
    }
    return null;
  };

  return tracks.map((track: HatTrackSource): HatTrackResolution => {
    const notes: ResolvedHatNote[] = [];
    const suppressedSourceIndexes: number[] = [];
    const rank = HAT_ARTICULATION_RANK[track.articulation];
    const rings = RINGING_ARTICULATIONS.has(track.articulation);

    track.sourceNotes.forEach((note: PluginMidiNote, sourceIndex: number) => {
      if (isSuppressed({ track, sourceIndex, startBeat: note.startBeat, rank })) {
        suppressedSourceIndexes.push(sourceIndex);
        return;
      }
      let durationBeats = note.durationBeats;
      if (rings) {
        const next = nextOnsetAfter(note.startBeat);
        const ringEnd = next ?? clipLengthBeats;
        durationBeats = Math.max(MIN_DURATION_BEATS, ringEnd - note.startBeat);
      } else if (note.startBeat + durationBeats > clipLengthBeats) {
        durationBeats = Math.max(MIN_DURATION_BEATS, clipLengthBeats - note.startBeat);
      }
      notes.push({ ...note, durationBeats, sourceIndex });
    });

    notes.sort(
      (a: ResolvedHatNote, b: ResolvedHatNote) =>
        a.startBeat - b.startBeat || a.sourceIndex - b.sourceIndex,
    );
    return { trackId: track.trackId, dbId: track.dbId, articulation: track.articulation, notes, suppressedSourceIndexes };
  });
}
