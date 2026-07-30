/**
 * Tom-interplay orchestrator — discovers the scene's tom group (tom-hi /
 * tom-mid / tom-low tracks), loads each member's authored SOURCE pattern
 * from scene data (lazily capturing the current clip as the source the
 * first time a pre-feature track is touched), resolves the group with
 * resolveTomInterplay, and rewrites ONLY the clips whose resolved
 * projection changed.
 *
 * Mirrors hat-interplay-apply deliberately (shared by the panel and the
 * agent `generate_drums` skill handler), with ONE structural difference:
 * there is NO kit re-arm on membership change. The hat version re-arms so
 * the host re-derives the sampler's openEnded flag (open hats honor
 * note-off); toms never change openEnded — suppression is the whole
 * effect — so membership changes only update the signature. The signature
 * itself is kept because the panel's reload path uses it to detect
 * membership drift and re-resolve.
 *
 * Persistence:
 *   - `track:<dbId>:tomSource` — the authored pattern {version, notes, updatedAt}
 *   - `tom:groupSig`           — sorted "<dbId>:<tom-role>" membership signature.
 */

import type { PluginHost, PluginMidiNote, PluginTrackHandle } from '@signalsandsorcery/plugin-sdk';
import type { HatClipEnvelope } from './hat-interplay-apply';
import type { TomRole, TomTrackResolution, ResolvedTomNote } from './tom-interplay';
import { normalizeTomRole, resolveTomInterplay } from './tom-interplay';

export const TOM_GROUP_SIG_KEY = 'tom:groupSig';

export function tomSourceKey(dbId: string): string {
  return `track:${dbId}:tomSource`;
}

/** Persisted authored pattern for one tom track. */
export interface TomSourceData {
  version: 1;
  notes: PluginMidiNote[];
  updatedAt: number;
}

/** Same clip-envelope shape the hat pass uses — callers build it once. */
export type TomClipEnvelope = HatClipEnvelope;

export interface TomGroupMember {
  handle: PluginTrackHandle;
  role: TomRole;
  /** Current clip notes (empty when the track has no clip). */
  clipNotes: PluginMidiNote[];
  /** Clip span in seconds, from the engine when a clip exists. */
  clipStartTime: number;
  clipEndTime: number;
  /** The authored pattern (from scene data, or lazily captured). */
  sourceNotes: PluginMidiNote[];
  resolution: TomTrackResolution;
}

export interface TomApplyMemberOutcome {
  trackId: string;
  dbId: string;
  role: TomRole;
  rewritten: boolean;
  suppressedCount: number;
  /** The resolved notes now in the clip (plain, no sourceIndex). */
  notes: PluginMidiNote[];
}

export interface TomApplyOutcome {
  members: TomApplyMemberOutcome[];
}

export function computeTomGroupSig(
  members: ReadonlyArray<{ handle: PluginTrackHandle; role: TomRole }>,
): string {
  return members
    .map((m: { handle: PluginTrackHandle; role: TomRole }) => `${m.handle.dbId}:${m.role}`)
    .sort()
    .join(',');
}

function stripSourceIndex(notes: readonly ResolvedTomNote[]): PluginMidiNote[] {
  return notes.map((n: ResolvedTomNote) => {
    const plain: PluginMidiNote = {
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
    };
    if (n.channel !== undefined) plain.channel = n.channel;
    return plain;
  });
}

const FLOAT_TOLERANCE = 1e-6;

function notesEqual(a: readonly PluginMidiNote[], b: readonly PluginMidiNote[]): boolean {
  if (a.length !== b.length) return false;
  const byPosition = (x: PluginMidiNote, y: PluginMidiNote): number =>
    x.startBeat - y.startBeat || x.pitch - y.pitch || x.velocity - y.velocity;
  const sortedA = [...a].sort(byPosition);
  const sortedB = [...b].sort(byPosition);
  return sortedA.every((noteA: PluginMidiNote, i: number) => {
    const noteB = sortedB[i];
    return (
      noteA.pitch === noteB.pitch &&
      noteA.velocity === noteB.velocity &&
      Math.abs(noteA.startBeat - noteB.startBeat) <= FLOAT_TOLERANCE &&
      Math.abs(noteA.durationBeats - noteB.durationBeats) <= FLOAT_TOLERANCE
    );
  });
}

function isTomSourceData(value: unknown): value is TomSourceData {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TomSourceData).version === 1 &&
    Array.isArray((value as TomSourceData).notes)
  );
}

/**
 * Read the scene's tom group and resolve it WITHOUT writing any clips.
 * Lazily captures + persists missing sources (the only side effect), so a
 * subsequent applyTomInterplay sees the same sources this call resolved.
 */
