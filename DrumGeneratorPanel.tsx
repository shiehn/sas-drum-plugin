/**
 * DrumGeneratorPanel — UI for the @signalsandsorcery/drum-generator plugin.
 *
 * Mirrors SynthGeneratorPanel chrome (TrackRow, shuffle, FX drawer, instrument
 * drawer) but generates drum-pattern MIDI and loads the engine's built-in
 * drum sampler (sas.drum-sampler) with a sample picked from the configured
 * sample library. MIDI pitch is advisory only — the sampler triggers the
 * loaded sample on every note-on.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  PluginUIProps,
  PluginTrackHandle,
  PluginTrackRuntimeState,
  PluginTrackFxDetailState,
  PluginFxCategoryDetailState,
  MidiClipData,
  PluginMidiNote,
  BulkAddPlaceholderTrack,
  InstrumentDescriptor,
  FxCategory,
  TrackFxDetailState,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, type DrawerTab, useSceneState, useAnySolo, useSoundHistory, useTrackReorder, type TrackRowDragProps, type TrackSoundHistory, SorceryProgressBar, EMPTY_FX_DETAIL_STATE, formatConcurrentTracks, ImportTrackModal, useTrackLevels, CrossfadeTrackRow, TransitionDesigner, EQUAL_POWER_GAIN, parseCrossfadePairs, asCrossfadeMeta, soundIdentity, buildCrossfadeInpaintPrompt, buildCrossfadeVolumeCurves, type CrossfadeSlot, type CrossfadeSelection, type CrossfadeMeta, type CrossfadePairMeta, FadeTrackRow, parseFades, asFadeMeta, buildFadeVolumeCurve, type FadeDirection, type FadeGesture, type FadeMeta, type FadeEntry, type FadeSelection } from '@signalsandsorcery/plugin-sdk';
import { buildDrumSystemPrompt } from './src/drum-system-prompt';
// Phase 0.8: role taxonomy is FS-discovered via kitResolver.getDiscoveredRoles()
// — the previous hardcoded role-mapping.ts has been retired (kept only as a
// tombstone module). The drum panel fetches the live role list at mount and
// passes it to buildDrumSystemPrompt so the LLM is constrained to whatever
// folders actually exist under the library root.
import { createKitResolver } from './src/kit-resolver';
import { parseLLMDrumResponse } from './src/parse-llm-response';
import { SamplePackCTACard, type SamplePackCardInfo } from '@signalsandsorcery/plugin-sdk';

type PackStatus = 'checking' | 'missing' | 'stale' | 'current';

// This plugin's sample-pack display identity. The HOST owns the volatile
// registry (exact size / sha256 / download URL / expected version) keyed by
// packId — reached via host.isSamplePackCurrent / getSamplePackRoot /
// getSamplePackInstalledVersion / startSamplePackDownload. The plugin only
// declares its own packId + the copy shown on the download CTA, so it no
// longer imports the app's shared/constants/sample-packs (W9 — no back doors).
//
// The description/sizeBytes below are a STATIC FALLBACK only — at runtime the
// panel pulls the live copy from host.getSamplePackInfo (SDK 2.12+) so the CTA
// matches whatever bundle the host actually ships. Kept current for hosts that
// predate getSamplePackInfo.
const DRUM_PACK: SamplePackCardInfo = {
  packId: 'sas-drum-pack',
  displayName: 'Drum Sample Library',
  description: '24 roles — kicks, snares, hats, 808s, toms, cymbals, percussion & FX one-shots',
  sizeBytes: 1_386_775_319,
};

const MAX_TRACKS = 16;
const ESTIMATED_GENERATION_MS = 15000;
const EMPTY_PLACEHOLDERS: BulkAddPlaceholderTrack[] = [];
const DRUM_ACCENT_COLOR = '#FB923C';

interface DrumTrackState {
  handle: PluginTrackHandle;
  prompt: string;
  role: string;
  // Phase 0.8: subRole removed — folder name IS the role now (flat taxonomy).
  // The track.role field carries the full folder name (e.g. "kick", "hat-closed").
  samplePath: string | null;
  /**
   * Per-track shuffle history. Set of sample paths the shuffle button
   * has already handed back since the track was created OR since the
   * history was last reset (which happens automatically when the role's
   * pool is exhausted, so the cycle wraps and starts over). Generate
   * also seeds the history with its initial random pick so the next
   * shuffle gives a different sample.
   */
  shuffleHistory: Set<string>;
  runtimeState: PluginTrackRuntimeState;
  fxDetailState: TrackFxDetailState;
  // Unified drawer state (replaces fxDrawerOpen + instrumentDrawerOpen + instrumentDrawerStage).
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  editorStage: boolean;
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  // Piano-roll edit state. `editNotes` is the live, editable copy of the
  // track's MIDI (loaded lazily when the Edit tab is first opened, or seeded
  // from a fresh generation). `editBars`/`editBpm` size the grid + the save
  // span. Drum MIDI is flattened to pitch 60, so the roll's pitch axis is
  // cosmetic here. See loadEditNotes / handleNotesChange.
  editNotes: PluginMidiNote[];
  editBars: number;
  editBpm: number;
  instrumentPluginId: string | null;
  instrumentName: string | null;
  instrumentMissing: boolean;
}

// Crossfade tracks (transition scenes): shared metadata + parsing live in the
// SDK (crossfade-meta.ts); only the live-track-bound resolved pair is panel-local.
/** A crossfade pair resolved against live track state (both members present). */
interface ResolvedCrossfadePair extends CrossfadePairMeta {
  origin: DrumTrackState;
  target: DrumTrackState;
}

/** A fade (transition orphan) resolved against live track state. */
interface ResolvedFade extends FadeEntry {
  track: DrumTrackState;
}

