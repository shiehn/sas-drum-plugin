/**
 * Hat-interplay orchestrator — discovers the scene's hat group, loads each
 * member's authored SOURCE pattern from scene data (lazily capturing the
 * current clip as the source the first time a legacy track is touched),
 * resolves the group with resolveHatInterplay, and rewrites ONLY the clips
 * whose resolved projection changed.
 *
 * Like the other extracted drum modules, this is shared by BOTH generation
 * paths (the panel and the agent `generate_drums` skill handler) so the two
 * can't drift. All I/O goes through the PluginHost surface; the caller
 * supplies the clip envelope so the module stays free of SDK runtime imports.
 *
 * Persistence:
 *   - `track:<dbId>:hatSource`  — the authored pattern {version, notes, updatedAt}
 *   - `hat:groupSig`            — sorted "<dbId>:<articulation>" membership
 *     signature. Written after every apply; when it CHANGES (member added /
 *     removed / re-roled) the member kits are re-armed via
 *     setTrackDrumKit({restore: true}) so the host re-derives the sampler's
 *     openEnded flag from the track's current role. Scenes with no signature
 *     and no hat members are left completely untouched.
 */

import type { PluginHost, PluginMidiNote, PluginTrackHandle } from '@signalsandsorcery/plugin-sdk';
import { fillKey } from './fills/fill-meta';
import type { HatArticulation, HatTrackResolution, ResolvedHatNote } from './hat-interplay';
import { hatArticulationForRole, resolveHatInterplay } from './hat-interplay';

export const HAT_GROUP_SIG_KEY = 'hat:groupSig';

export function hatSourceKey(dbId: string): string {
  return `track:${dbId}:hatSource`;
}

/** Persisted authored pattern for one hat track. */
export interface HatSourceData {
  version: 1;
  notes: PluginMidiNote[];
  updatedAt: number;
}

/** Clip envelope for members that don't have a clip yet (fresh writes). */
export interface HatClipEnvelope {
  /** Clip end in seconds (clips start at 0 for drum tracks). */
  endTimeSeconds: number;
  /** Scene BPM. */
  tempo: number;
  /** Scene loop length in quarter-note beats. */
  clipLengthBeats: number;
}

export interface HatGroupMember {
  handle: PluginTrackHandle;
  articulation: HatArticulation;
  /** Current clip notes (empty when the track has no clip). */
  clipNotes: PluginMidiNote[];
  /** Clip span in seconds, from the engine when a clip exists. */
  clipStartTime: number;
  clipEndTime: number;
  /** The authored pattern (from scene data, or lazily captured). */
  sourceNotes: PluginMidiNote[];
  resolution: HatTrackResolution;
}

export interface HatApplyMemberOutcome {
  trackId: string;
  dbId: string;
  articulation: HatArticulation;
  rewritten: boolean;
  suppressedCount: number;
  /** The resolved notes now in the clip (plain, no sourceIndex). */
  notes: PluginMidiNote[];
}

export interface HatApplyOutcome {
  members: HatApplyMemberOutcome[];
}

export function computeHatGroupSig(
  members: ReadonlyArray<{ handle: PluginTrackHandle; articulation: HatArticulation }>,
): string {
  return members
    .map((m: { handle: PluginTrackHandle; articulation: HatArticulation }) => `${m.handle.dbId}:${m.articulation}`)
    .sort()
    .join(',');
}

