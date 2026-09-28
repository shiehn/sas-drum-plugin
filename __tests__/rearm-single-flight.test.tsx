/**
 * S-037 (D-025): overlapping drum-kit re-arms must not race the engine.
 *
 * `loadTracks` replays every track's persisted sample through
 * `host.setTrackDrumKit(id, { samplePath, restore: true })`, and loadTracks
 * fires from many triggers that overlap. Fired un-awaited, overlapping reloads
 * re-armed one track 2-3 times within a second; one of those calls met a
 * plugin list that timed out during a project save, and the host added a
 * duplicate Sampler (2026-09-26, yapyap track 2019). The host half (restore =
 * configure-only) is sas-app's fix. This suite pins the panel half:
 *
 *   - the pure coordinator (`src/rearm-single-flight.ts`): one flight per
 *     track, one trailing arm when the path changed, failures clear the entry,
 *     and an engine reload turns a same-path request into the trailing arm;
 *   - the panel wiring: real overlapping `loadTracks` passes (agent-mutation
 *     and engine-ready reloads) against a host whose setTrackDrumKit stays
 *     pending until the test settles it.
 *
 * Panel harness: same recipe as panel-bus-tracks-changed.test.tsx (SDK hooks
 * and components stubbed because the linked SDK resolves its own React copy;
 * Proxy host; module-stable props).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { DrumKit, PluginHost, PluginTrackHandle, PluginUIProps } from '@signalsandsorcery/plugin-sdk';
import { createRearmSingleFlight } from '../src/rearm-single-flight';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// SDK stubs (hoisted above the panel import by jest).
// ---------------------------------------------------------------------------

const mockPanelBus = { supported: false, bus: null, notifyTracksChanged: (): void => {} };
const mockSoundHistory = {
  record: (): void => {},
  undo: async (): Promise<boolean> => false,
  restoreTo: async (): Promise<boolean> => false,
  list: () => ({ entries: [], cursor: -1 }),
  canUndo: (): boolean => false,
  clear: (): void => {},
  reset: (): void => {},
  restore: (): void => {},
  toggleFavorite: (): void => {},
};
const mockReorder = { dragPropsFor: () => ({}), draggingIndex: null, dragOverIndex: null };
const mockTrackLevels = { getLevel: (): null => null, subscribe: () => (): void => {} };

jest.mock('@signalsandsorcery/plugin-sdk', () => {
  const actual = jest.requireActual('@signalsandsorcery/plugin-sdk') as Record<string, unknown>;
  const R = jest.requireActual('react') as typeof import('react');
  const row = (): React.ReactElement => R.createElement('div', { 'data-testid': 'track-row' });
  const nothing = (): null => null;
  return {
    ...actual,
    usePanelBus: () => mockPanelBus,
    useSoundHistory: () => mockSoundHistory,
    useTrackReorder: () => mockReorder,
    useTrackLevels: () => mockTrackLevels,
    useAnySolo: () => false,
    useSceneState: <T,>(_sceneId: string | null, initial: T) => {
      const [value, setValue] = R.useState<T>(initial);
      const setForScene = R.useCallback((_scene: string, next: T | ((prev: T) => T)) => setValue(next), []);
      return [value, setValue, setForScene];
    },
    TrackRow: row,
    PanelMasterStrip: nothing,
    SorceryProgressBar: nothing,
    ImportTrackModal: nothing,
    CrossfadeTrackRow: nothing,
    FadeTrackRow: nothing,
    TransitionDesigner: nothing,
    SamplePackCTACard: nothing,
  };
});

import { DrumGeneratorPanel } from '../DrumGeneratorPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let promise chains settle (outside React). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const KICK_A = '/kit/kick/kick-a.wav';
const KICK_B = '/kit/kick/kick-b.wav';
const KICK_C = '/kit/kick/kick-c.wav';
const SNARE_A = '/kit/snare/snare-a.wav';

// ===========================================================================
// 1. The coordinator
// ===========================================================================

describe('createRearmSingleFlight (pure)', () => {
  /** An arm whose every call waits on a deferred the test settles. */
  function controlledArm(): { arm: jest.Mock<(path: string) => Promise<void>>; calls: Deferred[] } {
    const calls: Deferred[] = [];
    const arm = jest.fn<(path: string) => Promise<void>>(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });
    return { arm, calls };
  }

  it('one flight per track: same-path requests while it runs are coalesced', async () => {
    const rearm = createRearmSingleFlight();
    const { arm, calls } = controlledArm();

    expect(rearm.request('t1', KICK_A, arm)).toBe('started');
    expect(rearm.request('t1', KICK_A, arm)).toBe('coalesced');
    expect(rearm.request('t1', KICK_A, arm)).toBe('coalesced');
    expect(arm).toHaveBeenCalledTimes(1);
    expect(rearm.inFlightPath('t1')).toBe(KICK_A);
    expect(rearm.pendingPath('t1')).toBeNull();

    calls[0].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(1);
    expect(rearm.inFlightPath('t1')).toBeNull();
  });

  it('a changed path waits as ONE trailing arm; the latest request wins', async () => {
    const rearm = createRearmSingleFlight();
    const { arm, calls } = controlledArm();

    rearm.request('t1', KICK_A, arm);
    expect(rearm.request('t1', KICK_B, arm)).toBe('queued');
    expect(rearm.request('t1', KICK_C, arm)).toBe('queued');
    expect(arm).toHaveBeenCalledTimes(1);
    expect(rearm.pendingPath('t1')).toBe(KICK_C);

    calls[0].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(2);
    expect(arm.mock.calls[1][0]).toBe(KICK_C);
    expect(rearm.inFlightPath('t1')).toBe(KICK_C);
    expect(rearm.pendingPath('t1')).toBeNull();

    calls[1].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(2);
    expect(rearm.inFlightPath('t1')).toBeNull();
  });

  it('asking for the in-flight path again cancels the trailing arm', async () => {
    const rearm = createRearmSingleFlight();
    const { arm, calls } = controlledArm();

    rearm.request('t1', KICK_A, arm);
    rearm.request('t1', KICK_B, arm);
    expect(rearm.request('t1', KICK_A, arm)).toBe('coalesced');
    expect(rearm.pendingPath('t1')).toBeNull();

    calls[0].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('a failure reports once, clears the entry, and the next request starts fresh', async () => {
    const onError = jest.fn<(err: unknown, trackId: string, samplePath: string) => void>();
    const rearm = createRearmSingleFlight({ onError });
    const { arm, calls } = controlledArm();
    const failure = new Error('plugin.list timed out');

    rearm.request('t1', KICK_A, arm);
    calls[0].reject(failure);
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, 't1', KICK_A);
    expect(rearm.inFlightPath('t1')).toBeNull();

    expect(rearm.request('t1', KICK_A, arm)).toBe('started');
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('a failed flight still hands over to its trailing arm', async () => {
    const rearm = createRearmSingleFlight({ onError: () => undefined });
    const { arm, calls } = controlledArm();

    rearm.request('t1', KICK_A, arm);
    rearm.request('t1', KICK_B, arm);
    calls[0].reject(new Error('boom'));
    await flush();

    expect(arm).toHaveBeenCalledTimes(2);
    expect(arm.mock.calls[1][0]).toBe(KICK_B);
  });

  it('an arm that throws synchronously is a failure, not a throw out of request', async () => {
    const onError = jest.fn<(err: unknown, trackId: string, samplePath: string) => void>();
    const rearm = createRearmSingleFlight({ onError });
    const thrower = jest.fn<(path: string) => Promise<void>>(() => {
      throw new TypeError('setTrackDrumKit is not a function');
    });

    expect(() => rearm.request('t1', KICK_A, thrower)).not.toThrow();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(rearm.inFlightPath('t1')).toBeNull();
  });

  it('a throwing onError never wedges the track', async () => {
    const rearm = createRearmSingleFlight({
      onError: () => {
        throw new Error('logger down');
      },
    });
    const { arm, calls } = controlledArm();

    rearm.request('t1', KICK_A, arm);
    calls[0].reject(new Error('boom'));
    await flush();

    expect(rearm.inFlightPath('t1')).toBeNull();
    expect(rearm.request('t1', KICK_A, arm)).toBe('started');
  });

  it('tracks are independent', async () => {
    const rearm = createRearmSingleFlight();
    const { arm } = controlledArm();

    expect(rearm.request('t1', KICK_A, arm)).toBe('started');
    expect(rearm.request('t2', SNARE_A, arm)).toBe('started');
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('after invalidate (engine reload) a same-path request becomes the trailing arm, never a concurrent one', async () => {
    const rearm = createRearmSingleFlight();
    const { arm, calls } = controlledArm();

    rearm.request('t1', KICK_A, arm);
    rearm.invalidate();
    expect(rearm.request('t1', KICK_A, arm)).toBe('queued');
    expect(rearm.request('t1', KICK_A, arm)).toBe('queued');
    expect(arm).toHaveBeenCalledTimes(1);

    calls[0].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(2);
    expect(arm.mock.calls[1][0]).toBe(KICK_A);

    // The trailing flight belongs to the new engine load: same-path coalesces again.
    expect(rearm.request('t1', KICK_A, arm)).toBe('coalesced');
    calls[1].resolve();
    await flush();
    expect(arm).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 2. The panel: real overlapping loadTracks passes
// ===========================================================================

function handle(id: string): PluginTrackHandle {
  return { id, name: `drum-${id}`, dbId: `db-${id}` } as PluginTrackHandle;
}

interface ArmCall {
  trackId: string;
  kit: DrumKit;
  d: Deferred;
}

interface Harness {
  host: PluginHost;
  fns: Record<string, jest.Mock<AnyFn>>;
  sceneData: Record<string, unknown>;
  arms: ArmCall[];
  agentMutation: () => void;
  engineReady: () => void;
}

function makeHarness(): Harness {
  const sceneData: Record<string, unknown> = {
    'track:db-t1:samplePath': KICK_A,
    'track:db-t2:samplePath': SNARE_A,
  };
  const arms: ArmCall[] = [];
  let agentListener: (() => void) | null = null;
  let engineListener: (() => void) | null = null;

  const impls: Record<string, AnyFn> = {
    isSamplePackCurrent: async () => true,
    getSamplePackRoot: async () => '/packs/drums',
    getUserSampleRoots: async () => [],
    getSamplePackInfo: async () => null,
    listAudioFiles: async () => [],
    getAvailableInstruments: async () => [],
    adoptSceneTracks: async () => undefined,
    getPluginTracks: async () => [handle('t1'), handle('t2')],
    // A fresh copy per read, like the host's IPC answer.
    getAllSceneData: async () => ({ ...sceneData }),
    getTrackInfo: async (id: string) => ({
      id, name: `drum-${id}`, muted: false, soloed: false, volume: 0.75, pan: 0, hasMidi: true,
    }),
    setTrackDrumKit: (trackId: string, kit: DrumKit) => {
      const d = deferred();
      arms.push({ trackId, kit, d });
      return d.promise;
    },
    onAfterAgentMutation: (listener: () => void) => {
      agentListener = listener;
      return () => undefined;
    },
    onEngineReady: (listener: () => void) => {
      engineListener = listener;
      return () => undefined;
    },
    showToast: () => undefined,
  };
  const fns: Record<string, jest.Mock<AnyFn>> = {};
  for (const [name, impl] of Object.entries(impls)) fns[name] = jest.fn<AnyFn>(impl);

  const host = new Proxy(fns, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON' || prop.startsWith('$$')) {
        return undefined;
      }
      if (!(prop in target)) {
        target[prop] = /^on[A-Z]/.test(prop)
          ? jest.fn<AnyFn>(() => () => undefined)
          : jest.fn<AnyFn>(async () => undefined);
      }
      return target[prop];
    },
  }) as unknown as PluginHost;

  return {
    host,
    fns,
    sceneData,
    arms,
    agentMutation: () => {
      if (!agentListener) throw new Error('panel never subscribed to onAfterAgentMutation');
      agentListener();
    },
    engineReady: () => {
      if (!engineListener) throw new Error('panel never subscribed to onEngineReady');
      engineListener();
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SCENE_CONTEXT = { hasContract: true, sceneType: 'normal' } as unknown as PluginUIProps['sceneContext'];
const onHeaderContent = (): void => {};

let container: HTMLDivElement;
let root: Root;
let warn: jest.SpiedFunction<typeof console.warn>;

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel(host: PluginHost): Promise<void> {
  await act(async () => {
    root.render(
      <DrumGeneratorPanel
        host={host}
        activeSceneId="scene-1"
        isAuthenticated
        isConnected
        onHeaderContent={onHeaderContent}
        sceneContext={SCENE_CONTEXT}
        isExpanded={false}
      />,
    );
  });
  await settle();
}

/** One agent-mutation reload: the panel debounces it by 500 ms, then runs loadTracks(true). */
async function agentReload(h: Harness): Promise<void> {
  await act(async () => {
    h.agentMutation();
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 560));
  });
  await settle();
}

async function engineReload(h: Harness): Promise<void> {
  await act(async () => {
    h.engineReady();
  });
  await settle();
}

function restoreArms(h: Harness, trackId: string): ArmCall[] {
  return h.arms.filter((a) => a.trackId === trackId && a.kit.restore === true);
}

async function settleArm(call: ArmCall, err?: unknown): Promise<void> {
  await act(async () => {
    if (err === undefined) call.d.resolve();
    else call.d.reject(err);
  });
  await settle();
}

beforeEach(() => {
  jest.useRealTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  jest.restoreAllMocks();
});

describe('DrumGeneratorPanel load-time re-arm is single-flight per track (S-037)', () => {
  it('3 rapid loadTracks passes re-arm each track ONCE while the first arm is in flight', async () => {
    const h = makeHarness();
    await renderPanel(h.host); // load 1 (full)
    await agentReload(h); // load 2 (incremental)
    await agentReload(h); // load 3 (incremental)

    expect(h.fns.getPluginTracks).toHaveBeenCalledTimes(3);
    expect(restoreArms(h, 't1')).toHaveLength(1);
    expect(restoreArms(h, 't2')).toHaveLength(1);
    expect(restoreArms(h, 't1')[0].kit).toEqual({ samplePath: KICK_A, restore: true });
    expect(restoreArms(h, 't2')[0].kit).toEqual({ samplePath: SNARE_A, restore: true });

    // Same path throughout, so settling the flights queues nothing more.
    for (const call of [...h.arms]) await settleArm(call);
    expect(h.arms).toHaveLength(2);
  });

  it('a path change while the arm is in flight runs ONE trailing re-arm with the new path', async () => {
    const h = makeHarness();
    await renderPanel(h.host);
    expect(restoreArms(h, 't1')).toHaveLength(1);

    h.sceneData['track:db-t1:samplePath'] = KICK_B;
    await agentReload(h);
    await agentReload(h);
    expect(h.fns.getPluginTracks).toHaveBeenCalledTimes(3);
    expect(restoreArms(h, 't1')).toHaveLength(1); // still waiting on the first arm

    await settleArm(restoreArms(h, 't1')[0]);
    const t1 = restoreArms(h, 't1');
    expect(t1).toHaveLength(2);
    expect(t1[1].kit).toEqual({ samplePath: KICK_B, restore: true });

    await settleArm(t1[1]);
    expect(restoreArms(h, 't1')).toHaveLength(2);
    // The unchanged track never re-armed again.
    expect(restoreArms(h, 't2')).toHaveLength(1);
  });

  it('a failed re-arm is logged and clears the in-flight entry, so the next load re-arms', async () => {
    const h = makeHarness();
    await renderPanel(h.host);
    const failure = new Error('plugin.list timed out');

    await settleArm(restoreArms(h, 't1')[0], failure);
    expect(warn).toHaveBeenCalledWith('[DrumGeneratorPanel] Failed to re-arm sampler on load:', failure);

    await agentReload(h);
    const t1 = restoreArms(h, 't1');
    expect(t1).toHaveLength(2);
    expect(t1[1].kit).toEqual({ samplePath: KICK_A, restore: true });
    // t2's first arm is still in flight: its reload coalesced.
    expect(restoreArms(h, 't2')).toHaveLength(1);
  });

  it('once a flight settles, the next load re-arms again (no stale "armed" cache)', async () => {
    const h = makeHarness();
    await renderPanel(h.host);
    for (const call of [...h.arms]) await settleArm(call);

    await agentReload(h);
    expect(restoreArms(h, 't1')).toHaveLength(2);
    expect(restoreArms(h, 't2')).toHaveLength(2);
  });

  it('an engine reload during a flight re-arms the fresh sampler AFTER the old flight, never alongside it', async () => {
    const h = makeHarness();
    await renderPanel(h.host);
    expect(restoreArms(h, 't1')).toHaveLength(1);

    await engineReload(h);
    await engineReload(h);
    await agentReload(h);
    expect(h.fns.getPluginTracks).toHaveBeenCalledTimes(4);
    expect(restoreArms(h, 't1')).toHaveLength(1); // nothing concurrent

    await settleArm(restoreArms(h, 't1')[0]);
    const t1 = restoreArms(h, 't1');
    expect(t1).toHaveLength(2); // exactly one trailing re-arm
    expect(t1[1].kit).toEqual({ samplePath: KICK_A, restore: true });

    await settleArm(t1[1]);
    expect(restoreArms(h, 't1')).toHaveLength(2);
  });

  it('every load-time re-arm carries restore: true (never a sound edit)', async () => {
    const h = makeHarness();
    await renderPanel(h.host);
    h.sceneData['track:db-t1:samplePath'] = KICK_B;
    await agentReload(h);
    for (const call of [...h.arms]) await settleArm(call);
    for (const call of [...h.arms]) await settleArm(call);

    expect(h.arms.length).toBeGreaterThan(0);
    for (const call of h.arms) expect(call.kit.restore).toBe(true);
  });
});
