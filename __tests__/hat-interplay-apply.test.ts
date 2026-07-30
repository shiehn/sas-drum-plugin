/**
 * Orchestrator tests against a mock PluginHost: lazy source migration,
 * write-only-changed clips, clearMidi on fully-suppressed tracks, group
 * signature maintenance, and the membership-change kit re-arm.
 */

import type { PluginHost, PluginMidiNote, PluginTrackHandle } from '@signalsandsorcery/plugin-sdk';
import {
  HAT_GROUP_SIG_KEY,
  applyHatInterplay,
  hatSourceKey,
} from '../src/hat-interplay-apply';
import type { HatClipEnvelope, HatSourceData } from '../src/hat-interplay-apply';

const SCENE = 'scene-1';
const ENVELOPE: HatClipEnvelope = { endTimeSeconds: 8, tempo: 120, clipLengthBeats: 4 };

function note(startBeat: number, durationBeats = 0.15, velocity = 100): PluginMidiNote {
  return { pitch: 60, startBeat, durationBeats, velocity };
}

interface MockTrack {
  handle: PluginTrackHandle;
  clipNotes: PluginMidiNote[];
}

function makeHost(tracks: MockTrack[], sceneData: Map<string, unknown>) {
  const writes: Array<{ trackId: string; notes: PluginMidiNote[] }> = [];
  const clears: string[] = [];
  const kitReArms: Array<{ trackId: string; samplePath: string; restore?: boolean }> = [];
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
    setTrackDrumKit: jest.fn(async (trackId: string, kit: { samplePath: string; restore?: boolean }) => {
      kitReArms.push({ trackId, ...kit });
    }),
  };
  return { host: host as unknown as PluginHost, writes, clears, kitReArms, raw: host };
}

function handle(dbId: string, role: string): PluginTrackHandle {
  return { id: `engine-${dbId}`, dbId, name: dbId, role };
}

function storedSource(notes: PluginMidiNote[]): HatSourceData {
  return { version: 1, notes, updatedAt: 1 };
}

describe('applyHatInterplay', () => {
  it('lazily captures a legacy track\'s clip as its source, once', async () => {
    const closedNotes = [note(0), note(0.5), note(1)];
    const sceneData = new Map<string, unknown>();
    const { host } = makeHost([{ handle: handle('closed', 'hat-closed'), clipNotes: closedNotes }], sceneData);

    await applyHatInterplay(host, SCENE, ENVELOPE);

    const captured = sceneData.get(hatSourceKey('closed')) as HatSourceData;
    expect(captured.version).toBe(1);
    expect(captured.notes).toEqual(closedNotes);
  });

  it('rewrites only clips whose projection changed', async () => {
    const closedNotes = [note(0), note(0.5), note(1), note(1.5)];
    const sceneData = new Map<string, unknown>([
      [hatSourceKey('closed'), storedSource(closedNotes)],
      [hatSourceKey('open'), storedSource([note(1, 0.2, 110)])],
    ]);
    const { host, writes, clears } = makeHost(
      [
        { handle: handle('closed', 'hat-closed'), clipNotes: closedNotes },
        { handle: handle('open', 'hat-open'), clipNotes: [] },
      ],
      sceneData,
    );

    const outcome = await applyHatInterplay(host, SCENE, ENVELOPE);

    // Closed loses its hit at beat 1 → rewritten; open gets its computed ring.
    const closedOutcome = outcome.members.find(m => m.dbId === 'closed')!;
    expect(closedOutcome.rewritten).toBe(true);
    expect(closedOutcome.suppressedCount).toBe(1);
    const openOutcome = outcome.members.find(m => m.dbId === 'open')!;
    expect(openOutcome.rewritten).toBe(true);
    expect(openOutcome.notes[0].durationBeats).toBeCloseTo(0.5, 6); // rings to 1.5

    expect(writes.map(w => w.trackId).sort()).toEqual(['engine-closed', 'engine-open']);
    expect(clears).toEqual([]);

    // Second apply with nothing changed → no further writes.
    writes.length = 0;
    const again = await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(again.members.every(m => !m.rewritten)).toBe(true);
    expect(writes).toEqual([]);
  });

  it('clears the clip of a fully-suppressed track instead of writing zero notes', async () => {
    const sceneData = new Map<string, unknown>([
      [hatSourceKey('closed'), storedSource([note(2)])],
      [hatSourceKey('open'), storedSource([note(2, 0.2, 110)])],
    ]);
    const { host, clears } = makeHost(
      [
        { handle: handle('closed', 'hat-closed'), clipNotes: [note(2)] },
        { handle: handle('open', 'hat-open'), clipNotes: [] },
      ],
      sceneData,
    );

    await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(clears).toEqual(['engine-closed']);
  });

  it('suppressed hits restore when the open track leaves the group', async () => {
    const closedNotes = [note(0), note(0.5)];
    const sceneData = new Map<string, unknown>([
      [hatSourceKey('closed'), storedSource(closedNotes)],
      [HAT_GROUP_SIG_KEY, 'closed:closed,open:open'],
    ]);
    // The open track was deleted — only the closed member remains, its clip
    // still holding the projection from when the open suppressed beat 0.
    const { host, writes } = makeHost(
      [{ handle: handle('closed', 'hat-closed'), clipNotes: [note(0.5)] }],
      sceneData,
    );

    await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(writes).toHaveLength(1);
    expect(writes[0].notes.map(n => n.startBeat)).toEqual([0, 0.5]);
  });

  it('re-arms member kits (restore:true) when the group signature changes', async () => {
    const sceneData = new Map<string, unknown>([
      [hatSourceKey('open'), storedSource([note(0)])],
      ['track:open:samplePath', '/packs/drums/hat-open/oh-1.wav'],
    ]);
    const { host, kitReArms } = makeHost(
      [{ handle: handle('open', 'hat-open'), clipNotes: [] }],
      sceneData,
    );

    await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(kitReArms).toEqual([
      { trackId: 'engine-open', samplePath: '/packs/drums/hat-open/oh-1.wav', restore: true },
    ]);
    expect(sceneData.get(HAT_GROUP_SIG_KEY)).toBe('open:open');

    // Same membership on the next apply → no re-arm churn.
    kitReArms.length = 0;
    await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(kitReArms).toEqual([]);
  });

  it('deletes a stale group signature when no hat members remain', async () => {
    const sceneData = new Map<string, unknown>([[HAT_GROUP_SIG_KEY, 'open:open']]);
    const { host } = makeHost([{ handle: handle('kick-1', 'kick'), clipNotes: [note(0)] }], sceneData);

    const outcome = await applyHatInterplay(host, SCENE, ENVELOPE);
    expect(outcome.members).toEqual([]);
    expect(sceneData.has(HAT_GROUP_SIG_KEY)).toBe(false);
  });
});
