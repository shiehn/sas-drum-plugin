/**
 * Single-flight sampler re-arm: at most one arm in flight per track (S-037).
 *
 * The panel replays each track's persisted sample through
 * `host.setTrackDrumKit(id, { samplePath, restore: true })` on EVERY
 * `loadTracks`, and loadTracks fires from many triggers that overlap (scene
 * load, engine-ready, agent mutations, bulk-add completions, imports). Fired
 * un-awaited, overlapping reloads re-armed the same track two or three times
 * within a second. On 2026-09-26 one of them met an engine plugin list that
 * timed out while the project was saving; the host read the failed list as
 * "no Sampler" and added a second one (yapyap track 2019).
 *
 * The coordinator keeps ONE arm in flight per track id:
 *   - a request for the path already in flight is dropped, because that
 *     flight covers it;
 *   - a request for a different path waits as the ONE trailing arm. A newer
 *     request replaces it (the latest wins), and asking for the in-flight
 *     path again cancels it;
 *   - when a flight settles, whether it succeeded or failed, its entry is
 *     cleared and the trailing arm (if any) starts. A failure never wedges a
 *     track: the next request starts a fresh flight.
 *
 * `invalidate()` marks the flights in progress as belonging to the previous
 * engine load. The host fires onEngineReady on every `projectLoaded` (a
 * same-project reopen included). A load recreates the samplers and can
 * reassign engine ids, so a flight that started before it may have armed a
 * sampler that no longer exists. After `invalidate()` a same-path request is
 * no longer dropped: it becomes the trailing arm, so the fresh sampler gets
 * armed. It still runs after the old flight settles, never alongside it.
 *
 * There is deliberately no "already armed" cache. The panel has no cheap read
 * of what the engine's sampler holds (that read is the plugin list that timed
 * out), and a remembered success goes stale exactly when a re-arm matters
 * (reopen, engine restart). Serializing the calls is what stops the race.
 */

/** Performs one arm. The coordinator owns failures, so it may reject. */
export type RearmArm = (samplePath: string) => Promise<unknown>;

/**
 * What `request` did: started a flight, folded into the flight already
 * running, or queued as that track's trailing arm.
 */
export type RearmDecision = 'started' | 'coalesced' | 'queued';

export interface RearmSingleFlightOptions {
  /** Called when an arm rejects (or throws). The track's entry is cleared either way. */
  onError?: (err: unknown, trackId: string, samplePath: string) => void;
}

export interface RearmSingleFlight {
  /** Ask for `trackId` to be armed with `samplePath`. Never blocks and never throws. */
  request(trackId: string, samplePath: string, arm: RearmArm): RearmDecision;
  /** The engine reloaded: the flights in progress no longer cover a same-path request. */
  invalidate(): void;
  /** The path currently in flight for `trackId`, or null when idle. */
  inFlightPath(trackId: string): string | null;
  /** The trailing path waiting behind the flight for `trackId`, or null. */
  pendingPath(trackId: string): string | null;
}

interface ArmRequest {
  samplePath: string;
  arm: RearmArm;
}

interface Flight {
  samplePath: string;
  /** The engine load this flight was started under (see `invalidate`). */
  epoch: number;
  pending: ArmRequest | null;
}

export function createRearmSingleFlight(options: RearmSingleFlightOptions = {}): RearmSingleFlight {
  const flights = new Map<string, Flight>();
  let epoch = 0;

  const start = (trackId: string, next: ArmRequest): void => {
    const flight: Flight = { samplePath: next.samplePath, epoch, pending: null };
    flights.set(trackId, flight);

    let run: Promise<unknown>;
    try {
      run = Promise.resolve(next.arm(next.samplePath));
    } catch (err: unknown) {
      run = Promise.reject(err);
    }

    const settle = (): void => {
      if (flights.get(trackId) === flight) flights.delete(trackId);
      if (flight.pending) start(trackId, flight.pending);
    };
    run.then(settle, (err: unknown) => {
      try {
        options.onError?.(err, trackId, next.samplePath);
      } catch {
        // A logging failure must never wedge the track's entry.
      }
      settle();
    });
  };

  return {
    request(trackId, samplePath, arm) {
      const flight = flights.get(trackId);
      if (!flight) {
        start(trackId, { samplePath, arm });
        return 'started';
      }
      if (flight.samplePath === samplePath && flight.epoch === epoch) {
        // The flight already covers the latest wish, so an earlier trailing
        // request for another path is obsolete.
        flight.pending = null;
        return 'coalesced';
      }
      flight.pending = { samplePath, arm };
      return 'queued';
    },
    invalidate() {
      epoch += 1;
    },
    inFlightPath(trackId) {
      return flights.get(trackId)?.samplePath ?? null;
    },
    pendingPath(trackId) {
      return flights.get(trackId)?.pending?.samplePath ?? null;
    },
  };
}
