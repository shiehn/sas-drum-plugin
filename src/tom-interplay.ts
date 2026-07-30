/**
 * Tom interplay resolver — tom-hi / tom-mid / tom-low behave as ONE
 * drummer's two hands moving around three drums.
 *
 * A real drummer can land at most TWO tom strikes at the same instant (one
 * per hand — a genuine accent unison); three or more simultaneous toms are
 * physically impossible and read as mud. This module enforces exactly that
 * physical limit as a pure, stateless projection over every tom track in
 * the scene — the same lossless source/projection model as hat interplay:
 *
 *   - Each tom track's AUTHORED pattern ("source", persisted in scene data
 *     by the orchestrator) is never mutated — what plays is the RESOLVED
 *     view returned here, recomputed from scratch on every tom-affecting
 *     change. Suppressed hits reappear automatically when the collision
 *     goes away (a tom track deleted, a pattern regenerated, a note moved).
 *   - Suppression: within EPSILON of a note's onset, at most
 *     MAX_SIMULTANEOUS_TOMS notes survive. A note is suppressed iff at
 *     least MAX_SIMULTANEOUS_TOMS strictly higher-ORDERED notes share its
 *     window. The order is total — velocity desc (the accent the LLM marked
 *     loudest is the structural hit), then depth desc (fills resolve
 *     DOWNWARD, so the lower drum is the conventional accent target), then
 *     dbId / sourceIndex for determinism — so resolution is a pure function
 *     of the (unordered) input set. Unlike the rank-based hat rule,
 *     same-depth notes CAN suppress each other: two tom-mid tracks still
 *     share the same two hands.
 *   - Durations are NOT rewritten (toms ring naturally on one-shot
 *     samplers; there is no choke and no openEnded change) — they are only
 *     clamped to the clip end.
 *
 * DELIBERATE DUPLICATION of the hat modules rather than a shared generic
 * resolver: hats just shipped and are ear-verified; consolidating into a
 * generic articulation-group resolver is a post-verification follow-up.
 * Pure function, no I/O — shared by the panel and the agent skill path.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

/** Canonical drum folder roles that participate in the tom group. */
export type TomRole = 'tom-hi' | 'tom-mid' | 'tom-low';

/**
 * Depth = position down the kit. Used as the SECOND ordering key (after
 * velocity) when an over-limit collision must pick survivors.
 */
export const TOM_ROLE_DEPTH: Readonly<Record<TomRole, number>> = {
  'tom-low': 3,
  'tom-mid': 2,
  'tom-hi': 1,
};

/**
 * Two hands: a two-tom unison is a real accent; a third simultaneous tom is
 * physically impossible for one drummer. Exported so taste-tuning (strict
 * single-voice = 1) is a one-line change.
 */
export const MAX_SIMULTANEOUS_TOMS = 2;

/**
 * "Same instant" window in quarter-note beats — same value and rationale as
 * HAT_COLLISION_EPSILON_BEATS: the drum prompt's micro-timing idioms are
 * ≤ 0.083 qn, so 0.1 catches every feel-shifted placement of the same step,
 * while a true 32nd pair (0.125 qn apart) survives as two distinct events.
 */
export const TOM_COLLISION_EPSILON_BEATS = 0.1;

/** Floor for clamped durations, mirroring MidiProcessor.removeOverlaps. */
const MIN_DURATION_BEATS = 0.0625;

/** Map a raw track role (on-disk folder name) to its tom role, if any. */
export function normalizeTomRole(role: string | null | undefined): TomRole | null {
  if (typeof role !== 'string') return null;
  const key = role.trim().toLowerCase();
  return key in TOM_ROLE_DEPTH ? (key as TomRole) : null;
}

/** Depth for a raw track role — null when the role is not a tom. */
export function tomDepthForRole(role: string | null | undefined): number | null {
  const tomRole = normalizeTomRole(role);
  return tomRole === null ? null : TOM_ROLE_DEPTH[tomRole];
}

