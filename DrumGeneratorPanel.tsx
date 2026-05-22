/**
 * DrumGeneratorPanel — UI for the @signalsandsorcery/drum-generator plugin.
 *
 * Mirrors SynthGeneratorPanel chrome (TrackRow, shuffle, FX drawer, instrument
 * drawer) but generates drum-pattern MIDI and loads the engine's built-in
 * drum sampler (sas.drum-sampler) with a sample picked from the configured
 * sample library. MIDI pitch is advisory only — the sampler triggers the
 * loaded sample on every note-on.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { TrackRow, useSceneState, SorceryProgressBar, EMPTY_FX_DETAIL_STATE, formatConcurrentTracks } from '@signalsandsorcery/plugin-sdk';
import { buildDrumSystemPrompt } from './src/drum-system-prompt';
// Phase 0.8: role taxonomy is FS-discovered via kitResolver.getDiscoveredRoles()
// — the previous hardcoded role-mapping.ts has been retired (kept only as a
// tombstone module). The drum panel fetches the live role list at mount and
// passes it to buildDrumSystemPrompt so the LLM is constrained to whatever
// folders actually exist under the library root.
import { createKitResolver } from './src/kit-resolver';

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
  fxDrawerOpen: boolean;
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  instrumentPluginId: string | null;
  instrumentName: string | null;
  instrumentMissing: boolean;
  instrumentDrawerOpen: boolean;
  instrumentDrawerStage: 'instruments' | 'editor';
}

interface LLMDrumResponse {
  notes: PluginMidiNote[];
  role?: string;
  // subRole removed in Phase 0.8 — role is the folder name (flat taxonomy)
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
}: PluginUIProps): React.ReactElement {
  const [tracks, setTracks] = useState<DrumTrackState[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [isComposing, , setIsComposingForScene] = useSceneState(activeSceneId, false);
  const [placeholders, , setPlaceholdersForScene] = useSceneState<BulkAddPlaceholderTrack[]>(activeSceneId, EMPTY_PLACEHOLDERS);
  const saveTimeoutRefs = useRef<Record<string, NodeJS.Timeout>>({});
  const [availableInstruments, setAvailableInstruments] = useState<InstrumentDescriptor[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(false);
  const engineToDbIdRef = useRef<Map<string, string>>(new Map());
  const [kitResolver] = useState(() =>
    createKitResolver(host, () => host.getBundledResourcePath('drum-samples')),
  );

  // Phase 0.8: live drum-role vocabulary discovered from the library FS.
  // Populated by an effect on mount + when the resolver gets reset; fed
  // into buildDrumSystemPrompt(...) so the LLM is constrained to actual
  // on-disk folder names. Empty until the first scan completes.
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);
  useEffect(() => {
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
  }, [kitResolver]);

  // --- Load tracks when scene changes -----------------------------------
  const tracksLoadedForSceneRef = useRef<string | null>(null);
  const loadTracks = useCallback(async (incremental = false): Promise<void> => {
    const sceneAtStart = activeSceneId;
    if (!sceneAtStart) {
      setTracks([]);
      tracksLoadedForSceneRef.current = null;
      return;
    }

    if (!incremental && tracksLoadedForSceneRef.current !== sceneAtStart) {
      setTracks([]);
    }
    tracksLoadedForSceneRef.current = sceneAtStart;

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
          fxDrawerOpen: false,
          isGenerating: false,
          error: null,
          hasMidi,
          generationProgress: 0,
          instrumentPluginId: handle.instrumentPluginId ?? null,
          instrumentName: handle.instrumentName ?? null,
          instrumentMissing,
          instrumentDrawerOpen: false,
          instrumentDrawerStage: 'instruments',
        });
      }
      if (isStale()) return;
      setTracks(trackStates);
    } catch (error: unknown) {
      console.error('[DrumGeneratorPanel] Failed to load tracks:', error);
    } finally {
      if (tracksLoadedForSceneRef.current === sceneAtStart) {
        setIsLoadingTracks(false);
      }
    }
  }, [host, activeSceneId]);

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
        fxDrawerOpen: false,
        isGenerating: false,
        error: null,
        hasMidi: false,
        generationProgress: 0,
        instrumentPluginId: null,
        instrumentName: null,
        instrumentMissing: false,
        instrumentDrawerOpen: false,
        instrumentDrawerStage: 'instruments',
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
  useEffect(() => {
    if (!onHeaderContent) return;
    const addDisabled =
      needsContract ||
      !isConnected ||
      !activeSceneId ||
      tracks.length >= MAX_TRACKS ||
      isAddingTrack;

    onHeaderContent(
      <div className="flex gap-1">
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
          + Add
        </button>
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, sceneContext, isConnected, isAddingTrack,
      needsContract, activeSceneId, tracks.length, handleAddTrack, onOpenContract]);

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
          ? { ...t, isGenerating: false, error: null, role: newRole, samplePath: newSamplePath, hasMidi: true, generationProgress: 0, shuffleHistory: freshHistory }
          : t
      ));
      host.showToast('success', 'Drum pattern generated');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Generation failed';
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, isGenerating: false, error: msg, generationProgress: 0 } : t
      ));
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, activeSceneId, availableRoles, kitResolver]);

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Shuffle failed';
      host.showToast('error', 'Shuffle failed', msg);
    }
  }, [host, tracks, activeSceneId, kitResolver]);

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
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, fxDrawerOpen: !t.fxDrawerOpen, instrumentDrawerOpen: false, instrumentDrawerStage: 'instruments' as const } : t
    ));
    const track = tracks.find(t => t.handle.id === trackId);
    if (track && !track.fxDrawerOpen) {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  const handleProgressChange = useCallback((trackId: string, pct: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, generationProgress: pct } : t
    ));
  }, []);

  // --- Instrument selection callbacks ------------------------------------
  const toggleInstrumentDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map((t: DrumTrackState) => {
      if (t.handle.id !== trackId) return t;
      const opening = !t.instrumentDrawerOpen;
      const stage = opening && t.instrumentPluginId ? 'editor' as const : 'instruments' as const;
      return { ...t, instrumentDrawerOpen: opening, fxDrawerOpen: false, instrumentDrawerStage: stage };
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
        t.handle.id === trackId ? { ...t, instrumentDrawerOpen: false, instrumentDrawerStage: 'instruments' as const } : t
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
      t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'editor' as const } : t
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
        t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'instruments' as const } : t
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
      t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'instruments' as const } : t
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
    return (
      <div data-testid="no-contract-placeholder-drum" className="flex items-center justify-center py-8">
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

  return (
    <div data-testid="drum-section" className="p-2 space-y-2">
      {isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        tracks.map((track: DrumTrackState) => renderTrackRow(track))
      )}

      {!isLoadingTracks && tracks.length > 0 && (() => {
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

  function renderTrackRow(track: DrumTrackState): React.ReactElement {
    return (
      <TrackRow
        key={track.handle.id}
        track={{ id: track.handle.id, name: track.handle.name, role: track.role }}
        prompt={track.prompt}
        runtimeState={{
          muted: track.runtimeState.muted,
          solo: track.runtimeState.solo,
          volume: track.runtimeState.volume,
          pan: track.runtimeState.pan,
        }}
        fxDetailState={track.fxDetailState}
        fxDrawerOpen={track.fxDrawerOpen}
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
        // Drum tracks are pinned to the built-in sampler — the user can't pick a
        // different instrument plugin. Omitting onToggleInstrumentDrawer (per the
        // SDK's TrackRow contract) hides the "P" button entirely; the remaining
        // instrument-drawer props (availableInstruments, currentInstrumentPluginId,
        // instrumentDrawerOpen/Stage, onInstrumentSelect, onShowEditor, etc.)
        // would be dead without that toggle, so they're dropped too. The
        // instrumentName display above is kept — it still shows which sample
        // is loaded as a passive label.
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

function parseLLMDrumResponse(content: string): LLMDrumResponse | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null || !('notes' in parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.notes)) {
      return null;
    }

    const validNotes: PluginMidiNote[] = [];
    for (const raw of obj.notes) {
      if (typeof raw !== 'object' || raw === null) continue;
      const note = raw as Record<string, unknown>;

      const pitch = typeof note.pitch === 'number' ? note.pitch : NaN;
      const startBeat = typeof note.startBeat === 'number' ? note.startBeat : NaN;
      const durationBeats = typeof note.durationBeats === 'number' ? note.durationBeats : NaN;
      const velocity = typeof note.velocity === 'number' ? note.velocity : NaN;

      if (
        !isNaN(pitch) && pitch >= 0 && pitch <= 127 &&
        !isNaN(startBeat) && startBeat >= 0 &&
        !isNaN(durationBeats) && durationBeats > 0 &&
        !isNaN(velocity) && velocity >= 1 && velocity <= 127
      ) {
        validNotes.push({
          pitch: Math.round(pitch),
          startBeat,
          durationBeats,
          velocity: Math.round(velocity),
        });
      }
    }

    const role = typeof obj.role === 'string' ? obj.role : undefined;
    // subRole removed in Phase 0.8 — if the LLM still emits one (drift while
    // the prompt change propagates), we ignore it; the role field now carries
    // the literal folder name.

    return { notes: validNotes, role };
  } catch {
    return null;
  }
}

/** Pretty filename for display in the TrackRow ("kick-12345.wav" → "kick 12345"). */
function sampleNameForDisplay(samplePath: string): string {
  const base = samplePath.split('/').pop() ?? samplePath;
  return base.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

export default DrumGeneratorPanel;