function stripSourceIndex(notes: readonly ResolvedHatNote[]): PluginMidiNote[] {
  return notes.map((n: ResolvedHatNote) => {
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

function isHatSourceData(value: unknown): value is HatSourceData {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as HatSourceData).version === 1 &&
    Array.isArray((value as HatSourceData).notes)
  );
}

/**
 * Read the scene's hat group and resolve it WITHOUT writing any clips.
 * Lazily captures + persists missing sources (the only side effect), so a
 * subsequent applyHatInterplay sees the same sources this call resolved.
 */
export async function resolveCurrentGroup(
  host: PluginHost,
  sceneId: string,
  envelope: HatClipEnvelope,
): Promise<HatGroupMember[]> {
  const tracks = await host.getPluginTracks();
  const roleHandles = tracks
    .map((handle: PluginTrackHandle) => ({ handle, articulation: hatArticulationForRole(handle.role) }))
    .filter((entry): entry is { handle: PluginTrackHandle; articulation: HatArticulation } =>
      entry.articulation !== null,
    );
  // FILL tracks borrow hat sounds but are NOT part of the physical hi-hat:
  // they play in the loop tail on their own rotation. Without this filter a
  // hat fill would be swallowed by open/closed suppression (and would
  // suppress groove hits in turn).
  const fillFlags = await Promise.all(
    roleHandles.map(({ handle }) =>
      host.getSceneData(sceneId, fillKey(handle.dbId)).catch(() => null),
    ),
  );
  const hatHandles = roleHandles.filter((_, i) => !fillFlags[i]);
  if (hatHandles.length === 0) return [];

  const canReadMidi = typeof host.readMidiNotes === 'function';
  const loaded = await Promise.all(
    hatHandles.map(async ({ handle, articulation }): Promise<Omit<HatGroupMember, 'resolution'>> => {
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
      const stored = await host.getSceneData<HatSourceData>(sceneId, hatSourceKey(handle.dbId));
      if (isHatSourceData(stored)) {
        sourceNotes = stored.notes;
      } else {
        // Lazy migration: a hat track from before this feature — its current
        // clip IS its authored pattern. Capture it once so suppression can
        // never eat into it.
        sourceNotes = clipNotes.map((n: PluginMidiNote) => ({ ...n }));
        const capture: HatSourceData = { version: 1, notes: sourceNotes, updatedAt: Date.now() };
        await host.setSceneData(sceneId, hatSourceKey(handle.dbId), capture);
      }
      return { handle, articulation, clipNotes, clipStartTime, clipEndTime, sourceNotes };
    }),
  );

  const resolutions = resolveHatInterplay(
    loaded.map((m) => ({
      trackId: m.handle.id,
      dbId: m.handle.dbId,
      articulation: m.articulation,
      sourceNotes: m.sourceNotes,
    })),
    envelope.clipLengthBeats,
  );
  const resolutionByDbId = new Map<string, HatTrackResolution>(
    resolutions.map((r: HatTrackResolution) => [r.dbId, r]),
  );
  return loaded.map((m): HatGroupMember => ({ ...m, resolution: resolutionByDbId.get(m.handle.dbId)! }));
}

/**
 * Resolve the scene's hat group and write every member clip whose resolved
 * projection differs from what's currently in the engine. Safe to call on any
 * change; recompute-from-sources means repeated calls never accumulate loss.
 */
export async function applyHatInterplay(
  host: PluginHost,
  sceneId: string,
  envelope: HatClipEnvelope,
): Promise<HatApplyOutcome> {
  const previousSig = await host.getSceneData<string>(sceneId, HAT_GROUP_SIG_KEY);
  const members = await resolveCurrentGroup(host, sceneId, envelope);

  if (members.length === 0) {
    if (typeof previousSig === 'string' && previousSig.length > 0) {
      await host.deleteSceneData(sceneId, HAT_GROUP_SIG_KEY);
    }
    return { members: [] };
  }

  const outcomes: HatApplyMemberOutcome[] = [];
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
      articulation: member.articulation,
      rewritten,
      suppressedCount: member.resolution.suppressedSourceIndexes.length,
      notes: desired,
    });
  }

  // Membership change (track added / removed / re-roled) → re-arm member kits
  // so the host re-derives the sampler's openEnded flag from the CURRENT role.
  // restore:true keeps this engine-only (no freeze lift, no re-persist).
  const newSig = computeHatGroupSig(members);
  if (previousSig !== newSig) {
    for (const member of members) {
      const samplePath = await host.getSceneData<string>(
        sceneId,
        `track:${member.handle.dbId}:samplePath`,
      );
      if (typeof samplePath === 'string' && samplePath.length > 0) {
        try {
          await host.setTrackDrumKit(member.handle.id, { samplePath, restore: true });
        } catch {
          // Sample missing on disk etc. — interplay still applied; kit
          // re-arm is best-effort.
        }
      }
    }
    await host.setSceneData(sceneId, HAT_GROUP_SIG_KEY, newSig);
  }

  return { members: outcomes };
}