export async function resolveCurrentTomGroup(
  host: PluginHost,
  sceneId: string,
  envelope: TomClipEnvelope,
): Promise<TomGroupMember[]> {
  const tracks = await host.getPluginTracks();
  const tomHandles = tracks
    .map((handle: PluginTrackHandle) => ({ handle, role: normalizeTomRole(handle.role) }))
    .filter((entry): entry is { handle: PluginTrackHandle; role: TomRole } => entry.role !== null);
  if (tomHandles.length === 0) return [];

  const canReadMidi = typeof host.readMidiNotes === 'function';
  const loaded = await Promise.all(
    tomHandles.map(async ({ handle, role }): Promise<Omit<TomGroupMember, 'resolution'>> => {
      let clipNotes: PluginMidiNote[] = [];
      let clipStartTime = 0;
      let clipEndTime = envelope.endTimeSeconds;
      if (canReadMidi) {
        try {
          const result = await host.readMidiNotes!(handle.id);
          const clip = result.clips[0];
          if (clip) {
            clipNotes = clip.notes;
            clipStartTime = clip.startTime;
            clipEndTime = clip.endTime;
          }
        } catch {
          // No clip / read failure — treat as empty; the resolver handles it.
        }
      }
      let sourceNotes: PluginMidiNote[];
      const stored = await host.getSceneData<TomSourceData>(sceneId, tomSourceKey(handle.dbId));
      if (isTomSourceData(stored)) {
        sourceNotes = stored.notes;
      } else {
        // Lazy migration: a tom track from before this feature — its current
        // clip IS its authored pattern. Capture it once so suppression can
        // never eat into it.
        sourceNotes = clipNotes.map((n: PluginMidiNote) => ({ ...n }));
        const capture: TomSourceData = { version: 1, notes: sourceNotes, updatedAt: Date.now() };
        await host.setSceneData(sceneId, tomSourceKey(handle.dbId), capture);
      }
      return { handle, role, clipNotes, clipStartTime, clipEndTime, sourceNotes };
    }),
  );

  const resolutions = resolveTomInterplay(
    loaded.map((m) => ({
      trackId: m.handle.id,
      dbId: m.handle.dbId,
      role: m.role,
      sourceNotes: m.sourceNotes,
    })),
    envelope.clipLengthBeats,
  );
  const resolutionByDbId = new Map<string, TomTrackResolution>(
    resolutions.map((r: TomTrackResolution) => [r.dbId, r]),
  );
  return loaded.map((m): TomGroupMember => ({ ...m, resolution: resolutionByDbId.get(m.handle.dbId)! }));
}

/**
 * Resolve the scene's tom group and write every member clip whose resolved
 * projection differs from what's currently in the engine. Safe to call on any
 * change; recompute-from-sources means repeated calls never accumulate loss.
 */
export async function applyTomInterplay(
  host: PluginHost,
  sceneId: string,
  envelope: TomClipEnvelope,
): Promise<TomApplyOutcome> {
  const previousSig = await host.getSceneData<string>(sceneId, TOM_GROUP_SIG_KEY);
  const members = await resolveCurrentTomGroup(host, sceneId, envelope);

  if (members.length === 0) {
    if (typeof previousSig === 'string' && previousSig.length > 0) {
      await host.deleteSceneData(sceneId, TOM_GROUP_SIG_KEY);
    }
    return { members: [] };
  }

  const outcomes: TomApplyMemberOutcome[] = [];
  for (const member of members) {
    const desired = stripSourceIndex(member.resolution.notes);
    let rewritten = false;
    if (!notesEqual(desired, member.clipNotes)) {
      if (desired.length === 0) {
        await host.clearMidi(member.handle.id);
      } else {
        await host.writeMidiClip(member.handle.id, {
          startTime: member.clipStartTime,
          endTime: member.clipEndTime > member.clipStartTime ? member.clipEndTime : envelope.endTimeSeconds,
          tempo: envelope.tempo,
          notes: desired,
        });
      }
      rewritten = true;
    }
    outcomes.push({
      trackId: member.handle.id,
      dbId: member.handle.dbId,
      role: member.role,
      rewritten,
      suppressedCount: member.resolution.suppressedSourceIndexes.length,
      notes: desired,
    });
  }

  // Membership change → update the signature only. Unlike hats there is NO
  // kit re-arm: openEnded never changes for toms (no choke, natural ring).
  const newSig = computeTomGroupSig(members);
  if (previousSig !== newSig) {
    await host.setSceneData(sceneId, TOM_GROUP_SIG_KEY, newSig);
  }

  return { members: outcomes };
}
