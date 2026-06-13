/**
 * Multi-root kit-resolver tests (local-samples spike, Phase 0).
 *
 * The resolver must scan the distributed pack root AND every user-imported
 * pack root, merging their role pools into one. These tests pin the
 * origin-agnostic contract that the rest of the drum panel relies on:
 * downstream code (generate, shuffle, role discovery) never learns which root
 * a sample came from — it just sees a bigger pool per role.
 *
 * The host mock returns DIFFERENT file lists per root path, so a merge bug
 * (e.g. last-root-wins instead of concat) is observable.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createKitResolver, type SampleRootSource } from '../src/kit-resolver';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

/** Per-root file tables — keyed by the root path passed to listAudioFiles. */
const DISTRIBUTED = '/packs/drums';
const USER_A = '/user/drums/vintage-breaks';
const USER_B = '/user/drums/trap-kit';

const FILES_BY_ROOT: Record<string, string[]> = {
  [DISTRIBUTED]: [
    '/packs/drums/kick/d-kick-1.wav',
    '/packs/drums/kick/d-kick-2.wav',
    '/packs/drums/snare-standard/d-snare-1.wav',
  ],
  [USER_A]: [
    '/user/drums/vintage-breaks/kick/vb-kick-1.wav',
    '/user/drums/vintage-breaks/snare-standard/vb-snare-1.wav',
    '/user/drums/vintage-breaks/foley-perc/vb-shaker-1.wav', // role only this pack has
  ],
  [USER_B]: [
    '/user/drums/trap-kit/kick/tk-kick-1.wav',
    '/user/drums/trap-kit/808/tk-808-1.wav', // role only this pack has
  ],
};

function makeHost(): { host: PluginHost; listAudioFiles: jest.Mock } {
  const listAudioFiles = jest.fn(async (root: string) => FILES_BY_ROOT[root] ?? []);
  const readTextFile = jest.fn(async () => null);
  const host = { listAudioFiles, readTextFile } as unknown as PluginHost;
  return { host, listAudioFiles: listAudioFiles as unknown as jest.Mock };
}

/** Collect every path a role can yield by exhausting the pool via excludePaths. */
async function drainRole(
  host: PluginHost,
  source: SampleRootSource,
  role: string,
): Promise<Set<string>> {
  const resolver = createKitResolver(host, source, { rng: () => 0 });
  const seen = new Set<string>();
  // Pull at most 50 times; each pick excludes everything seen so far, so the
  // pool drains deterministically and we stop when pick returns null.
  for (let i = 0; i < 50; i += 1) {
    const picked = await resolver.pick(role, seen);
    if (!picked) break;
    seen.add(picked);
  }
  return seen;
}

describe('kit-resolver multi-root', () => {
  it('merges role pools across a string[] of roots', async () => {
    const { host } = makeHost();
    const kicks = await drainRole(host, [DISTRIBUTED, USER_A, USER_B], 'kick');
    expect(kicks).toEqual(
      new Set([
        '/packs/drums/kick/d-kick-1.wav',
        '/packs/drums/kick/d-kick-2.wav',
        '/user/drums/vintage-breaks/kick/vb-kick-1.wav',
        '/user/drums/trap-kit/kick/tk-kick-1.wav',
      ]),
    );
  });

  it('merges role pools when the source is an async fn returning string[]', async () => {
    const { host } = makeHost();
    const source = async (): Promise<string[]> => [DISTRIBUTED, USER_A];
    const snares = await drainRole(host, source, 'snare-standard');
    expect(snares).toEqual(
      new Set([
        '/packs/drums/snare-standard/d-snare-1.wav',
        '/user/drums/vintage-breaks/snare-standard/vb-snare-1.wav',
      ]),
    );
  });

  it('surfaces a role that ONLY a user pack provides', async () => {
    const { host } = makeHost();
    const shakers = await drainRole(host, [DISTRIBUTED, USER_A], 'foley-perc');
    expect(shakers).toEqual(new Set(['/user/drums/vintage-breaks/foley-perc/vb-shaker-1.wav']));
  });

  it('getDiscoveredRoles returns the UNION of folders across all roots, sorted', async () => {
    const { host } = makeHost();
    const resolver = createKitResolver(host, [DISTRIBUTED, USER_A, USER_B], { rng: () => 0 });
    const roles = await resolver.getDiscoveredRoles();
    expect(roles).toEqual(['808', 'foley-perc', 'kick', 'snare-standard']);
  });

  it('skips a root whose listing throws but still scans the others', async () => {
    const listAudioFiles = jest.fn(async (root: string) => {
      if (root === DISTRIBUTED) throw new Error('disk hiccup on stock pack');
      return FILES_BY_ROOT[root] ?? [];
    });
    const host = { listAudioFiles, readTextFile: jest.fn(async () => null) } as unknown as PluginHost;
    const kicks = await drainRole(host, [DISTRIBUTED, USER_A], 'kick');
    // Distributed kicks are gone (that root threw); user kicks survive.
    expect(kicks).toEqual(new Set(['/user/drums/vintage-breaks/kick/vb-kick-1.wav']));
  });

  it('de-duplicates identical root paths (no double-counted samples)', async () => {
    const { host, listAudioFiles } = makeHost();
    const resolver = createKitResolver(host, [USER_A, USER_A], { rng: () => 0 });
    const roles = await resolver.getDiscoveredRoles();
    expect(roles).toEqual(['foley-perc', 'kick', 'snare-standard']);
    // The duplicate root must not be listed twice.
    expect(listAudioFiles).toHaveBeenCalledTimes(1);
  });

  it('treats a null/empty source as no library (empty roles, null picks)', async () => {
    const { host, listAudioFiles } = makeHost();
    const resolver = createKitResolver(host, async () => null, { rng: () => 0 });
    expect(await resolver.getDiscoveredRoles()).toEqual([]);
    expect(await resolver.pick('kick')).toBeNull();
    expect(listAudioFiles).not.toHaveBeenCalled();
  });

  it('filters falsy entries (e.g. a null distributed root) out of the array', async () => {
    const { host } = makeHost();
    // Mirrors the panel: distributed pack missing → null, user packs present.
    const source = async (): Promise<string[]> =>
      [null as unknown as string, USER_A, USER_B].filter(
        (r): r is string => typeof r === 'string' && r.length > 0,
      );
    const kicks = await drainRole(host, source, 'kick');
    expect(kicks).toEqual(
      new Set([
        '/user/drums/vintage-breaks/kick/vb-kick-1.wav',
        '/user/drums/trap-kit/kick/tk-kick-1.wav',
      ]),
    );
  });
});
