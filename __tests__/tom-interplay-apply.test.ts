/**
 * Tom orchestrator tests against a mock PluginHost: lazy source migration,
 * write-only-changed clips, clearMidi on fully-suppressed tracks, group
 * signature lifecycle — and the structural difference from hats: NO kit
 * re-arm ever (toms don't change the sampler's openEnded flag).
 */

import type { PluginHost, PluginMidiNote, PluginTrackHandle } from '@signalsandsorcery/plugin-sdk';
import {
  TOM_GROUP_SIG_KEY,
  applyTomInterplay,
  tomSourceKey,
} from '../src/tom-interplay-apply';
import type { TomClipEnvelope, TomSourceData } from '../src/tom-interplay-apply';

const SCENE = 'scene-1';
const ENVELOPE: TomClipEnvelope = { endTimeSeconds: 8, tempo: 120, clipLengthBeats: 4 };

function note(startBeat: number, velocity = 100, durationBeats = 0.15): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

interface MockTrack {
  handle: PluginTrackHandle;
  clipNotes: PluginMidiNote[];
}

function makeHost(tracks: MockTrack[], sceneData: Map<string, unknown>) {
  const writes: Array<{ trackId: string; notes: PluginMidiNote[] }> = [];
  const clears: string[] = [];
  const host = {
    getPluginTracks: jest.fn(async () => tracks.map(t => t.handle)),
    readMidiNotes: jest.fn(async (trackId: string) => {
      const track = tracks.find(t => t.handle.id === trackId);
      if (!track || track.clipNotes.length === 0) return { clips: [] };
      return { clips: [{ startTime: 0, endTime: ENVELOPE.endTimeSeconds, notes: track.clipNotes }] };
    }),
    getSceneData: jest.fn(async (_sceneId: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_sceneId: string, key: string, value: unknown) => {
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async (_sceneId: string, key: string) => {
      sceneData.delete(key);
    }),
    writeMidiClip: jest.fn(async (trackId: string, clip: { notes: PluginMidiNote[] }) => {
      writes.push({ trackId, notes: clip.notes });
      const track = tracks.find(t => t.handle.id === trackId);
      if (track) track.clipNotes = clip.notes;
    }),
    clearMidi: jest.fn(async (trackId: string) => {
      clears.push(trackId);
      const track = tracks.find(t => t.handle.id === trackId);
      if (track) track.clipNotes = [];
    }),
    setTrackDrumKit: jest.fn(),
  };
  return { host: host as unknown as PluginHost, writes, clears, raw: host };
}

function handle(dbId: string, role: string): PluginTrackHandle {
  return { id: `engine-${dbId}`, dbId, name: dbId, role };
}

function storedSource(notes: PluginMidiNote[]): TomSourceData {
  return { version: 1, notes, updatedAt: 1 };
}

describe('applyTomInterplay', () => {
  it("lazily captures a pre-feature track's clip as its source, once", async () => {
    const lowNotes = [note(0), note(1), note(2)];
    const sceneData = new Map<string, unknown>();
    const { host } = makeHost([{ handle: handle('low', 'tom-low'), clipNotes: lowNotes }], sceneData);

    await applyTomInterplay(host, SCENE, ENVELOPE);

    const captured = sceneData.get(tomSourceKey('low')) as TomSourceData;
    expect(captured.version).toBe(1);
    expect(captured.notes).toEqual(lowNotes);
  });

  it('rewrites only clips whose projection changed', async () => {
    const sceneData = new Map<string, unknown>();
    // hi collides with (louder) mid at beat 0 → hi's projection loses a note.
    // low sits alone at beat 3 → its projection equals its clip, no rewrite.
    sceneData.set(tomSourceKey('hi'), storedSource([note(0, 90), note(1, 90)]));
    sceneData.set(tomSourceKey('mid'), storedSource([note(0, 120), note(0.05, 110)]));
    sceneData.set(tomSourceKey('low'), storedSource([note(3, 100)]));
    const { host, writes, clears } = makeHost(
      [
        { handle: handle('hi', 'tom-hi'), clipNotes: [note(0, 90), note(1, 90)] },
        { handle: handle('mid', 'tom-mid'), clipNotes: [note(0, 120), note(0.05, 110)] },
        { handle: handle('low', 'tom-low'), clipNotes: [note(3, 100)] },
      ],
      sceneData,
    );

    await applyTomInterplay(host, SCENE, ENVELOPE);

    expect(clears).toEqual([]);
    expect(writes.map(w => w.trackId)).toEqual(['engine-hi']);
    expect(writes[0].notes).toEqual([note(1, 90)]);
  });

  it('clearMidi on a fully-suppressed track, and re-resolving restores it after the colliders go', async () => {
    const sceneData = new Map<string, unknown>();
    sceneData.set(tomSourceKey('hi'), storedSource([note(0, 120)]));
    sceneData.set(tomSourceKey('mid'), storedSource([note(0, 110)]));
    sceneData.set(tomSourceKey('low'), storedSource([note(0, 80)]));
    const tracks = [
      { handle: handle('hi', 'tom-hi'), clipNotes: [note(0, 120)] },
      { handle: handle('mid', 'tom-mid'), clipNotes: [note(0, 110)] },
      { handle: handle('low', 'tom-low'), clipNotes: [note(0, 80)] },
    ];
    const { host, clears } = makeHost(tracks, sceneData);
    await applyTomInterplay(host, SCENE, ENVELOPE);
    expect(clears).toEqual(['engine-low']);

    // The two louder tracks are deleted — the suppressed hit must come back.
    tracks.splice(0, 2);
    const second = await applyTomInterplay(host, SCENE, ENVELOPE);
    const low = second.members.find(m => m.dbId === 'low')!;
    expect(low.notes).toEqual([note(0, 80)]);
    expect(low.rewritten).toBe(true);
  });

  it('maintains the group signature, deletes it when the group empties, and NEVER re-arms kits', async () => {
    const sceneData = new Map<string, unknown>();
    // samplePath present so a hat-style re-arm WOULD have something to re-arm.
    sceneData.set('track:low:samplePath', '/samples/tom-low/t1.wav');
    const tracks = [{ handle: handle('low', 'tom-low'), clipNotes: [note(0)] }];
    const { host, raw } = makeHost(tracks, sceneData);

    await applyTomInterplay(host, SCENE, ENVELOPE);
    expect(sceneData.get(TOM_GROUP_SIG_KEY)).toBe('low:tom-low');
    // The structural difference from applyHatInterplay: no kit re-arm.
    expect(raw.setTrackDrumKit).not.toHaveBeenCalled();

    tracks.splice(0, 1);
    await applyTomInterplay(host, SCENE, ENVELOPE);
    expect(sceneData.has(TOM_GROUP_SIG_KEY)).toBe(false);
    expect(raw.setTrackDrumKit).not.toHaveBeenCalled();
  });

  it('leaves scenes with no toms and no signature completely untouched', async () => {
    const sceneData = new Map<string, unknown>();
    const { host, raw } = makeHost([{ handle: handle('kick', 'kick'), clipNotes: [note(0)] }], sceneData);

    const outcome = await applyTomInterplay(host, SCENE, ENVELOPE);

    expect(outcome.members).toEqual([]);
    expect(sceneData.size).toBe(0);
    expect(raw.writeMidiClip).not.toHaveBeenCalled();
    expect(raw.clearMidi).not.toHaveBeenCalled();
  });

  it('excludes FILL tracks from the tom group (fills rotate on their own)', async () => {
    const tomNotes = [note(0), note(1)];
    const fillNotes = [note(3, 0.15, 110), note(3.25, 0.15, 112), note(3.5, 0.15, 115)];
    const sceneData = new Map<string, unknown>([
      ['track:filltom:fill', { version: 1, fillId: 'f1', fillName: 'Tom cascade', fillPrompt: null, unitOrder: 0, role: 'tom-low', sourceTrackDbId: 'low', createdAt: 1 }],
    ]);
    const { host, writes } = makeHost(
      [
        { handle: handle('low', 'tom-low'), clipNotes: tomNotes },
        { handle: handle('filltom', 'tom-low'), clipNotes: fillNotes },
      ],
      sceneData,
    );

    await applyTomInterplay(host, SCENE, ENVELOPE);

    expect(sceneData.get(tomSourceKey('filltom'))).toBeUndefined();
    expect(writes.find(w => w.trackId === 'engine-filltom')).toBeUndefined();
    expect(sceneData.get(tomSourceKey('low'))).toBeDefined();
  });
});
