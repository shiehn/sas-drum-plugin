/**
 * S-027 G1 (D-020): a new drum track joins its scene bus at once.
 *
 * The host routes a panel's tracks into the panel's scene bus (and auto-engages
 * a fresh scene's bus) only inside a bus read (`getPanelBusState`). Before SDK
 * 3.19.0 nothing re-read the bus after a create, so a new track sat outside the
 * bus until a scene switch or a reopen. The drum panel is a monolith (it does
 * not go through GeneratorPanelShell, which wires this for panel-core panels),
 * so it must call `usePanelBus().notifyTracksChanged()` itself:
 *
 *   - at the end of every non-stale `loadTracks` (import, crossfade, fade,
 *     fills, duplicate and compose all end in a reload), and
 *   - in `handleAddTrack`, which appends the track locally without a reload.
 *
 * The call is optional (`?.()`): on an app with an older SDK the notifier is
 * absent, and Add Track must not throw into its "Failed to create track" toast.
 *
 * The hook's own coalescing and identity contract are covered by the SDK's
 * suite. This pins the panel's side: when it calls, and how often.
 *
 * The SDK's React hooks and components are stubbed because the linked SDK
 * resolves its own React copy (a hook from it would be an invalid hook call
 * here). Pure helpers come from the real SDK.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { PluginHost, PluginTrackHandle, PluginUIProps } from '@signalsandsorcery/plugin-sdk';

// ---------------------------------------------------------------------------
// SDK stubs. The factory runs when the panel module is first required, so it
// may only reference the `mock*` values lazily (inside functions).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

// Swapped per test: what usePanelBus returns. One object for the whole mount,
// so notifyTracksChanged keeps one identity, like the real hook's callback.
let mockPanelBus: Record<string, unknown> = {};

// Stable across renders: loadTracks lists soundHistory in its deps, so a new
// object per render would re-create loadTracks (and re-load) every render.
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
// Mock host: explicit answers for the load and add paths; any other method is
// a no-op (a subscription hands back an unsubscribe, the rest resolve).
// ---------------------------------------------------------------------------

function handle(id: string): PluginTrackHandle {
  return { id, name: `drum-${id}`, dbId: `db-${id}` } as PluginTrackHandle;
}

type HostFns = Record<string, jest.Mock<AnyFn>>;

function makeHost(overrides: Record<string, AnyFn> = {}): { host: PluginHost; fns: HostFns } {
  const defaults: Record<string, AnyFn> = {
    // Stock pack installed and current, so the normal panel (with Add Track) renders.
    isSamplePackCurrent: async () => true,
    getSamplePackRoot: async () => '/packs/drums',
    getUserSampleRoots: async () => [],
    getSamplePackInfo: async () => null,
    listAudioFiles: async () => [],
    getAvailableInstruments: async () => [],
    // Track load.
    adoptSceneTracks: async () => undefined,
    getPluginTracks: async () => [handle('t1')],
    getAllSceneData: async () => ({}),
    getTrackInfo: async (id: string) => ({
      id, name: `drum-${id}`, muted: false, soloed: false, volume: 0.75, pan: 0, hasMidi: false,
    }),
    // Add Track.
    createTrack: async () => handle('t2'),
    showToast: () => undefined,
  };
  const fns: HostFns = {};
  for (const [name, impl] of Object.entries({ ...defaults, ...overrides })) {
    fns[name] = jest.fn<AnyFn>(impl);
  }
  const host = new Proxy(fns, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON' || prop.startsWith('$$')) {
        return undefined;
      }
      if (!(prop in target)) {
        // Memoised, so a method keeps one identity across renders.
        target[prop] = /^on[A-Z]/.test(prop)
          ? jest.fn<AnyFn>(() => () => undefined)
          : jest.fn<AnyFn>(async () => undefined);
      }
      return target[prop];
    },
  }) as unknown as PluginHost;
  return { host, fns };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Stable props: the panel's header effect lists sceneContext and
// onHeaderContent in its deps, so fresh objects per render would re-fire it.
const SCENE_CONTEXT = { hasContract: true, sceneType: 'normal' } as unknown as PluginUIProps['sceneContext'];

let container: HTMLDivElement;
let headerContainer: HTMLDivElement;
let root: Root;
let headerRoot: Root;
let header: React.ReactNode = null;
const onHeaderContent = (node: React.ReactNode | null): void => { header = node; };

/** Let pending promise chains, and the React commits they cause, settle. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel(host: PluginHost, sceneId = 'scene-1'): Promise<void> {
  await act(async () => {
    root.render(
      <DrumGeneratorPanel
        host={host}
        activeSceneId={sceneId}
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

/** Render the panel's accordion-header content and click "Add Track". */
async function clickAddTrack(): Promise<void> {
  await act(async () => {
    headerRoot.render(<>{header}</>);
  });
  const button = headerContainer.querySelector('[data-testid="add-drum-track-button"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function rowCount(): number {
  return container.querySelectorAll('[data-testid="track-row"]').length;
}

let notify: jest.Mock<() => void>;

beforeEach(() => {
  jest.useRealTimers();
  header = null;
  notify = jest.fn<() => void>();
  mockPanelBus = { supported: false, bus: null, notifyTracksChanged: notify };
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  headerContainer = document.createElement('div');
  document.body.append(container, headerContainer);
  root = createRoot(container);
  headerRoot = createRoot(headerContainer);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    headerRoot.unmount();
  });
  container.remove();
  headerContainer.remove();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('DrumGeneratorPanel asks the panel bus to re-read when its tracks change (S-027 G1)', () => {
  it('a completed loadTracks pass notifies exactly once, after the track set is known', async () => {
    const { host, fns } = makeHost();
    await renderPanel(host);

    expect(rowCount()).toBe(1);
    expect(fns.getPluginTracks).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.invocationCallOrder[0]).toBeGreaterThan(fns.getAllSceneData.mock.invocationCallOrder[0]);
  });

  it('listing the stable notifier in the deps does not re-run loadTracks', async () => {
    const { host, fns } = makeHost();
    await renderPanel(host);
    await renderPanel(host); // same props again

    expect(fns.getPluginTracks).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a load superseded by a scene switch does not notify; the live one does', async () => {
    let releaseScene1: (data: Record<string, unknown>) => void = () => undefined;
    const { host, fns } = makeHost({
      getAllSceneData: (sceneId: string) =>
        sceneId === 'scene-1'
          ? new Promise<Record<string, unknown>>((resolve) => { releaseScene1 = resolve; })
          : Promise.resolve({}),
    });
    await renderPanel(host, 'scene-1');
    expect(fns.getAllSceneData).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    await renderPanel(host, 'scene-2');
    expect(rowCount()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);

    // The stale scene-1 load finishes late: it must not ask again.
    await act(async () => { releaseScene1({}); });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('Add Track notifies on its own once the track exists, without a reload', async () => {
    const { host, fns } = makeHost();
    await renderPanel(host);
    notify.mockClear();

    await clickAddTrack();

    expect(fns.createTrack).toHaveBeenCalledTimes(1);
    expect(rowCount()).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.invocationCallOrder[0]).toBeGreaterThan(fns.createTrack.mock.invocationCallOrder[0]);
    // Add Track appends the row locally: the notify is its own, not a reload's.
    expect(fns.getPluginTracks).toHaveBeenCalledTimes(1);
    expect(fns.showToast).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });

  it('a failed Add Track does not notify', async () => {
    const { host, fns } = makeHost({
      createTrack: async () => { throw new Error('TRACK_LIMIT_EXCEEDED'); },
    });
    await renderPanel(host);
    notify.mockClear();

    await clickAddTrack();

    expect(fns.showToast).toHaveBeenCalledWith('error', 'Failed to create track', 'TRACK_LIMIT_EXCEEDED');
    expect(notify).not.toHaveBeenCalled();
    expect(rowCount()).toBe(1);
  });

  it('degrades to a no-op on an SDK without notifyTracksChanged', async () => {
    mockPanelBus = { supported: false, bus: null };
    const { host, fns } = makeHost();
    await renderPanel(host);
    expect(rowCount()).toBe(1);

    await clickAddTrack();

    expect(fns.createTrack).toHaveBeenCalledTimes(1);
    expect(rowCount()).toBe(2);
    expect(fns.showToast).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });
});
