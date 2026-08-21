/**
 * Fill sound-follow — when a groove track's sample changes, every fill
 * member borrowing that track's sound re-arms with the new sample. This is
 * what makes fills track the kit: swap the snare and the snare roll follows.
 *
 * Wired into EVERY sound-swap surface (panel shuffle / history restore /
 * import / generate's sample pick, the shuffle_drum_sample skill, and —
 * via the pure helpers in fill-meta — the dsl_set_drum_kit tool). The
 * scene-load re-arm path (`restore: true`) is exempt BY CONSTRUCTION: it
 * replays each track's own persisted sound and never calls this.
 *
 * The follow is an AUDIBLE EDIT: setTrackDrumKit is called without
 * `restore`, so a frozen fill track correctly auto-unfreezes. Failures are
 * per-member and non-fatal — the primary swap must never be blocked by a
 * fill that lost its track.
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { parseFills, dependentsOfSource } from './fill-meta';

/**
 * Re-arm every fill member sourced from `sourceTrackDbId` with
 * `newSamplePath`. Resolves live engine ids via getPluginTracks; a member
 * whose track vanished is skipped. Returns the number of members re-armed.
 */
export async function applyFillSoundFollow(
  host: PluginHost,
  sceneId: string,
  sourceTrackDbId: string,
  newSamplePath: string
): Promise<number> {
  let followed = 0;
  try {
    const sceneData = (await host.getAllSceneData(sceneId)) as Record<string, unknown>;
    const dependents = dependentsOfSource(parseFills(sceneData), sourceTrackDbId);
    if (dependents.length === 0) return 0;

    const handles = await host.getPluginTracks();
    const engineIdByDbId = new Map<string, string>();
    for (const h of handles) engineIdByDbId.set(h.dbId, h.id);

    for (const member of dependents) {
      const engineId = engineIdByDbId.get(member.dbId);
      if (!engineId) continue;
      try {
        await host.setTrackDrumKit(engineId, { samplePath: newSamplePath });
        followed += 1;
      } catch (err) {
        console.warn('[fill-sound-follow] member re-arm failed (non-fatal):', member.dbId, err);
      }
    }
  } catch (err) {
    console.warn('[fill-sound-follow] failed (non-fatal):', err);
  }
  return followed;
}