/** One tom track's authored pattern, as input to the resolver. */
export interface TomTrackSource {
  /** Engine track id (write target for the resolved clip). */
  trackId: string;
  /** Stable DB id (scene-data key id for the persisted source). */
  dbId: string;
  role: TomRole;
  /** Authored notes — never mutated by the resolver. */
  sourceNotes: readonly PluginMidiNote[];
}

/** A resolved note, tagged with the index of the source note it came from. */
export interface ResolvedTomNote extends PluginMidiNote {
  sourceIndex: number;
}

export interface TomTrackResolution {
  trackId: string;
  dbId: string;
  role: TomRole;
  /** The projection to write to the clip, sorted by (startBeat, sourceIndex). */
  notes: ResolvedTomNote[];
  /** Indexes into sourceNotes of hits hidden by an over-limit collision. */
  suppressedSourceIndexes: number[];
}

interface FlatOnset {
  dbId: string;
  sourceIndex: number;
  startBeat: number;
  velocity: number;
  depth: number;
}

/**
 * Strict total order deciding which colliding note survives. True iff `a`
 * outranks `b`: velocity desc → depth desc → dbId asc → sourceIndex asc.
 * Total, so the resolver is deterministic even for identical notes.
 */
function outranks(a: FlatOnset, b: FlatOnset): boolean {
  if (a.velocity !== b.velocity) return a.velocity > b.velocity;
  if (a.depth !== b.depth) return a.depth > b.depth;
  if (a.dbId !== b.dbId) return a.dbId < b.dbId;
  return a.sourceIndex < b.sourceIndex;
}

/**
 * Resolve the tom group. Deterministic and order-independent: the output is
 * a pure function of the (unordered) input set, so callers may recompute at
 * any time without accumulation loss.
 */
export function resolveTomInterplay(
  tracks: readonly TomTrackSource[],
  clipLengthBeats: number,
  epsilon: number = TOM_COLLISION_EPSILON_BEATS,
): TomTrackResolution[] {
  const onsets: FlatOnset[] = [];
  for (const track of tracks) {
    const depth = TOM_ROLE_DEPTH[track.role];
    track.sourceNotes.forEach((note: PluginMidiNote, sourceIndex: number) => {
      onsets.push({
        dbId: track.dbId,
        sourceIndex,
        startBeat: note.startBeat,
        velocity: note.velocity,
        depth,
      });
    });
  }

  /** Suppressed iff the two hands are already taken by higher-ordered notes. */
  const isSuppressed = (onset: FlatOnset): boolean => {
    let higher = 0;
    for (const other of onsets) {
      if (Math.abs(other.startBeat - onset.startBeat) > epsilon) continue;
      if (!outranks(other, onset)) continue;
      higher += 1;
      if (higher >= MAX_SIMULTANEOUS_TOMS) return true;
    }
    return false;
  };

  return tracks.map((track: TomTrackSource): TomTrackResolution => {
    const depth = TOM_ROLE_DEPTH[track.role];
    const notes: ResolvedTomNote[] = [];
    const suppressedSourceIndexes: number[] = [];

    track.sourceNotes.forEach((note: PluginMidiNote, sourceIndex: number) => {
      const onset: FlatOnset = {
        dbId: track.dbId,
        sourceIndex,
        startBeat: note.startBeat,
        velocity: note.velocity,
        depth,
      };
      if (isSuppressed(onset)) {
        suppressedSourceIndexes.push(sourceIndex);
        return;
      }
      let durationBeats = note.durationBeats;
      if (note.startBeat + durationBeats > clipLengthBeats) {
        durationBeats = Math.max(MIN_DURATION_BEATS, clipLengthBeats - note.startBeat);
      }
      notes.push({ ...note, durationBeats, sourceIndex });
    });

    notes.sort(
      (a: ResolvedTomNote, b: ResolvedTomNote) =>
        a.startBeat - b.startBeat || a.sourceIndex - b.sourceIndex,
    );
    return {
      trackId: track.trackId,
      dbId: track.dbId,
      role: track.role,
      notes,
      suppressedSourceIndexes,
    };
  });
}