export function DrumGeneratorPanel({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
  onHeaderContent,
  onLoading,
  sceneContext,
  onSelectScene,
  onOpenContract,
  onExpandSelf,
  isExpanded,
}: PluginUIProps): React.ReactElement {
  // Cosmetic per-track peak meters. Poll ONLY while this panel is expanded
  // (`isExpanded`): collapsed panels stay mounted, so without this gate every
  // hidden panel keeps polling at ~30Hz — and the accordion only ever expands
  // one. NOT gated on transport state (this app plays via decks/clip-launcher,
  // so the linear "is playing" flag is unreliable). Stopped tracks just read the
  // floor. The host coalesces the read so playback always wins over the GUI.
  // Older hosts (no getTrackLevels) degrade to no meter via `supportsMeters`.
  const supportsMeters = typeof host.getTrackLevels === 'function';
  const trackLevels = useTrackLevels(host, isExpanded);

  const [tracks, setTracks] = useState<DrumTrackState[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [soundImportTarget, setSoundImportTarget] = useState<DrumTrackState | null>(null);
  // Transition Designer (transition scenes): the single board replacing the
  // per-pair "+ Crossfade"/"+ Fade" modals, plus parsed pair metadata for the
  // active scene (members are normal tracks linked via scene-data).
  const [designerView, setDesignerView] = useState(false);
  // Total source tracks across both bridged scenes — the denominator for the
  // toggle button's "N/M transitioned" progress.
  const [transitionSourceTotal, setTransitionSourceTotal] = useState(0);
  const [crossfadePairsMeta, setCrossfadePairsMeta] = useState<CrossfadePairMeta[]>([]);
  const [isCreatingCrossfade, setIsCreatingCrossfade] = useState(false);
  // A fade is a crossfade with one empty endpoint — a lone track that fades in
  // (target-only) or out (origin-only).
  const [fadesMeta, setFadesMeta] = useState<FadeEntry[]>([]);
  const [isCreatingFade, setIsCreatingFade] = useState(false);
  // Engine track ids whose fade volume curve was applied this session (keyed by
  // engine id so reopen → new ids re-applies; curve isn't engine-persisted).
  const appliedFadeAutomationRef = useRef<Set<string>>(new Set());
  const [isComposing, , setIsComposingForScene] = useSceneState(activeSceneId, false);
  const [placeholders, , setPlaceholdersForScene] = useSceneState<BulkAddPlaceholderTrack[]>(activeSceneId, EMPTY_PLACEHOLDERS);
  const saveTimeoutRefs = useRef<Record<string, NodeJS.Timeout>>({});
  // Tracks whose Edit-tab MIDI has been fetched (or seeded by a generation),
  // so re-opening the tab doesn't re-fetch and clobber unsaved edits. A ref,
  // not state — toggling it must never trigger a re-render.
  const editLoadStartedRef = useRef<Set<string>>(new Set());
  const [availableInstruments, setAvailableInstruments] = useState<InstrumentDescriptor[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(false);
  const engineToDbIdRef = useRef<Map<string, string>>(new Map());
  // Phase 1.1 (sample pack distribution): the resolver is fed the live
  // sample-pack root. When the pack is missing or stale, getSamplePackRoot
  // returns null and we render the CTA card instead of the normal panel.
  //
  // Local-samples spike: the resolver scans the distributed pack root AND
  // every user-imported drum pack root (`<userData>/user-samples/drums/*`),
  // merging their role pools so generate/shuffle draw from the union.
  // Distributed first, user roots after. getUserSampleRoots is optional
  // (older host) → feature-checked, absence treated as no user packs.
  const [kitResolver] = useState(() =>
    createKitResolver(host, async () => {
      const distributed = await host.getSamplePackRoot(DRUM_PACK.packId).catch(() => null);
      const userRoots = (await host.getUserSampleRoots?.('drums')?.catch(() => [])) ?? [];
      return [distributed, ...userRoots].filter(
        (r): r is string => typeof r === 'string' && r.length > 0,
      );
    }),
  );

  // --- Sound history (↩ back-arrow + drawer "History" tab) --------------
  // A drum "sound" is its sample path. Re-applying loads it into the sampler
  // and re-persists it so a scene reopen keeps the restored sound.
  const applyDrumSound = useCallback(
    async (trackId: string, descriptor: unknown): Promise<void> => {
      const samplePath = descriptor as string;
      await host.setTrackDrumKit(trackId, { samplePath });
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      if (activeSceneId) {
        host.setSceneData(activeSceneId, `track:${dbId}:samplePath`, samplePath).catch(() => {});
      }
      setTracks((prev) => prev.map((t) => (t.handle.id === trackId ? { ...t, samplePath } : t)));
    },
    [host, activeSceneId],
  );
  // Persist the per-track history to project scene-data so it survives reopen.
  const persistSoundHistory = useCallback(
    (trackId: string, state: TrackSoundHistory): void => {
      if (!activeSceneId) return;
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      host.setSceneData(activeSceneId, `track:${dbId}:soundHistory`, state).catch(() => {});
    },
    [host, activeSceneId],
  );
  const soundHistory = useSoundHistory(applyDrumSound, { onChange: persistSoundHistory });
  // Cross-panel: dim non-soloed rows when ANY track (any panel) is soloed.
  const anySolo = useAnySolo(host);

  // Drag-to-reorder rows (shared SDK hook; persists per-scene by stable dbId).
  const reorder = useTrackReorder<DrumTrackState>({
    host,
    items: tracks,
    setItems: setTracks,
    getId: (t) => t.handle.dbId,
  });

  // Import just the SAMPLE from a track in another scene (drawer "Import
  // Sample"), bypassing the contract gate. The picker hands back the source
  // track; we read its sound via host.getTrackSound, then apply + record it so
  // it's undoable and persisted like a shuffle.
  const handleSoundImportPick = useCallback(
    async (sel: { sourceTrackDbId: string; trackName: string; sceneName: string }): Promise<void> => {
      const target = soundImportTarget;
      if (!target || !host.getTrackSound) { setSoundImportTarget(null); return; }
      try {
        const snap = await host.getTrackSound(sel.sourceTrackDbId);
        if (!snap || snap.kind !== 'sample') {
          host.showToast('error', 'No sample to import', `${sel.trackName} has no sample sound.`);
          return;
        }
        await applyDrumSound(target.handle.id, snap.samplePath);
        soundHistory.record(target.handle.id, snap.samplePath, snap.label);
        host.showToast('success', 'Sample imported', `${snap.label} → ${target.handle.name}`);
      } catch (err: unknown) {
        host.showToast('error', 'Import failed', err instanceof Error ? err.message : String(err));
      } finally {
        setSoundImportTarget(null);
      }
    },
    [soundImportTarget, host, applyDrumSound, soundHistory],
  );

  // Pack-status drives the empty-state vs normal-state branch. Re-evaluated
  // on mount and after every download completes. While 'checking', the panel
  // shows a brief loading placeholder; thereafter it's either CTA or normal UI.
  const [packStatus, setPackStatus] = useState<PackStatus>('checking');
  // Local-samples: number of user-imported drum packs. When > 0 the panel is
  // fully usable even if the stock pack is missing/stale — the resolver scans
  // the user roots too. Loaded on mount + refreshed on every `user:drums`
  // library broadcast.
  const [userPackCount, setUserPackCount] = useState(0);
  // Live CTA copy (size/description). Seeded with the static fallback, then
  // overwritten by the host registry so it tracks the shipped bundle.
  const [packInfo, setPackInfo] = useState<SamplePackCardInfo>(DRUM_PACK);
  const refreshPackStatus = useCallback(async (): Promise<void> => {
    const isCurrent = await host.isSamplePackCurrent(DRUM_PACK.packId).catch(() => false);
    if (isCurrent) {
      setPackStatus('current');
      kitResolver.reset();
      return;
    }
    const installed = await host
      .getSamplePackInstalledVersion(DRUM_PACK.packId)
      .catch(() => null);
    setPackStatus(installed === null ? 'missing' : 'stale');
  }, [host, kitResolver]);
  useEffect(() => {
    void refreshPackStatus();
    // Pull the canonical size/description from the host registry (SDK 2.12+);
    // optional-chained so older hosts simply keep the static fallback.
    void host.getSamplePackInfo?.(DRUM_PACK.packId)?.then(
      (info) => { if (info) setPackInfo(info); },
      () => {},
    );
    const unsub = host.onSamplePackProgress(DRUM_PACK.packId, (p) => {
      if (p.status === 'complete') void refreshPackStatus();
    });
    return unsub;
  }, [refreshPackStatus, host]);

  // Local-samples: track the user-imported drum pack count and re-arm the
  // resolver whenever the user library changes. The import wizard broadcasts on
  // the same `pack:progress` channel with packId `user:drums`, so we subscribe
  // exactly like the stock-pack progress above.
  const refreshUserPacks = useCallback(async (): Promise<void> => {
    const roots = (await host.getUserSampleRoots?.('drums')?.catch(() => [])) ?? [];
    setUserPackCount(roots.length);
    kitResolver.reset();
  }, [host, kitResolver]);
  useEffect(() => {
    void refreshUserPacks();
    const unsub = host.onSamplePackProgress('user:drums', (p) => {
      if (p.status === 'complete') void refreshUserPacks();
    });
    return unsub;
  }, [refreshUserPacks, host]);

  // Phase 0.8: live drum-role vocabulary discovered from the library FS.
  // Populated by an effect on mount + when the resolver gets reset; fed
  // into buildDrumSystemPrompt(...) so the LLM is constrained to actual
  // on-disk folder names. Empty until the first scan completes. Re-scanned
  // when packStatus flips to 'current' (e.g., right after a download).
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);
  useEffect(() => {
    // Discover roles whenever ANY library is available — the stock pack OR at
    // least one user-imported pack (the resolver merges both root sets).
    if (packStatus !== 'current' && userPackCount === 0) {
      setAvailableRoles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const roles = await kitResolver.getDiscoveredRoles();
        if (!cancelled) setAvailableRoles(roles);
      } catch (err) {
        console.warn('[DrumGeneratorPanel] Failed to discover drum roles:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [kitResolver, packStatus, userPackCount]);

  // --- Load tracks when scene changes -----------------------------------
  const tracksLoadedForSceneRef = useRef<string | null>(null);
  const loadTracks = useCallback(async (incremental = false): Promise<void> => {
    const sceneAtStart = activeSceneId;
    if (!sceneAtStart) {
      setTracks([]);
      setCrossfadePairsMeta([]);
      setFadesMeta([]);
      tracksLoadedForSceneRef.current = null;
      // No scene → not loading. Without this, a load that already set
      // isLoadingTracks=true and is then superseded by a flip to a null
      // activeSceneId (the platform's effectiveSceneId briefly returns null
      // while project.scenes repopulates during load) leaves the spinner
      // stuck on "Loading tracks..." forever.
      setIsLoadingTracks(false);
      return;
    }

    if (!incremental && tracksLoadedForSceneRef.current !== sceneAtStart) {
      setTracks([]);
    }
    tracksLoadedForSceneRef.current = sceneAtStart;
    // Reset sound-history on a full (re)load so history resets per scene/reopen.
    if (!incremental) soundHistory.reset();

    const isStale = (): boolean => tracksLoadedForSceneRef.current !== sceneAtStart;

    if (!incremental) setIsLoadingTracks(true);
    try {
      await host.adoptSceneTracks();
      if (isStale()) return;
      const handles = await host.getPluginTracks();
      if (isStale()) return;
      const sceneData = await host.getAllSceneData(sceneAtStart) as Record<string, unknown>;
      if (isStale()) return;

      const idMap = new Map<string, string>();
      for (const h of handles) { idMap.set(h.id, h.dbId); }
      engineToDbIdRef.current = idMap;

      const trackStates: DrumTrackState[] = [];
      for (const handle of handles) {
        let runtimeState: PluginTrackRuntimeState = {
          id: handle.id,
          muted: false,
          solo: false,
          volume: 0.75,
          pan: 0,
        };
        let hasMidi = false;
        try {
          const info = await host.getTrackInfo(handle.id);
          runtimeState = {
            id: handle.id,
            muted: info.muted,
            solo: info.soloed,
            volume: info.volume,
            pan: info.pan,
          };
          hasMidi = info.hasMidi;
        } catch {
          // Use defaults
        }

        let fxDetailState: TrackFxDetailState = { ...EMPTY_FX_DETAIL_STATE };
        try {
          const fxState = await host.getTrackFxState(handle.id);
          fxDetailState = pluginFxToToggleFx(fxState);
        } catch {
          // Use defaults
        }

        const promptKey = `track:${handle.dbId}:prompt`;
        const samplePathKey = `track:${handle.dbId}:samplePath`;

        let prompt = typeof sceneData[promptKey] === 'string' ? sceneData[promptKey] as string : '';
        if (!prompt && handle.prompt) {
          prompt = handle.prompt;
          host.setSceneData(sceneAtStart, promptKey, prompt).catch(() => {});
        }

        const samplePath = typeof sceneData[samplePathKey] === 'string' ? sceneData[samplePathKey] as string : null;
        // subRole scene data no longer read in Phase 0.8 — folder name IS the role.
        // Old subRole rows in scene data are left in place harmlessly; they'll be
        // garbage-collected when the track is deleted (deleteTrack drops the row).

        if (!hasMidi && handle.role) {
          hasMidi = true;
        }

        let instrumentMissing = false;
        if (handle.instrumentPluginId) {
          try {
            const instrDescriptor = await host.getTrackInstrument(handle.id);
            if (instrDescriptor?.missing) {
              instrumentMissing = true;
            }
          } catch {
            // Non-fatal
          }
        }

        // Re-arm the drum sampler with the persisted sample on scene load.
        // The sampler instance is recreated when projects open; we have to
        // restore the loaded sample for playback to produce sound.
        if (samplePath) {
          host.setTrackDrumKit(handle.id, { samplePath }).catch((err: unknown) => {
            console.warn('[DrumGeneratorPanel] Failed to re-arm sampler on load:', err);
          });
        }

        trackStates.push({
          handle,
          prompt,
          role: handle.role ?? '',
          samplePath,
          shuffleHistory: samplePath ? new Set<string>([samplePath]) : new Set<string>(),
          runtimeState,
          fxDetailState,
          drawerOpen: false,
          drawerTab: 'fx',
          editorStage: false,
          isGenerating: false,
          error: null,
          hasMidi,
          generationProgress: 0,
          editNotes: [],
          editBars: 4,
          editBpm: 120,
          instrumentPluginId: handle.instrumentPluginId ?? null,
          instrumentName: handle.instrumentName ?? null,
          instrumentMissing,
        });
      }
      if (isStale()) return;
      // Carry forward the in-memory piano-roll edit buffer (editNotes/Bars/Bpm)
      // for tracks that still exist, matched by stable DB UUID. loadTracks
      // rebuilds every track with editNotes:[], but editLoadStartedRef is a
      // permanent "loaded once" latch (set on generation / first Edit-tab open,
      // never cleared). A reload fired after a generation — instrument swap,
      // agent mutation, engine-ready, or the 30s project sync — would otherwise
      // wipe the seeded notes while the latch still marks the track loaded, so
      // opening the Edit tab skips the engine refetch and shows an empty piano
      // roll even though the MIDI is safe in the engine + DB. Preserving the
      // buffer keeps editLoadStartedRef and editNotes consistent.
      setTracks(prev => {
        const prevByDbId = new Map(prev.map(p => [p.handle.dbId, p]));
        return trackStates.map(ts => {
          const carry = prevByDbId.get(ts.handle.dbId);
          return carry
            ? { ...ts, editNotes: carry.editNotes, editBars: carry.editBars, editBpm: carry.editBpm }
            : ts;
        });
      });
      // Restore persisted history (survives reopen); else seed the loaded sample
      // so the first shuffle's "previous" sound + the History tab have a baseline.
      for (const ts of trackStates) {
        const persisted = sceneData[`track:${ts.handle.dbId}:soundHistory`];
        if (persisted && typeof persisted === 'object') {
          soundHistory.restore(ts.handle.id, persisted as TrackSoundHistory);
        } else if (ts.samplePath) {
          soundHistory.record(ts.handle.id, ts.samplePath, sampleNameForDisplay(ts.samplePath));
        }
      }
      // Group crossfade members (normal tracks linked by a shared groupId in
      // scene-data) into pairs; the render layer excludes their standalone rows.
      if (tracksLoadedForSceneRef.current === sceneAtStart) {
        setCrossfadePairsMeta(parseCrossfadePairs(sceneData));
        setFadesMeta(parseFades(sceneData));
      }
    } catch (error: unknown) {
      console.error('[DrumGeneratorPanel] Failed to load tracks:', error);
    } finally {
      if (tracksLoadedForSceneRef.current === sceneAtStart) {
        setIsLoadingTracks(false);
      }
    }
  }, [host, activeSceneId, soundHistory]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  useEffect(() => {
    const map = new Map<string, string>();
    for (const t of tracks) { map.set(t.handle.id, t.handle.dbId); }
    engineToDbIdRef.current = map;
  }, [tracks]);

  // --- Reload tracks incrementally as individual bulk tracks complete ----
  const loadedCompletedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (placeholders.length === 0) {
      loadedCompletedIdsRef.current.clear();
      return;
    }
    const newCompleted = placeholders.filter(
      (ph: BulkAddPlaceholderTrack) => ph.status === 'completed' && !loadedCompletedIdsRef.current.has(ph.id)
    );
    if (newCompleted.length > 0) {
      for (const ph of newCompleted) {
        loadedCompletedIdsRef.current.add(ph.id);
      }
      loadTracks(true);
    }
  }, [placeholders, loadTracks]);

  const adoptAndLoad = useCallback((): void => {
    loadTracks(true);
  }, [loadTracks]);

  useEffect(() => {
    const unsub = host.onEngineReady(() => {
      adoptAndLoad();
    });
    return unsub;
  }, [host, adoptAndLoad]);

  useEffect(() => {
    if (typeof host.onAfterAgentMutation !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = host.onAfterAgentMutation(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadTracks(true);
      }, 500);
    });
    return () => {
      unsub?.();
      if (timer) clearTimeout(timer);
    };
  }, [host, loadTracks]);

  useEffect(() => {
    const unsub = host.onTrackStateChange(
      (trackId: string, state: PluginTrackRuntimeState) => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, runtimeState: state } : t
        ));
      }
    );
    return unsub;
  }, [host]);

  useEffect(() => {
    const unsub = host.onComposeProgress((event) => {
      const targetScene = event.sceneId;
      if (!targetScene) return;
      switch (event.phase) {
        case 'planning':
          setIsComposingForScene(targetScene, true);
          setPlaceholdersForScene(targetScene, []);
          break;
        case 'generating':
          setIsComposingForScene(targetScene, false);
          if (event.placeholders) {
            setPlaceholdersForScene(targetScene, event.placeholders);
          }
          break;
        case 'complete':
        case 'error':
          setIsComposingForScene(targetScene, false);
          setPlaceholdersForScene(targetScene, EMPTY_PLACEHOLDERS);
          break;
      }
    });
    return unsub;
  }, [host, setIsComposingForScene, setPlaceholdersForScene]);

  useEffect(() => {
    const refs = saveTimeoutRefs;
    return () => {
      for (const timeout of Object.values(refs.current)) {
        clearTimeout(timeout);
      }
    };
  }, []);

  // --- Add track --------------------------------------------------------
  const isAddingTrackRef = useRef(false);
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const handleAddTrack = useCallback(async (): Promise<void> => {
    if (isAddingTrackRef.current) return;
    if (!activeSceneId) {
      host.showToast('warning', 'Select SCENE');
      return;
    }
    if (!isConnected) {
      host.showToast('warning', 'Systems not connected');
      return;
    }
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to add tracks');
      return;
    }
    if (tracks.length >= MAX_TRACKS) return;

    isAddingTrackRef.current = true;
    setIsAddingTrack(true);
    try {
      // Drum tracks: no synth at creation. The sampler is loaded post-generate
      // via host.setTrackDrumKit({ samplePath }). Until then, the track is
      // silent — which is fine; the user has to type a prompt + click
      // Generate anyway.
      const handle = await host.createTrack({
        name: `drum-${Date.now()}`,
      });
      const newTrack: DrumTrackState = {
        handle,
        prompt: '',
        role: '',
        samplePath: null,
        shuffleHistory: new Set<string>(),
        runtimeState: { id: handle.id, muted: false, solo: false, volume: 0.75, pan: 0 },
        fxDetailState: { ...EMPTY_FX_DETAIL_STATE },
        drawerOpen: false,
        drawerTab: 'fx',
        editorStage: false,
        isGenerating: false,
        error: null,
        hasMidi: false,
        generationProgress: 0,
        editNotes: [],
        editBars: 4,
        editBpm: 120,
        instrumentPluginId: null,
        instrumentName: null,
        instrumentMissing: false,
      };
      setTracks(prev => [...prev, newTrack]);
      onExpandSelf?.();
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="drum-section"] [data-testid="sdk-prompt-input"]');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }, 350);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to create track', msg);
    } finally {
      isAddingTrackRef.current = false;
      setIsAddingTrack(false);
    }
  }, [host, activeSceneId, isConnected, isAuthenticated, tracks.length, onExpandSelf]);

  // Cross-panel import ("re-sound a part on drums"): pull a MIDI part out of a
  // track owned by ANOTHER panel in THIS scene and trigger it through a drum
  // kit. The discovery gate disables melodic→drum (a melodic part has no kit),
  // so in practice this only fires for percussive sources; it's implemented for
  // symmetry. createTrack registers ownership synchronously, so the owned
  // writes below are safe.
  const handlePortTrack = useCallback(
    async (sel: { sourceTrackDbId: string; trackName: string; role?: string }): Promise<void> => {
      if (!activeSceneId) { host.showToast('warning', 'Select SCENE'); return; }
      if (!isConnected) { host.showToast('warning', 'Systems not connected'); return; }
      if (tracks.length >= MAX_TRACKS) { host.showToast('warning', 'Track limit reached'); return; }
      if (!host.readImportableTrackMidi) return;
      let handle: PluginTrackHandle | null = null;
      try {
        handle = await host.createTrack({ name: `drum-${Date.now()}` });
        const midi = await host.readImportableTrackMidi(sel.sourceTrackDbId);
        const notes = midi.clips[0]?.notes ?? [];
        if (notes.length > 0) {
          const mc = await host.getMusicalContext();
          await host.writeMidiClip(handle.id, {
            startTime: 0,
            endTime: (mc.bars * 4 * 60) / mc.bpm,
            tempo: mc.bpm,
            notes,
          });
        }
        // Role-matched kit via the same resolver the generate/shuffle paths use.
        const role = sel.role ?? '';
        if (role) {
          try { await host.setTrackRole(handle.id, role); } catch { /* non-fatal */ }
          const picked = await kitResolver.pick(role);
          if (picked) {
            await applyDrumSound(handle.id, picked);
            soundHistory.record(handle.id, picked, sampleNameForDisplay(picked));
          }
        }
        host.showToast('success', 'Imported to drums', notes.length ? `${sel.trackName} → drums` : `${sel.trackName} (no MIDI yet)`);
        await loadTracks(true);
      } catch (err: unknown) {
        if (handle) { try { await host.deleteTrack(handle.id); } catch { /* best effort */ } }
        host.showToast('error', 'Import failed', err instanceof Error ? err.message : String(err));
      }
    },
    [host, activeSceneId, isConnected, tracks.length, kitResolver, applyDrumSound, soundHistory, loadTracks],
  );

  // Apply the crossfade volume automation: origin fades out, target fades in
  // across the loop (equal-power, crossover at sliderPos). Falls back to a static
  // equal-power blend on hosts without setTrackVolumeAutomation.
  const applyCrossfadeAutomation = useCallback(
    async (originTrackId: string, targetTrackId: string, bars: number, bpm: number, sliderPos: number): Promise<void> => {
      if (host.setTrackVolumeAutomation) {
        const curves = buildCrossfadeVolumeCurves(bars, bpm, sliderPos);
        await host.setTrackVolumeAutomation(originTrackId, curves.origin).catch(() => {});
        await host.setTrackVolumeAutomation(targetTrackId, curves.target).catch(() => {});
      } else {
        await host.setTrackVolume(originTrackId, EQUAL_POWER_GAIN).catch(() => {});
        await host.setTrackVolume(targetTrackId, EQUAL_POWER_GAIN).catch(() => {});
      }
    },
    [host],
  );

  // Apply a fade's one-sided volume curve (volume gesture ramps; build stays flat
  // at unity so the notes carry the fade). No-op on hosts without automation.
  const applyFadeAutomation = useCallback(
    async (
      trackId: string,
      direction: FadeDirection,
      bars: number,
      bpm: number,
      sliderPos: number,
      gesture: FadeGesture,
    ): Promise<void> => {
      if (!host.setTrackVolumeAutomation) return;
      const points = buildFadeVolumeCurve(bars, bpm, direction, sliderPos, gesture);
      await host.setTrackVolumeAutomation(trackId, points).catch(() => {});
    },
    [host],
  );

  // --- Create a crossfade pair (transition scenes) ----------------------
  // Two drum tracks share ONE generated pattern; the top wears the ORIGIN kit
  // sample, the bottom the TARGET's. One-action: generate → create both → write
  // same MIDI → copy kits → equal-power volumes → persist. LIFO rollback. Throws
  // on failure so the modal surfaces it.
  const handleCreateCrossfade = useCallback(
    async (origin: CrossfadeSelection, target: CrossfadeSelection): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (!isAuthenticated) throw new Error('Please sign in to generate the bridge.');
      if (tracks.length + 2 > MAX_TRACKS) throw new Error('Not enough track slots for a crossfade.');

      setIsCreatingCrossfade(true);
      const created: PluginTrackHandle[] = [];
      try {
        const role = target.role ?? origin.role ?? ''; // bridge heads toward the target

        // 1. Generate ONE drum bridge clip via MIDI INPAINTING: morph the ORIGIN
        // drum pattern into the TARGET across the transition. The harmonic frame
        // (key/bpm/chords) auto-prefixes; we add the two endpoint patterns (as a
        // rhythm gloss + JSON) — no concurrent sibling layers. Done before
        // creating the empty tracks.
        const mc = await host.getMusicalContext();
        const [originMidi, targetMidi, originKey, targetKey] = await Promise.all([
          host.readImportableTrackMidi ? host.readImportableTrackMidi(origin.dbId) : Promise.resolve({ clips: [] }),
          host.readImportableTrackMidi ? host.readImportableTrackMidi(target.dbId) : Promise.resolve({ clips: [] }),
          host.getSceneKey ? host.getSceneKey(fromSceneId) : Promise.resolve(null),
          host.getSceneKey ? host.getSceneKey(toSceneId) : Promise.resolve(null),
        ]);
        const userPrompt = buildCrossfadeInpaintPrompt({
          role,
          bars: mc.bars,
          originName: origin.name,
          targetName: target.name,
          originKey: originKey ? `${originKey.key} ${originKey.mode}` : null,
          targetKey: targetKey ? `${targetKey.key} ${targetKey.mode}` : null,
          originNotes: originMidi.clips[0]?.notes ?? [],
          targetNotes: targetMidi.clips[0]?.notes ?? [],
          percussive: true,
        });
        const llm = await host.generateWithLLM({
          system: buildDrumSystemPrompt(availableRoles),
          user: userPrompt,
          responseFormat: 'json',
        });
        const parsed = parseLLMDrumResponse(llm.content);
        if (!parsed || parsed.notes.length === 0) {
          throw new Error('The bridge generator returned no drum notes.');
        }
        // Drum MIDI: flatten pitch to 60 (sampler plays native pitch there); keep
        // micro-timing (quantize:false), drop overlaps.
        const flattened = parsed.notes.map((n) => ({ ...n, pitch: 60 }));
        const notes = await host.postProcessMidi(flattened, { quantize: false, removeOverlaps: true });
        const clip: MidiClipData = {
          startTime: 0,
          endTime: (mc.bars * 4 * 60) / mc.bpm,
          tempo: mc.bpm,
          notes,
        };

        // 2. Create the two layer tracks (drum tracks have no synth; sampler below).
        const top = await host.createTrack({ name: `drum-${Date.now()}-xf-o` });
        created.push(top);
        const bottom = await host.createTrack({ name: `drum-${Date.now()}-xf-t` });
        created.push(bottom);
        if (role) {
          await host.setTrackRole(top.id, role).catch(() => {});
          await host.setTrackRole(bottom.id, role).catch(() => {});
        }

        // 3. SAME MIDI on both layers.
        await host.writeMidiClip(top.id, clip);
        await host.writeMidiClip(bottom.id, clip);

        // 4. Copy each source kit sample onto its layer (exact sound; persist by
        // the NEW track's dbId — engineToDbIdRef isn't populated until reload).
        const copyDrumSound = async (newTrack: PluginTrackHandle, sourceDbId: string): Promise<string> => {
          if (!host.getTrackSound) return 'default';
          const snap = await host.getTrackSound(sourceDbId);
          if (!snap || snap.kind !== 'sample') return 'default';
          await host.setTrackDrumKit(newTrack.id, { samplePath: snap.samplePath });
          await host.setSceneData(scene, `track:${newTrack.dbId}:samplePath`, snap.samplePath).catch(() => {});
          return snap.label;
        };
        const originLabel = await copyDrumSound(top, origin.dbId);
        const targetLabel = await copyDrumSound(bottom, target.dbId);

        // 5. Crossfade volume automation (origin fades out, target fades in
        // across the loop; equal-power, crossover at the centered slider).
        await applyCrossfadeAutomation(top.id, bottom.id, mc.bars, mc.bpm, 0.5);

        // 6. Persist the pairing.
        const groupId = top.dbId;
        const originMeta: CrossfadeMeta = {
          groupId, slot: 'origin', partnerDbId: bottom.dbId, sourceTrackDbId: origin.dbId,
          sourceSceneId: fromSceneId, sourceName: origin.name, soundLabel: originLabel, sliderPos: 0.5,
        };
        const targetMeta: CrossfadeMeta = {
          groupId, slot: 'target', partnerDbId: top.dbId, sourceTrackDbId: target.dbId,
          sourceSceneId: toSceneId, sourceName: target.name, soundLabel: targetLabel, sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${top.dbId}:crossfade`, originMeta);
        await host.setSceneData(scene, `track:${bottom.dbId}:crossfade`, targetMeta);

        await loadTracks(true);
        host.showToast('success', 'Crossfade created', `${origin.name} → ${target.name}`);
      } catch (err: unknown) {
        for (const h of [...created].reverse()) {
          try { await host.deleteTrack(h.id); } catch { /* best effort */ }
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        setIsCreatingCrossfade(false);
      }
    },
    [host, activeSceneId, isConnected, isAuthenticated, tracks.length, sceneContext, availableRoles, applyCrossfadeAutomation, loadTracks],
  );

  // --- Create a fade (transition orphan) --------------------------------
  // A fade is a crossfade with one empty endpoint: ONE generated drum track that
  // fades in (target-only) or out (origin-only). The pattern is inpainted with
  // the source on the populated endpoint and ∅ on the other; the kit sample is
  // copied from the source; the gesture sets the volume-curve depth. LIFO rollback.
  const handleCreateFade = useCallback(
    async (selection: FadeSelection, direction: FadeDirection, gesture: FadeGesture): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (!isAuthenticated) throw new Error('Please sign in to generate the fade.');
      if (tracks.length + 1 > MAX_TRACKS) throw new Error('Not enough track slots for a fade.');

      setIsCreatingFade(true);
      const created: PluginTrackHandle[] = [];
      try {
        const role = selection.role ?? '';
        const sourceSceneId = direction === 'out' ? fromSceneId : toSceneId;

        // 1. Inpaint with ONE empty endpoint (grow in / dissolve out), percussive.
        const mc = await host.getMusicalContext();
        const [srcMidi, srcKey] = await Promise.all([
          host.readImportableTrackMidi ? host.readImportableTrackMidi(selection.dbId) : Promise.resolve({ clips: [] }),
          host.getSceneKey ? host.getSceneKey(sourceSceneId) : Promise.resolve(null),
        ]);
        const srcNotes = srcMidi.clips[0]?.notes ?? [];
        const keyStr = srcKey ? `${srcKey.key} ${srcKey.mode}` : null;
        const userPrompt = buildCrossfadeInpaintPrompt({
          role,
          bars: mc.bars,
          originName: direction === 'out' ? selection.name : 'silence',
          targetName: direction === 'in' ? selection.name : 'silence',
          originKey: direction === 'out' ? keyStr : null,
          targetKey: direction === 'in' ? keyStr : null,
          originNotes: direction === 'out' ? srcNotes : [],
          targetNotes: direction === 'in' ? srcNotes : [],
          percussive: true,
        });
        const llm = await host.generateWithLLM({
          system: buildDrumSystemPrompt(availableRoles),
          user: userPrompt,
          responseFormat: 'json',
        });
        const parsed = parseLLMDrumResponse(llm.content);
        if (!parsed || parsed.notes.length === 0) {
          throw new Error('The fade generator returned no drum notes.');
        }
        // Drum MIDI: flatten pitch to 60; keep micro-timing (quantize:false).
        const flattened = parsed.notes.map((n) => ({ ...n, pitch: 60 }));
        const notes = await host.postProcessMidi(flattened, { quantize: false, removeOverlaps: true });
        const clip: MidiClipData = { startTime: 0, endTime: (mc.bars * 4 * 60) / mc.bpm, tempo: mc.bpm, notes };

        // 2. Create ONE track (drum tracks have no synth; sampler below).
        const track = await host.createTrack({ name: `drum-${Date.now()}-fade-${direction}` });
        created.push(track);
        if (role) await host.setTrackRole(track.id, role).catch(() => {});

        // 3. MIDI.
        await host.writeMidiClip(track.id, clip);

        // 4. Copy the source kit sample (persist by the NEW track's dbId).
        let soundLabel = 'default';
        if (host.getTrackSound) {
          const snap = await host.getTrackSound(selection.dbId);
          if (snap && snap.kind === 'sample') {
            await host.setTrackDrumKit(track.id, { samplePath: snap.samplePath });
            await host.setSceneData(scene, `track:${track.dbId}:samplePath`, snap.samplePath).catch(() => {});
            soundLabel = snap.label;
          }
        }

        // 5. One-sided volume curve (centered slider).
        await applyFadeAutomation(track.id, direction, mc.bars, mc.bpm, 0.5, gesture);
        appliedFadeAutomationRef.current.add(track.id);

        // 6. Persist the fade metadata.
        const meta: FadeMeta = {
          direction,
          gesture,
          sourceTrackDbId: selection.dbId,
          sourceSceneId,
          sourceName: selection.name,
          soundLabel,
          sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${track.dbId}:fade`, meta);

        await loadTracks(true);
        host.showToast('success', direction === 'in' ? 'Fade in created' : 'Fade out created', selection.name);
      } catch (err: unknown) {
        for (const h of [...created].reverse()) {
          try { await host.deleteTrack(h.id); } catch { /* best effort */ }
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        setIsCreatingFade(false);
      }
    },
    [host, activeSceneId, isConnected, isAuthenticated, tracks.length, sceneContext, availableRoles, applyFadeAutomation, loadTracks],
  );

  // Compose flow intentionally omitted — see the header-content comment
  // below. Reinstate this callback once `host.composeScene` is plugin-aware
  // (drum tracks owned by drum-generator + drum sampler auto-loaded).

  // --- Export tracks as MIDI bundle -------------------------------------
  const [isExportingMidi, setIsExportingMidi] = useState(false);
  const handleExportMidi = useCallback(async (): Promise<void> => {
    if (isExportingMidi) return;
    setIsExportingMidi(true);
    try {
      const result = await host.exportTracksAsMidiBundle({
        defaultName: 'drum-tracks',
      });
      if (result.success) {
        const filename = result.filePath.split('/').pop() || result.filePath;
        const skippedNote = result.skippedCount > 0
          ? ` (${result.skippedCount} empty track${result.skippedCount === 1 ? '' : 's'} skipped)`
          : '';
        host.showToast('success', 'MIDI exported', `${result.trackCount} track${result.trackCount === 1 ? '' : 's'} → ${filename}${skippedNote}`);
      } else if (!('canceled' in result && result.canceled)) {
        const errMsg = 'error' in result ? result.error : 'Unknown error';
        host.showToast('error', 'Export failed', errMsg);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      host.showToast('error', 'Export failed', msg);
    } finally {
      setIsExportingMidi(false);
    }
  }, [host, isExportingMidi]);

  // --- Push header content (+ Add button) to accordion header ---
  // Compose is intentionally NOT exposed in the drum panel yet. The host's
  // composeScene workflow (bulk-add-service.ts) hardcodes plugin ownership
  // to synth-generator, so a "Compose" click here would create synth tracks
  // loaded with Surge XT — not drum tracks routed through the sampler.
  // Restore the button once composeScene is plugin-aware (BulkAddRequest
  // carries pluginId + contract LLM is biased to drum-only roles when the
  // caller is drum-generator).
  const isBulkActive = !!(isComposing || placeholders.length > 0);
  const needsContract = !sceneContext?.hasContract;
  const xfFromId = sceneContext?.transitionFromSceneId ?? null;
  const xfToId = sceneContext?.transitionToSceneId ?? null;
  const canCrossfade =
    sceneContext?.sceneType === 'transition' && !!xfFromId && !!xfToId && !!host.listSceneFamilyTracks;
  // Leaving a transition scene drops back to the Tracks view (the toggle is hidden).
  useEffect(() => {
    if (!canCrossfade) setDesignerView(false);
  }, [canCrossfade]);
  // Fetch the source-track total once per transition scene (stable denominator).
  useEffect(() => {
    if (!canCrossfade || !xfFromId || !xfToId || !host.listSceneFamilyTracks) {
      setTransitionSourceTotal(0);
      return;
    }
    let cancelled = false;
    void Promise.all([host.listSceneFamilyTracks(xfFromId), host.listSceneFamilyTracks(xfToId)])
      .then(([a, b]) => { if (!cancelled) setTransitionSourceTotal(a.length + b.length); })
      .catch(() => { if (!cancelled) setTransitionSourceTotal(0); });
    return () => { cancelled = true; };
  }, [canCrossfade, xfFromId, xfToId, host]);
  // Tracks already turned into transitions: 2 sources per crossfade pair, 1 per fade.
  const transitionDone = crossfadePairsMeta.length * 2 + fadesMeta.length;
  useEffect(() => {
    if (!onHeaderContent) return;
    // Hide the "+ Add" button until SOME library is installed — the stock pack
    // OR at least one user-imported pack. In the no-library state the body
    // renders a CTA card and adding tracks would produce silent ones.
    if (packStatus !== 'current' && userPackCount === 0) {
      onHeaderContent(null);
      return () => { onHeaderContent(null); };
    }
    const addDisabled =
      needsContract ||
      !isConnected ||
      !activeSceneId ||
      tracks.length >= MAX_TRACKS ||
      isAddingTrack;

    onHeaderContent(
      <div className="flex gap-1 items-center">
        {(!canCrossfade || !designerView) && host.openSampleImportWizard && (
          <button
            data-testid="import-own-samples-drums-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              host.openSampleImportWizard?.('drums');
            }}
            title="Import your own drum samples from a folder"
            className="px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent"
          >
            Import Samples
          </button>
        )}
        {(!canCrossfade || !designerView) && host.listImportableTracks && (
          <button
            data-testid="import-from-scene-drums-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onExpandSelf?.();
              setImportOpen(true);
            }}
            disabled={!activeSceneId}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              !activeSceneId
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
          >
            Import Track
          </button>
        )}
        {(!canCrossfade || !designerView) && (
          <button
            data-testid="add-drum-track-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (needsContract) { onOpenContract?.(); return; }
              handleAddTrack();
            }}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              addDisabled
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
            }`}
          >
            Add Track
          </button>
        )}
        {canCrossfade && (
          <button
            data-testid="drums-view-toggle"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (!designerView) {
                if (needsContract) { onOpenContract?.(); return; }
                onExpandSelf?.();
              }
              setDesignerView((v) => !v);
            }}
            disabled={!designerView && needsContract}
            title={designerView ? 'Back to the track list' : 'Open the transition designer'}
            className="relative overflow-hidden px-2 py-0.5 text-[10px] font-medium rounded-sm border border-sas-accent/40 text-sas-accent transition-colors hover:border-sas-accent disabled:opacity-50"
          >
            {transitionSourceTotal > 0 && (
              <span
                className="absolute inset-y-0 left-0 bg-sas-accent/25"
                style={{ width: `${Math.min(100, (transitionDone / transitionSourceTotal) * 100)}%` }}
                aria-hidden
              />
            )}
            <span className="relative">
              ⇄ {designerView ? 'Transition' : 'Tracks'}
              {transitionSourceTotal > 0 ? ` ${transitionDone}/${transitionSourceTotal}` : ''}
            </span>
          </button>
        )}
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, sceneContext, isConnected, isAddingTrack, packStatus,
      userPackCount, needsContract, activeSceneId, tracks.length, handleAddTrack,
      onOpenContract, host, canCrossfade, designerView,
      transitionDone, transitionSourceTotal, onExpandSelf]);

  useEffect(() => {
    if (!onLoading) return;
    const anyGenerating = tracks.some((t: DrumTrackState) => t.isGenerating);
    onLoading(isLoadingTracks || anyGenerating || isBulkActive);
    return () => { onLoading(false); };
  }, [onLoading, isLoadingTracks, tracks, isBulkActive]);

  // --- Delete track -----------------------------------------------------
  const handleDeleteTrack = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.deleteTrack(trackId);
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      if (activeSceneId) {
        await host.deleteSceneData(activeSceneId, `track:${dbId}:prompt`);
        // Drop any legacy subRole row left over from pre-Phase 0.8 tracks.
        await host.deleteSceneData(activeSceneId, `track:${dbId}:subRole`).catch(() => {});
        await host.deleteSceneData(activeSceneId, `track:${dbId}:samplePath`);
      }
      setTracks(prev => prev.filter(t => t.handle.id !== trackId));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to delete track', msg);
    }
  }, [host, activeSceneId]);

  // --- Crossfade group controls -----------------------------------------
  // Mute/solo act on BOTH layers together; per-layer volume/pan reuse the normal
  // handlers (members are normal tracks in `tracks`). Delete removes the whole
  // pair + its scene-data keys (crossfade + samplePath).
  const handleCrossfadeMute = useCallback((pair: ResolvedCrossfadePair): void => {
    const newMuted = !pair.origin.runtimeState.muted;
    for (const id of [pair.origin.handle.id, pair.target.handle.id]) {
      setTracks(prev => prev.map(t => (t.handle.id === id ? { ...t, runtimeState: { ...t.runtimeState, muted: newMuted } } : t)));
      host.setTrackMute(id, newMuted).catch(() => {});
    }
  }, [host]);

  const handleCrossfadeSolo = useCallback((pair: ResolvedCrossfadePair): void => {
    const newSolo = !pair.origin.runtimeState.solo;
    for (const id of [pair.origin.handle.id, pair.target.handle.id]) {
      setTracks(prev => prev.map(t => (t.handle.id === id ? { ...t, runtimeState: { ...t.runtimeState, solo: newSolo } } : t)));
      host.setTrackSolo(id, newSolo).catch(() => {});
    }
  }, [host]);

  const handleCrossfadeDelete = useCallback(async (pair: ResolvedCrossfadePair): Promise<void> => {
    try {
      for (const member of [pair.origin, pair.target]) {
        await host.deleteTrack(member.handle.id);
        if (activeSceneId) {
          await host.deleteSceneData(activeSceneId, `track:${member.handle.dbId}:crossfade`);
          await host.deleteSceneData(activeSceneId, `track:${member.handle.dbId}:samplePath`).catch(() => {});
        }
      }
      setCrossfadePairsMeta(prev => prev.filter(p => p.groupId !== pair.groupId));
      setTracks(prev => prev.filter(t => t.handle.id !== pair.origin.handle.id && t.handle.id !== pair.target.handle.id));
      host.showToast('success', 'Crossfade removed');
    } catch (err: unknown) {
      host.showToast('error', 'Failed to delete crossfade', err instanceof Error ? err.message : String(err));
    }
  }, [host, activeSceneId]);

  // Drag the crossfade fader: optimistic UI now, debounced engine apply + persist
  // of sliderPos (recomputes the equal-power curves at the new crossover point).
  const crossfadeSliderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const handleCrossfadeSlider = useCallback((pair: ResolvedCrossfadePair, pos: number): void => {
    setCrossfadePairsMeta(prev => prev.map(p => (p.groupId === pair.groupId ? { ...p, sliderPos: pos } : p)));
    if (crossfadeSliderTimers.current[pair.groupId]) clearTimeout(crossfadeSliderTimers.current[pair.groupId]);
    crossfadeSliderTimers.current[pair.groupId] = setTimeout(() => {
      void (async () => {
        const mc = await host.getMusicalContext();
        await applyCrossfadeAutomation(pair.origin.handle.id, pair.target.handle.id, mc.bars, mc.bpm, pos);
        if (activeSceneId) {
          const sceneData = (await host.getAllSceneData(activeSceneId)) as Record<string, unknown>;
          for (const dbId of [pair.originDbId, pair.targetDbId]) {
            const meta = asCrossfadeMeta(sceneData[`track:${dbId}:crossfade`]);
            if (meta) host.setSceneData(activeSceneId, `track:${dbId}:crossfade`, { ...meta, sliderPos: pos }).catch(() => {});
          }
        }
      })();
    }, 200);
  }, [host, activeSceneId, applyCrossfadeAutomation]);

  // --- Fade controls ----------------------------------------------------
  // A fade is a single normal track, so mute/solo/volume/pan reuse the normal
  // per-track handlers. Delete removes the track + its scene-data (fade + samplePath).
  const handleFadeDelete = useCallback(async (fade: ResolvedFade): Promise<void> => {
    try {
      await host.deleteTrack(fade.track.handle.id);
      if (activeSceneId) {
        await host.deleteSceneData(activeSceneId, `track:${fade.dbId}:fade`);
        await host.deleteSceneData(activeSceneId, `track:${fade.dbId}:samplePath`).catch(() => {});
      }
      setFadesMeta(prev => prev.filter(f => f.dbId !== fade.dbId));
      setTracks(prev => prev.filter(t => t.handle.id !== fade.track.handle.id));
      host.showToast('success', 'Fade removed');
    } catch (err: unknown) {
      host.showToast('error', 'Failed to delete fade', err instanceof Error ? err.message : String(err));
    }
  }, [host, activeSceneId]);

  const fadeSliderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const handleFadeSlider = useCallback((fade: ResolvedFade, pos: number): void => {
    setFadesMeta(prev => prev.map(f => (f.dbId === fade.dbId ? { ...f, meta: { ...f.meta, sliderPos: pos } } : f)));
    if (fadeSliderTimers.current[fade.dbId]) clearTimeout(fadeSliderTimers.current[fade.dbId]);
    fadeSliderTimers.current[fade.dbId] = setTimeout(() => {
      void (async () => {
        const mc = await host.getMusicalContext();
        await applyFadeAutomation(fade.track.handle.id, fade.meta.direction, mc.bars, mc.bpm, pos, fade.meta.gesture);
        if (activeSceneId) {
          const sceneData = (await host.getAllSceneData(activeSceneId)) as Record<string, unknown>;
          const meta = asFadeMeta(sceneData[`track:${fade.dbId}:fade`]);
          if (meta) host.setSceneData(activeSceneId, `track:${fade.dbId}:fade`, { ...meta, sliderPos: pos }).catch(() => {});
        }
      })();
    }, 200);
  }, [host, activeSceneId, applyFadeAutomation]);

  // --- Update prompt (debounced save) -----------------------------------
  const handlePromptChange = useCallback((trackId: string, prompt: string): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, prompt } : t
    ));
    const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
    if (saveTimeoutRefs.current[trackId]) {
      clearTimeout(saveTimeoutRefs.current[trackId]);
    }
    saveTimeoutRefs.current[trackId] = setTimeout(() => {
      if (activeSceneId) {
        host.setSceneData(activeSceneId, `track:${dbId}:prompt`, prompt).catch(() => {});
      }
    }, 500);
  }, [host, activeSceneId]);

  // --- Generate drum-pattern MIDI ---------------------------------------
  const handleGenerate = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track || !track.prompt.trim()) return;
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to generate MIDI');
      return;
    }

    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, isGenerating: true, error: null, generationProgress: 0 } : t
    ));

    try {
      const musicalContext = await host.getMusicalContext();
      const generationContext = await host.getGenerationContext(trackId);

      // formatConcurrentTracks returns '' when no other tracks exist —
      // skip the heading entirely in that case rather than emitting
      // "(none yet)" noise into every solo-track generation.
      const concurrentBlock = formatConcurrentTracks(generationContext);

      const promptParts: string[] = [];
      if (concurrentBlock) {
        promptParts.push(concurrentBlock, '');
      }
      promptParts.push(
        `User request: "${track.prompt}"`,
        ``,
        `Generate a drum-pattern MIDI clip that fits this context.`,
      );
      const userPrompt = promptParts.join('\n');

      const llmResult = await host.generateWithLLM({
        // Phase 0.8: roles are FS-discovered now. Pass the live list so the
        // LLM picks from real on-disk folder names (e.g. "kick", "hat-closed")
        // instead of the old grouped taxonomy ("kicks", "hats", ...).
        system: buildDrumSystemPrompt(availableRoles),
        user: userPrompt,
        responseFormat: 'json',
      });

      const parsed = parseLLMDrumResponse(llmResult.content);
      if (!parsed || parsed.notes.length === 0) {
        throw new Error('LLM returned no valid drum notes');
      }

      // Pitch normalization: Tracktion's SamplerPlugin pitch-shifts the
      // loaded sample by `hz(incomingNote) / hz(keyNote)` per voice
      // (tracktion_SamplerPlugin.cpp:43-44). Our sampler is configured
      // with keyNote=60 so the sample only plays at its native pitch
      // when the incoming note is 60. The LLM tends to emit GM-ish
      // drum pitches (36 kick, 38 snare, 42 closed hat) — which would
      // play the sample 1-2 octaves below its native pitch. The plan's
      // intent is "MIDI pitch is ignored", which we enforce here by
      // flattening every note to 60. Velocity + start-time + duration
      // (the parts that carry the LLM's musical intent) are untouched.
      const flattenedNotes = parsed.notes.map(n => ({ ...n, pitch: 60 }));

      // Keep removeOverlaps (avoids audible double-triggers on the same
      // sample), but DO NOT quantize — the LLM's micro-timing IS the
      // groove for drum patterns. quantize default is 1/16 @ 75%, which
      // would flatten ghost notes and intentional pushes.
      const processedNotes = await host.postProcessMidi(flattenedNotes, {
        quantize: false,
        removeOverlaps: true,
      });

      const clipData: MidiClipData = {
        startTime: 0,
        endTime: (musicalContext.bars * 4 * 60) / musicalContext.bpm,
        tempo: musicalContext.bpm,
        notes: processedNotes,
      };
      await host.writeMidiClip(trackId, clipData);

      const genDbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      // Validate the LLM-emitted role against the live FS-discovered list
      // (Phase 0.8). Fall back to current track role if the LLM hallucinated;
      // last-resort fallback to the first available role if both are empty.
      const fallbackRole = track.role || availableRoles[0] || '';
      const newRole = (parsed.role && availableRoles.includes(parsed.role)) ? parsed.role : fallbackRole;

      if (activeSceneId && newRole) {
        host.setSceneData(activeSceneId, `track:${genDbId}:role`, newRole).catch(() => {});
      }
      if (newRole && newRole !== track.role) {
        try {
          await host.setTrackRole(trackId, newRole);
        } catch (err) {
          console.warn('[DrumGeneratorPanel] setTrackRole failed:', err);
        }
      }

      // Pick a sample and load the drum sampler. Don't overwrite an explicit
      // user-chosen instrument (e.g. user picked a custom sampler manually).
      // Phase 0.8: kitResolver.pick takes (role, excludePaths) where role IS
      // the folder. Excluding the current samplePath gives an actual swap
      // on regenerate; not strictly required since the random pick has a
      // 1/N chance of being the same anyway, but cleaner.
      let newSamplePath = track.samplePath;
      const currentExclude: ReadonlySet<string> = track.samplePath
        ? new Set<string>([track.samplePath])
        : new Set<string>();
      if (!track.instrumentPluginId && newRole) {
        const picked = await kitResolver.pick(newRole, currentExclude);
        if (picked) {
          newSamplePath = picked;
          if (activeSceneId) {
            host.setSceneData(activeSceneId, `track:${genDbId}:samplePath`, picked).catch(() => {});
          }
          try {
            await host.setTrackDrumKit(trackId, { samplePath: picked });
          } catch (err) {
            console.warn('[DrumGeneratorPanel] setTrackDrumKit failed:', err);
          }
        }
      }

      // Generate begins a fresh shuffle cycle — seed the history with the
      // sample we just picked so the next shuffle won't return the same one.
      const freshHistory = newSamplePath ? new Set<string>([newSamplePath]) : new Set<string>();

      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? {
              ...t, isGenerating: false, error: null, role: newRole, samplePath: newSamplePath,
              hasMidi: true, generationProgress: 0, shuffleHistory: freshHistory,
              // Seed the piano-roll's editable copy from the just-generated notes
              // (flattened to pitch 60 like all drum MIDI). The Edit tab opens with
              // no round-trip and won't clobber these.
              editNotes: processedNotes, editBars: musicalContext.bars, editBpm: musicalContext.bpm,
            }
          : t
      ));
      editLoadStartedRef.current.add(trackId);
      // Generation is a fresh baseline — start sound-history over at this sample.
      soundHistory.clear(trackId);
      if (newSamplePath) {
        soundHistory.record(trackId, newSamplePath, sampleNameForDisplay(newSamplePath));
      }
      host.showToast('success', 'Drum pattern generated');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Generation failed';
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, isGenerating: false, error: msg, generationProgress: 0 } : t
      ));
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, activeSceneId, availableRoles, kitResolver, soundHistory]);

  // --- Mute/Solo/Volume/Pan -----------------------------------------------
  const handleMuteToggle = useCallback((trackId: string): void => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    const newMuted = !track.runtimeState.muted;
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, muted: newMuted } } : t
    ));
    host.setTrackMute(trackId, newMuted).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, muted: !newMuted } } : t
      ));
    });
  }, [host, tracks]);

  const handleSoloToggle = useCallback((trackId: string): void => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    const newSolo = !track.runtimeState.solo;
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, solo: newSolo } } : t
    ));
    host.setTrackSolo(trackId, newSolo).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, solo: !newSolo } } : t
      ));
    });
  }, [host, tracks]);

  const handleVolumeChange = useCallback((trackId: string, volume: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, volume } } : t
    ));
    host.setTrackVolume(trackId, volume).catch(() => {});
  }, [host]);

  const handlePanChange = useCallback((trackId: string, pan: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, pan } } : t
    ));
    host.setTrackPan(trackId, pan).catch(() => {});
  }, [host]);

  // The ▾ button opens the unified drawer to a non-FX tab (History for drums),
  // or closes it if it's already showing one.
  const handleToggleDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map(t => {
      if (t.handle.id !== trackId) return t;
      const onSound = t.drawerOpen && t.drawerTab !== 'fx';
      return { ...t, drawerOpen: !onSound, drawerTab: 'history', editorStage: false };
    }));
  }, []);

  // --- Shuffle: cycle through every sample in the role before repeating ---
  // Each track maintains a per-track shuffleHistory Set of already-used
  // sample paths. We pass it to kitResolver.pick as the excludePaths; when
  // the filtered pool is empty (== all samples used), we reset the history
  // and pick again. After a successful pick we add the new path to the
  // (fresh-or-existing) history and store it on the track.
  const handleShuffle = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    const role = track.role;
    if (!role) {
      host.showToast('warning', 'Shuffle skipped', 'Generate first to set the role');
      return;
    }
    try {
      const history = track.shuffleHistory;
      let picked = await kitResolver.pick(role, history);
      let nextHistory: Set<string>;
      if (!picked) {
        // Pool exhausted — reset the deck and pick from the full pool
        nextHistory = new Set<string>();
        picked = await kitResolver.pick(role, nextHistory);
      } else {
        nextHistory = new Set(history);
      }
      if (!picked) {
        host.showToast('warning', 'Shuffle skipped', 'No samples available for this role');
        return;
      }
      nextHistory.add(picked);

      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      if (activeSceneId) {
        host.setSceneData(activeSceneId, `track:${dbId}:samplePath`, picked).catch(() => {});
      }
      await host.setTrackDrumKit(trackId, { samplePath: picked });
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, samplePath: picked, shuffleHistory: nextHistory } : t
      ));
      // Record the new sound so the ↩ back-arrow + History tab can return to it.
      soundHistory.record(trackId, picked, sampleNameForDisplay(picked));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Shuffle failed';
      host.showToast('error', 'Shuffle failed', msg);
    }
  }, [host, tracks, activeSceneId, kitResolver, soundHistory]);

  // --- Duplicate track --------------------------------------------------
  const handleCopy = useCallback(async (trackId: string): Promise<void> => {
    try {
      const newHandle = await host.duplicateTrack(trackId);
      await loadTracks();
      host.showToast('success', 'Track duplicated', newHandle.name);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Copy failed';
      host.showToast('error', 'Copy failed', msg);
    }
  }, [host, loadTracks]);

  // --- FX Operations ----------------------------------------------------
  const handleFxToggle = useCallback((trackId: string, category: FxCategory, enabled: boolean): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled } } }
        : t
    ));
    host.toggleTrackFx(trackId, category, enabled).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled: !enabled } } }
          : t
      ));
    });
  }, [host]);

  const handleFxPresetChange = useCallback((trackId: string, category: FxCategory, presetIndex: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], presetIndex } } }
        : t
    ));
    host.setTrackFxPreset(trackId, category, presetIndex).then(result => {
      if (result.dryWet !== undefined) {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId
            ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: result.dryWet as number } } }
            : t
        ));
      }
    }).catch(() => {});
  }, [host]);

  const handleFxDryWetChange = useCallback((trackId: string, category: FxCategory, value: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: value } } }
        : t
    ));
    host.setTrackFxDryWet(trackId, category, value).catch(() => {});
  }, [host]);

  const toggleFxDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map(t => {
      if (t.handle.id !== trackId) return t;
      const onFx = t.drawerOpen && t.drawerTab === 'fx';
      return { ...t, drawerOpen: !onFx, drawerTab: 'fx', editorStage: false };
    }));
    const track = tracks.find(t => t.handle.id === trackId);
    // Refresh FX state from the engine whenever we OPEN the FX tab.
    const wasOnFx = !!track && track.drawerOpen && track.drawerTab === 'fx';
    if (track && !wasOnFx) {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // --- Piano-roll edit (load on first open, debounced save) ---
  // Lazily fetch the track's current MIDI the first time the Edit tab opens.
  // Reads LIVE engine state via host.readMidiNotes (optional method — older
  // hosts simply get an empty editor). bars/bpm come from the musical context
  // so the grid + save span match the scene.
  const loadEditNotes = useCallback(async (trackId: string): Promise<void> => {
    try {
      const mc = await host.getMusicalContext();
      let notes: PluginMidiNote[] = [];
      if (typeof host.readMidiNotes === 'function') {
        const result = await host.readMidiNotes(trackId);
        notes = result.clips[0]?.notes ?? [];
      }
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, editNotes: notes, editBars: mc.bars, editBpm: mc.bpm }
          : t
      ));
    } catch (err: unknown) {
      console.warn('[DrumGeneratorPanel] Failed to load MIDI for editing:', err);
    }
  }, [host]);

  // Every piano-roll edit: optimistic state update + debounced persist. Reads
  // bars/bpm inside the timeout (not from track state) so the callback stays
  // stable on [host] and we never write a stale span. Empty clip → clearMidi
  // (writeMidiClip throws INVALID_MIDI on zero notes).
  const handleNotesChange = useCallback((trackId: string, notes: PluginMidiNote[]): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, editNotes: notes } : t
    ));
    const key = `edit:${trackId}`;
    if (saveTimeoutRefs.current[key]) clearTimeout(saveTimeoutRefs.current[key]);
    saveTimeoutRefs.current[key] = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          if (notes.length === 0) {
            await host.clearMidi(trackId);
          } else {
            const mc = await host.getMusicalContext();
            await host.writeMidiClip(trackId, {
              startTime: 0,
              endTime: (mc.bars * 4 * 60) / mc.bpm,
              tempo: mc.bpm,
              notes,
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          host.showToast('error', 'Failed to save edit', msg);
        }
      })();
    }, 300);
  }, [host]);

  // Tab-strip clicks: switch the active tab, keeping the drawer open.
  const handleTabChange = useCallback((trackId: string, tab: DrawerTab): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, drawerOpen: true, drawerTab: tab } : t
    ));
    if (tab === 'fx') {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    } else if (tab === 'edit' && !editLoadStartedRef.current.has(trackId)) {
      editLoadStartedRef.current.add(trackId);
      void loadEditNotes(trackId);
    }
  }, [host, loadEditNotes]);

  const handleProgressChange = useCallback((trackId: string, pct: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, generationProgress: pct } : t
    ));
  }, []);

  // --- Instrument selection callbacks ------------------------------------
  const toggleInstrumentDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map((t: DrumTrackState) => {
      if (t.handle.id !== trackId) return t;
      const onPick = t.drawerOpen && t.drawerTab === 'pick';
      return { ...t, drawerOpen: !onPick, drawerTab: 'pick', editorStage: !onPick && !!t.instrumentPluginId };
    }));
    if (availableInstruments.length === 0 && !instrumentsLoading) {
      setInstrumentsLoading(true);
      host.getAvailableInstruments().then((instruments: InstrumentDescriptor[]) => {
        setAvailableInstruments(instruments);
      }).catch(() => {}).finally(() => {
        setInstrumentsLoading(false);
      });
    }
  }, [host, availableInstruments.length, instrumentsLoading]);

  const handleInstrumentSelect = useCallback(async (trackId: string, pluginId: string): Promise<void> => {
    const isSurgeXt = pluginId === 'Surge XT';

    if (isSurgeXt) {
      setTracks(prev => prev.map((t: DrumTrackState) =>
        t.handle.id === trackId ? { ...t, drawerOpen: false, editorStage: false } : t
      ));
      try {
        await host.setTrackInstrument(trackId, pluginId);
        const descriptor = await host.getTrackInstrument(trackId);
        setTracks(prev => prev.map((t: DrumTrackState) =>
          t.handle.id === trackId
            ? {
                ...t,
                instrumentPluginId: descriptor?.pluginId ?? null,
                instrumentName: descriptor?.name ?? null,
                instrumentMissing: descriptor?.missing ?? false,
              }
            : t
        ));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load instrument';
        host.showToast('error', 'Instrument load failed', msg);
      }
      return;
    }

    setTracks(prev => prev.map((t: DrumTrackState) =>
      t.handle.id === trackId ? { ...t, drawerTab: 'pick', editorStage: true } : t
    ));

    try {
      await host.setTrackInstrument(trackId, pluginId);
      const descriptor = await host.getTrackInstrument(trackId);
      setTracks(prev => prev.map((t: DrumTrackState) =>
        t.handle.id === trackId
          ? {
              ...t,
              instrumentPluginId: descriptor?.pluginId ?? null,
              instrumentName: descriptor?.name ?? null,
              instrumentMissing: descriptor?.missing ?? false,
            }
          : t
      ));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load instrument';
      console.error('[DrumGeneratorPanel] Failed to set instrument:', err);
      host.showToast('error', 'Instrument load failed', msg);
      setTracks(prev => prev.map((t: DrumTrackState) =>
        t.handle.id === trackId ? { ...t, editorStage: false } : t
      ));
    }
  }, [host]);

  const handleShowEditor = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.showInstrumentEditor(trackId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to open editor';
      host.showToast('error', 'Editor failed', msg);
    }
  }, [host]);

  const handleBackToInstruments = useCallback((trackId: string): void => {
    setTracks(prev => prev.map((t: DrumTrackState) =>
      t.handle.id === trackId ? { ...t, editorStage: false } : t
    ));
  }, []);

  const handleRefreshInstruments = useCallback((): void => {
    setInstrumentsLoading(true);
    host.getAvailableInstruments().then((instruments: InstrumentDescriptor[]) => {
      setAvailableInstruments(instruments);
    }).catch(() => {}).finally(() => {
      setInstrumentsLoading(false);
    });
  }, [host]);

  // Resolve crossfade pairs against live track state. Only COMPLETE pairs (both
  // members present in `tracks`) group into a CrossfadeTrackRow; a half-broken
  // pair's surviving member falls back to a normal row (not excluded).
  const { resolvedCrossfadePairs, crossfadeMemberDbIds } = useMemo(() => {
    const byDbId = new Map(tracks.map((t) => [t.handle.dbId, t]));
    const pairs: ResolvedCrossfadePair[] = [];
    const members = new Set<string>();
    for (const p of crossfadePairsMeta) {
      const origin = byDbId.get(p.originDbId);
      const target = byDbId.get(p.targetDbId);
      if (origin && target) {
        pairs.push({ ...p, origin, target });
        members.add(p.originDbId);
        members.add(p.targetDbId);
      }
    }
    return { resolvedCrossfadePairs: pairs, crossfadeMemberDbIds: members };
  }, [tracks, crossfadePairsMeta]);

  // Resolve fades against live track state (one FadeTrackRow per fade; member
  // excluded from the normal list; a fade whose track is gone is dropped).
  const { resolvedFades, fadeMemberDbIds } = useMemo(() => {
    const byDbId = new Map(tracks.map((t) => [t.handle.dbId, t]));
    const list: ResolvedFade[] = [];
    const members = new Set<string>();
    for (const f of fadesMeta) {
      const track = byDbId.get(f.dbId);
      if (track) { list.push({ ...f, track }); members.add(f.dbId); }
    }
    return { resolvedFades: list, fadeMemberDbIds: members };
  }, [tracks, fadesMeta]);

  // Auto re-sync drifted source kits. A crossfade/fade COPIES each source's
  // sample onto its layer at creation; if the source track's kit later changes,
  // re-copy it on the next load (the layer is locked, so divergence == drift).
  useEffect(() => {
    if (!host.getTrackSound || (resolvedCrossfadePairs.length === 0 && resolvedFades.length === 0)) return;
    let cancelled = false;
    const reapplyIfDrifted = async (layerTrackId: string, layerDbId: string, sourceDbId: string): Promise<void> => {
      if (!host.getTrackSound || cancelled) return;
      const [sourceSnap, layerSnap] = await Promise.all([
        host.getTrackSound(sourceDbId),
        host.getTrackSound(layerDbId),
      ]);
      if (cancelled || !sourceSnap || sourceSnap.kind !== 'sample') return;
      if (soundIdentity(sourceSnap) === soundIdentity(layerSnap)) return;
      await applyDrumSound(layerTrackId, sourceSnap.samplePath).catch(() => {});
    };
    void (async () => {
      for (const pair of resolvedCrossfadePairs) {
        await reapplyIfDrifted(pair.origin.handle.id, pair.origin.handle.dbId, pair.originSourceDbId);
        await reapplyIfDrifted(pair.target.handle.id, pair.target.handle.dbId, pair.targetSourceDbId);
      }
      for (const fade of resolvedFades) {
        await reapplyIfDrifted(fade.track.handle.id, fade.track.handle.dbId, fade.meta.sourceTrackDbId);
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedCrossfadePairs, resolvedFades, host, applyDrumSound]);

  // Re-apply each fade's one-sided volume curve on load (not engine-persisted;
  // recompute from sliderPos + gesture). Keyed by engine id (fires once per
  // resolve, incl. after reopen → new ids).
  useEffect(() => {
    if (!host.setTrackVolumeAutomation || resolvedFades.length === 0) return;
    void (async () => {
      const mc = await host.getMusicalContext();
      for (const fade of resolvedFades) {
        const id = fade.track.handle.id;
        if (appliedFadeAutomationRef.current.has(id)) continue;
        appliedFadeAutomationRef.current.add(id);
        await applyFadeAutomation(id, fade.meta.direction, mc.bars, mc.bpm, fade.meta.sliderPos, fade.meta.gesture);
      }
    })();
  }, [resolvedFades, host, applyFadeAutomation]);

  // --- Render -----------------------------------------------------------

  if (!activeSceneId) {
    return (
      <div data-testid="no-scene-placeholder-drum" className="flex items-center justify-center py-8">
        <button
          onClick={() => onSelectScene?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Select a Scene
        </button>
      </div>
    );
  }

  if (!sceneContext?.hasContract) {
    // Drums are neutral — importing a drum track from another scene does NOT
    // require this scene to have a contract first. Mount the modal here too so
    // the always-clickable "Import" header button stays reachable in the
    // no-contract state (the common "import a drum into a brand-new scene" case).
    return (
      <div data-testid="no-contract-placeholder-drum" className="flex items-center justify-center py-8">
        {host.listImportableTracks && (
          <ImportTrackModal
            host={host}
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={() => { void loadTracks(true); }}
            onPortTrack={host.readImportableTrackMidi ? handlePortTrack : undefined}
            testIdPrefix="drums-import"
          />
        )}
        <button
          onClick={() => onOpenContract?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Generate a Contract
        </button>
      </div>
    );
  }

  if (isComposing) {
    return (
      <div data-testid="drum-section" className="p-2">
        <SorceryProgressBar isLoading={true} statusText="COMPOSING..." heightClass="h-10" />
      </div>
    );
  }

  const activePlaceholders = placeholders;
  if (activePlaceholders.length > 0) {
    const tracksByDbId = new Map<string, DrumTrackState>();
    for (const t of tracks) {
      tracksByDbId.set(t.handle.dbId, t);
      if (t.handle.id !== t.handle.dbId) {
        tracksByDbId.set(t.handle.id, t);
      }
    }

    return (
      <div data-testid="drum-section" className="p-2 space-y-2">
        {activePlaceholders.map((ph: BulkAddPlaceholderTrack) => {
          const loadedTrack = ph.status === 'completed' ? tracksByDbId.get(ph.id) : undefined;
          if (loadedTrack) {
            return renderTrackRow(loadedTrack);
          }
          return (
            <div key={ph.id} data-testid="bulk-placeholder-track"
                 className="relative rounded-sm border w-full overflow-hidden border-sas-border bg-sas-panel-alt"
                 style={{ borderLeftColor: DRUM_ACCENT_COLOR, borderLeftWidth: '3px' }}>
              <SorceryProgressBar
                isLoading={true}
                statusText="CONJURING BEAT..."
                heightClass="h-10"
              />
            </div>
          );
        })}
      </div>
    );
  }

  // No stock pack AND no user packs → CTA card, plus a path to import your own.
  if (packStatus !== 'current' && userPackCount === 0) {
    return (
      <div className="space-y-2">
        <SamplePackCTACard
          host={host}
          pack={packInfo}
          status={packStatus}
          onDownloadComplete={refreshPackStatus}
        />
        {host.openSampleImportWizard && (
          <div className="text-center">
            <button
              data-testid="import-own-samples-cta-drums"
              onClick={() => host.openSampleImportWizard?.('drums')}
              className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
            >
              …or import your own drum samples
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="drum-section" className="p-2 space-y-2">
      {host.listImportableTracks && (
        <ImportTrackModal
          host={host}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => { void loadTracks(true); }}
          onPortTrack={host.readImportableTrackMidi ? handlePortTrack : undefined}
          testIdPrefix="drums-import"
        />
      )}
      {host.listImportableTracks && host.getTrackSound && (
        <ImportTrackModal
          host={host}
          mode="sound"
          open={!!soundImportTarget}
          title="Import Sample"
          onClose={() => setSoundImportTarget(null)}
          onImported={() => {}}
          onPick={handleSoundImportPick}
          testIdPrefix="drums-sound-import"
        />
      )}
      {canCrossfade && xfFromId && xfToId && (
        <div className={designerView ? 'contents' : 'hidden'}>
          <TransitionDesigner
            host={host}
            fromSceneId={xfFromId}
            toSceneId={xfToId}
            transitionSceneId={activeSceneId ?? ''}
            excludeSourceDbIds={[
              ...crossfadePairsMeta.flatMap((p) => [p.originSourceDbId, p.targetSourceDbId]),
              ...fadesMeta.map((f) => f.meta.sourceTrackDbId),
            ]}
            onCreateCrossfade={handleCreateCrossfade}
            onCreateFade={handleCreateFade}
            familyLabel="Drums"
            testIdPrefix="drums-transition-designer"
          />
        </div>
      )}
      {!(designerView && canCrossfade) && (isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        <>
          {resolvedCrossfadePairs.map((pair) => (
            <CrossfadeTrackRow
              key={pair.groupId}
              accentColor="#9333EA"
              levels={supportsMeters ? trackLevels : undefined}
              sliderPos={pair.sliderPos}
              origin={{
                trackId: pair.origin.handle.id,
                name: pair.origin.handle.name,
                role: pair.origin.role,
                sourceName: pair.originSourceName,
                soundLabel: pair.originSoundLabel,
                runtimeState: pair.origin.runtimeState,
              }}
              target={{
                trackId: pair.target.handle.id,
                name: pair.target.handle.name,
                role: pair.target.role,
                sourceName: pair.targetSourceName,
                soundLabel: pair.targetSoundLabel,
                runtimeState: pair.target.runtimeState,
              }}
              onMuteToggle={() => handleCrossfadeMute(pair)}
              onSoloToggle={() => handleCrossfadeSolo(pair)}
              onVolumeChange={(slot: CrossfadeSlot, vol: number) =>
                handleVolumeChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, vol)
              }
              onPanChange={(slot: CrossfadeSlot, pan: number) =>
                handlePanChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, pan)
              }
              onSliderChange={(pos: number) => handleCrossfadeSlider(pair, pos)}
              onDelete={() => handleCrossfadeDelete(pair)}
            />
          ))}
          {resolvedFades.map((fade) => (
            <FadeTrackRow
              key={fade.dbId}
              accentColor="#9333EA"
              levels={supportsMeters ? trackLevels : undefined}
              direction={fade.meta.direction}
              gesture={fade.meta.gesture}
              sliderPos={fade.meta.sliderPos}
              layer={{
                trackId: fade.track.handle.id,
                name: fade.track.handle.name,
                role: fade.track.role,
                sourceName: fade.meta.sourceName,
                soundLabel: fade.meta.soundLabel,
                runtimeState: fade.track.runtimeState,
              }}
              onMuteToggle={() => handleMuteToggle(fade.track.handle.id)}
              onSoloToggle={() => handleSoloToggle(fade.track.handle.id)}
              onVolumeChange={(vol: number) => handleVolumeChange(fade.track.handle.id, vol)}
              onPanChange={(pan: number) => handlePanChange(fade.track.handle.id, pan)}
              onSliderChange={(pos: number) => handleFadeSlider(fade, pos)}
              onDelete={() => handleFadeDelete(fade)}
            />
          ))}
          {tracks.map((track: DrumTrackState, index: number) =>
            crossfadeMemberDbIds.has(track.handle.dbId) || fadeMemberDbIds.has(track.handle.dbId)
              ? null
              : renderTrackRow(track, reorder.dragPropsFor(index)))}
        </>
      ))}

      {!designerView && !isLoadingTracks && tracks.length > 0 && (() => {
        const hasAnyMidi = tracks.some(t => t.hasMidi);
        const exportDisabled = isExportingMidi || !hasAnyMidi;
        return (
          <div className="pt-2">
            <button
              data-testid="export-midi-tracks-button"
              onClick={handleExportMidi}
              disabled={exportDisabled}
              title={
                isExportingMidi
                  ? 'Exporting...'
                  : !hasAnyMidi
                    ? 'Generate MIDI on at least one track first'
                    : 'Export all tracks as a ZIP of .mid files'
              }
              className={`w-full px-2 py-1.5 text-[10px] uppercase tracking-wide rounded-sm border transition-colors ${
                exportDisabled
                  ? 'text-sas-muted/40 border-transparent hover:border-sas-accent cursor-not-allowed'
                  : 'text-sas-muted hover:text-sas-accent border-sas-border hover:border-sas-accent'
              }`}
            >
              {isExportingMidi ? 'Exporting...' : 'Export Tracks'}
            </button>
          </div>
        );
      })()}
    </div>
  );

  function renderTrackRow(track: DrumTrackState, drag?: TrackRowDragProps): React.ReactElement {
    return (
      <TrackRow
        key={track.handle.id}
        drag={drag}
        track={{ id: track.handle.id, name: track.handle.name, role: track.role }}
        levels={supportsMeters ? trackLevels : undefined}
        prompt={track.prompt}
        runtimeState={{
          muted: track.runtimeState.muted,
          solo: track.runtimeState.solo,
          volume: track.runtimeState.volume,
          pan: track.runtimeState.pan,
        }}
        soloedOut={anySolo && !track.runtimeState.solo}
        fxDetailState={track.fxDetailState}
        drawerOpen={track.drawerOpen}
        drawerTab={track.drawerTab}
        onTabChange={(tab) => handleTabChange(track.handle.id, tab)}
        isGenerating={track.isGenerating}
        isAuthenticated={isAuthenticated}
        error={track.error}
        hasMidi={track.hasMidi}
        generationProgress={track.generationProgress}
        estimatedGenerationMs={ESTIMATED_GENERATION_MS}
        onPromptChange={(prompt: string) => handlePromptChange(track.handle.id, prompt)}
        onGenerate={() => handleGenerate(track.handle.id)}
        onShuffle={() => handleShuffle(track.handle.id)}
        onCopy={() => handleCopy(track.handle.id)}
        onDelete={() => handleDeleteTrack(track.handle.id)}
        onMuteToggle={() => handleMuteToggle(track.handle.id)}
        onSoloToggle={() => handleSoloToggle(track.handle.id)}
        onVolumeChange={(vol: number) => handleVolumeChange(track.handle.id, vol)}
        onPanChange={(pan: number) => handlePanChange(track.handle.id, pan)}
        onFxToggle={(cat: FxCategory, enabled: boolean) => handleFxToggle(track.handle.id, cat, enabled)}
        onFxPresetChange={(cat: FxCategory, idx: number) => handleFxPresetChange(track.handle.id, cat, idx)}
        onFxDryWetChange={(cat: FxCategory, val: number) => handleFxDryWetChange(track.handle.id, cat, val)}
        onToggleFxDrawer={() => toggleFxDrawer(track.handle.id)}
        onProgressChange={(pct: number) => handleProgressChange(track.handle.id, pct)}
        accentColor={DRUM_ACCENT_COLOR}
        instrumentName={track.instrumentName ?? (track.samplePath ? sampleNameForDisplay(track.samplePath) : null)}
        // Drum tracks are pinned to the built-in sampler — no instrument PICKER.
        // The ▾ button opens the drawer to History (no "Pick" tab, since
        // onInstrumentSelect / availableInstruments are intentionally omitted).
        onToggleDrawer={() => handleToggleDrawer(track.handle.id)}
        // --- Sound history: the drawer's History tab (restore + favorite) ---
        soundHistory={soundHistory.list(track.handle.id).entries}
        soundHistoryCursor={soundHistory.list(track.handle.id).cursor}
        onRestoreSound={(i: number) => { void soundHistory.restoreTo(track.handle.id, i); }}
        onToggleFavorite={(i: number) => soundHistory.toggleFavorite(track.handle.id, i)}
        onImportSound={() => setSoundImportTarget(track)}
        importSoundLabel="Import Sample"
        editNotes={track.editNotes}
        onNotesChange={(notes) => handleNotesChange(track.handle.id, notes)}
        editBars={track.editBars}
        editBpm={track.editBpm}
        editSnap={0.25}
        onAuditionNote={(pitch, vel, ms) => { void host.auditionNote(track.handle.id, pitch, vel, ms); }}
      />
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function pluginFxToToggleFx(sdkState: PluginTrackFxDetailState): TrackFxDetailState {
  const result = { ...EMPTY_FX_DETAIL_STATE };
  for (const category of ['eq', 'compressor', 'chorus', 'phaser', 'delay', 'reverb'] as const) {
    const sdkCat = sdkState[category] as PluginFxCategoryDetailState | undefined;
    if (sdkCat) {
      result[category] = {
        enabled: sdkCat.enabled,
        presetIndex: sdkCat.presetIndex,
        dryWet: sdkCat.dryWet,
      };
    }
  }
  return result;
}

/** Pretty filename for display in the TrackRow ("kick-12345.wav" → "kick 12345"). */
function sampleNameForDisplay(samplePath: string): string {
  const base = samplePath.split('/').pop() ?? samplePath;
  return base.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

export default DrumGeneratorPanel;
