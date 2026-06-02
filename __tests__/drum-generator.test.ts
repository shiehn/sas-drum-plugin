/**
 * Drum-generator plugin internals — kit resolver + prompt builder.
 *
 * Phase 0.8 redesign: the hardcoded role-mapping taxonomy was retired
 * (kicks/snares/hats/clap/perc + subRoles). Roles are now FS-discovered:
 * each folder under the drum library root IS a role. The kit resolver
 * walks the library to enumerate roles, and the LLM prompt builder
 * takes the live role list as a parameter.
 *
 * Host-side `setTrackDrumKit` + `listAudioFiles` integration is covered
 * in `sas-app/src/main/services/__tests__/plugin-host-drum-kit.test.ts`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { buildDrumSystemPrompt } from '../src/drum-system-prompt';
import { createKitResolver } from '../src/kit-resolver';
import { formatConcurrentTracks } from '@signalsandsorcery/plugin-sdk';
import type { PluginHost, PluginGenerationContext } from '@signalsandsorcery/plugin-sdk';

describe('buildDrumSystemPrompt', () => {
  const SAMPLE_ROLES = ['kick', 'snare-standard', 'hat-closed', 'hat-open', 'cymbal-crash'];

  it('lists every available role in the prompt', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    for (const role of SAMPLE_ROLES) {
      expect(prompt).toContain(role);
    }
  });

  it('falls back to a clear "empty library" string when no roles are available', () => {
    const prompt = buildDrumSystemPrompt([]);
    expect(prompt).toMatch(/empty library|no drum folders found/i);
  });

  it('instructs the LLM to keep every note at pitch 60 (sampler is one-shot)', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(prompt).toContain('ALWAYS 60');
    expect(prompt).toMatch(/Do not vary pitch|pitch.*neutral/i);
  });

  it('tells the LLM the plugin does not quantize (micro-timing survives)', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(prompt.toLowerCase()).toContain('does not quantize');
  });

  it('tells the LLM that velocity drives sample gain (loud=loud, soft=soft)', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(prompt.toLowerCase()).toMatch(/velocity.*scales.*gain|gain.*velocity/);
  });

  it('does not mention subRole (removed in Phase 0.8)', () => {
    const prompt = buildDrumSystemPrompt(SAMPLE_ROLES);
    expect(prompt.toLowerCase()).not.toContain('subrole');
  });

  it('is deterministic for a given role list', () => {
    expect(buildDrumSystemPrompt(SAMPLE_ROLES)).toBe(buildDrumSystemPrompt(SAMPLE_ROLES));
  });
});

// --- kit-resolver --------------------------------------------------------

type MockHost = Pick<PluginHost, 'listAudioFiles'>;

function makeMockHost(byFolder: Record<string, string[]>): MockHost {
  // listAudioFiles returns ALL paths under rootPath (recursive). The
  // resolver groups by parent folder. We compose paths like:
  // <rootPath>/<folder>/<filename>.
  const ROOT = '/fake/samples';
  const flat: string[] = [];
  for (const [folder, files] of Object.entries(byFolder)) {
    for (const f of files) {
      flat.push(`${ROOT}/${folder}/${f}`);
    }
  }
  return {
    listAudioFiles: jest.fn<PluginHost['listAudioFiles']>().mockImplementation(async (rootPath: string) => {
      // Resolver passes our root through verbatim; return everything in one call.
      if (rootPath === ROOT) return flat;
      return [];
    }),
  };
}

describe('createKitResolver', () => {
  const SAMPLE_ROOT = '/fake/samples';

  it('returns null when the library is empty', async () => {
    const host = makeMockHost({}) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    expect(await resolver.pick('kick')).toBeNull();
  });

  it('returns null when the role (folder) has no samples', async () => {
    const host = makeMockHost({ kick: ['k1.wav'] }) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    expect(await resolver.pick('snare-standard')).toBeNull();
  });

  it('picks a sample from the named folder', async () => {
    const host = makeMockHost({
      'snare-standard': ['s1.wav', 's2.wav'],
      'snare-rim': ['r1.wav'],
      'kick': ['k1.wav'],
    }) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);

    const path = await resolver.pick('snare-standard');
    expect(path).not.toBeNull();
    expect(path).toMatch(/\/snare-standard\//);
    expect(path).not.toMatch(/\/snare-rim\/|\/kick\//);
  });

  it('avoids any excluded path when alternatives exist', async () => {
    const host = makeMockHost({
      kick: ['k1.wav', 'k2.wav', 'k3.wav'],
    }) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    const exclude = new Set<string>([`${SAMPLE_ROOT}/kick/k1.wav`]);
    for (let i = 0; i < 20; i++) {
      const picked = await resolver.pick('kick', exclude);
      expect(picked).not.toBe(`${SAMPLE_ROOT}/kick/k1.wav`);
    }
  });

  it('excludes multiple paths (Set) and cycles through the rest', async () => {
    const host = makeMockHost({
      kick: ['k1.wav', 'k2.wav', 'k3.wav'],
    }) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    const seen = new Set<string>();
    // Pick repeatedly, accumulating the history. After 3 picks the pool
    // is exhausted; the next call must return null (signal to reset).
    for (let i = 0; i < 3; i++) {
      const picked = await resolver.pick('kick', seen);
      expect(picked).not.toBeNull();
      seen.add(picked!);
    }
    expect(seen.size).toBe(3);
    expect(await resolver.pick('kick', seen)).toBeNull();
  });

  it('returns null when every candidate is excluded (signal to reset)', async () => {
    const host = makeMockHost({ kick: ['only.wav'] }) as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    const only = `${SAMPLE_ROOT}/kick/only.wav`;
    expect(await resolver.pick('kick', new Set([only]))).toBeNull();
  });

  it('caches the directory listing — subsequent picks do not re-list', async () => {
    const host = makeMockHost({ kick: ['k1.wav'], 'snare-standard': ['s1.wav'] }) as PluginHost;
    const listSpy = host.listAudioFiles as jest.Mock;
    const resolver = createKitResolver(host, SAMPLE_ROOT);

    await resolver.pick('kick');
    await resolver.pick('kick');
    await resolver.pick('snare-standard');
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first picks into one listing call (no thundering herd)', async () => {
    const host = makeMockHost({ kick: ['k1.wav'] }) as PluginHost;
    const listSpy = host.listAudioFiles as jest.Mock;
    const resolver = createKitResolver(host, SAMPLE_ROOT);

    await Promise.all([
      resolver.pick('kick'),
      resolver.pick('kick'),
      resolver.pick('kick'),
    ]);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('re-scans after reset()', async () => {
    const host = makeMockHost({ kick: ['k1.wav'] }) as PluginHost;
    const listSpy = host.listAudioFiles as jest.Mock;
    const resolver = createKitResolver(host, SAMPLE_ROOT);

    await resolver.pick('kick');
    expect(listSpy).toHaveBeenCalledTimes(1);
    resolver.reset();
    await resolver.pick('kick');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null when host.listAudioFiles throws', async () => {
    const host = {
      listAudioFiles: jest.fn<PluginHost['listAudioFiles']>().mockRejectedValue(new Error('disk gone')),
    } as MockHost as PluginHost;
    const resolver = createKitResolver(host, SAMPLE_ROOT);
    expect(await resolver.pick('kick')).toBeNull();
  });

  describe('getDiscoveredRoles', () => {
    it('returns the sorted list of folder names with audio content', async () => {
      const host = makeMockHost({
        kick: ['k1.wav'],
        'snare-standard': ['s1.wav'],
        'hat-closed': ['h1.wav'],
      }) as PluginHost;
      const resolver = createKitResolver(host, SAMPLE_ROOT);
      expect(await resolver.getDiscoveredRoles()).toEqual(['hat-closed', 'kick', 'snare-standard']);
    });

    it('returns [] for an empty library', async () => {
      const host = makeMockHost({}) as PluginHost;
      const resolver = createKitResolver(host, SAMPLE_ROOT);
      expect(await resolver.getDiscoveredRoles()).toEqual([]);
    });

    it('skips _-prefixed folders (admin / convention)', async () => {
      const host = makeMockHost({
        kick: ['k1.wav'],
        _failures: ['x.wav'],  // admin folder, like instrument-resolver's _failures convention
      }) as PluginHost;
      const resolver = createKitResolver(host, SAMPLE_ROOT);
      expect(await resolver.getDiscoveredRoles()).toEqual(['kick']);
    });

    it('shares the cache with pick() — calling both only lists once', async () => {
      const host = makeMockHost({ kick: ['k1.wav'] }) as PluginHost;
      const listSpy = host.listAudioFiles as jest.Mock;
      const resolver = createKitResolver(host, SAMPLE_ROOT);

      await resolver.pick('kick');
      await resolver.getDiscoveredRoles();
      expect(listSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// --- formatConcurrentTracks (SDK shared helper) -------------------------

describe('formatConcurrentTracks output shape', () => {
  function ctx(overrides: Partial<PluginGenerationContext> = {}): PluginGenerationContext {
    return {
      chordProgression: {
        key: { tonic: 'C', mode: 'minor' },
        chordsWithTiming: [],
        genre: null,
      },
      concurrentTracks: [],
      ...overrides,
    };
  }

  it('returns empty string when no other tracks exist', () => {
    expect(formatConcurrentTracks(ctx())).toBe('');
  });

  it('emits role + prompt + raw-JSON notes per chord segment', () => {
    const output = formatConcurrentTracks(ctx({
      concurrentTracks: [{
        trackId: 'eng-1',
        role: 'bass',
        prompt: 'deep moving sub',
        presetCategory: null,
        notesByChord: [
          {
            chord: 'Cm7',
            chordRangeQn: [0, 4],
            notes: [
              { pitch: 36, startBeat: 0, durationBeats: 0.5, velocity: 100 },
              { pitch: 38, startBeat: 1.5, durationBeats: 0.25, velocity: 90 },
            ],
          },
        ],
      }],
    }));
    expect(output).toContain('Concurrent tracks in scene');
    expect(output).toContain('role=bass');
    expect(output).toContain('prompt="deep moving sub"');
    expect(output).toContain('Cm7 (beats 0-4)');
    // Raw JSON shape includes the four fields the LLM needs (per user's selection)
    expect(output).toContain('"pitch":36');
    expect(output).toContain('"startBeat":0');
    expect(output).toContain('"durationBeats":0.5');
    expect(output).toContain('"velocity":100');
  });

  it('annotates the per-track tail with the truncated-note count', () => {
    const output = formatConcurrentTracks(ctx({
      concurrentTracks: [{
        trackId: 'eng-1',
        role: 'hats',
        prompt: '16ths',
        presetCategory: null,
        notesByChord: [{
          chord: 'Cm',
          chordRangeQn: [0, 4],
          notes: [{ pitch: 60, startBeat: 0, durationBeats: 0.1, velocity: 80 }],
        }],
        truncated: true,
        originalNoteCount: 250,
      }],
    }));
    expect(output).toMatch(/\(249 more notes truncated\)/);
  });

  it('annotates a global truncated-track count when present', () => {
    const output = formatConcurrentTracks(ctx({
      concurrentTracks: [{
        trackId: 'eng-1',
        role: 'kicks',
        prompt: 'k',
        presetCategory: null,
        notesByChord: [],
      }],
      truncatedTrackCount: 3,
    }));
    expect(output).toMatch(/3 additional tracks? omitted/);
  });

  it('escapes embedded quotes in prompts so the LLM block stays parseable', () => {
    const output = formatConcurrentTracks(ctx({
      concurrentTracks: [{
        trackId: 'eng-1',
        role: 'lead',
        prompt: 'punchy "808" lead',
        presetCategory: null,
        notesByChord: [],
      }],
    }));
    expect(output).toContain('prompt="punchy \\"808\\" lead"');
  });
});
