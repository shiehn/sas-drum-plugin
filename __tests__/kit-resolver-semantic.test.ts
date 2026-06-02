/**
 * Query-aware kit-resolver tests.
 *
 * Verifies the semantic pick path (bias toward the prompt-matching sample)
 * AND — critically — that the historical behavior is untouched: a pick with
 * no query reads no sidecars and stays uniform-random, and a query with no
 * token overlap falls back to random rather than failing.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createKitResolver } from '../src/kit-resolver';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

const WAVS = ['/lib/kick/k1.wav', '/lib/kick/k2.wav', '/lib/kick/k3.wav'];

const PROMPTS: Record<string, string> = {
  '/lib/kick/k1.txt': 'tight 909-style kick drum one shot, hard click transient, dry, no loop',
  '/lib/kick/k2.txt': 'deep 808-style kick one shot, long sub bass decay, smooth sine low end',
  '/lib/kick/k3.txt': 'boom bap kick one shot, dusty sampler texture, vintage character, dry',
};

function makeHost(): { host: PluginHost; readTextFile: jest.Mock } {
  const listAudioFiles = jest.fn(async () => WAVS);
  const readTextFile = jest.fn(async (p: string) => PROMPTS[p] ?? null);
  const host = { listAudioFiles, readTextFile } as unknown as PluginHost;
  return { host, readTextFile: readTextFile as unknown as jest.Mock };
}

describe('kit-resolver query-aware pick', () => {
  let host: PluginHost;
  let readTextFile: jest.Mock;

  beforeEach(() => {
    ({ host, readTextFile } = makeHost());
  });

  it('biases toward the prompt-matching sample for a "dusty vintage boom bap" query', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', { query: 'dusty vintage boom bap' });
    expect(picked).toBe('/lib/kick/k3.wav');
  });

  it('matches "deep sub 808" to the 808 sample', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', { query: 'deep sub 808' });
    expect(picked).toBe('/lib/kick/k2.wav');
  });

  it('no-query pick stays uniform random and reads NO sidecars (regression guard)', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick');
    expect(picked).toBe('/lib/kick/k1.wav'); // rng=0 → first of pool
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('falls back to random when the query has no token overlap (no signal)', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', { query: 'xylophone harpsichord bagpipes' });
    expect(picked).toBe('/lib/kick/k1.wav'); // no signal → uniform random, rng=0 → first
  });

  it('still accepts a bare Set as excludePaths (historical signature)', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', new Set(['/lib/kick/k1.wav']));
    expect(picked).toBe('/lib/kick/k2.wav'); // k1 excluded → random over [k2,k3], rng=0 → k2
  });

  it('honors excludePaths together with a query', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', {
      query: 'dusty vintage boom bap',
      excludePaths: new Set(['/lib/kick/k3.wav']), // exclude the best match
    });
    expect(picked).not.toBe('/lib/kick/k3.wav');
    expect(WAVS).toContain(picked);
  });

  it('caches sidecar reads per role across repeated query picks', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    await resolver.pick('kick', { query: 'boom bap' });
    await resolver.pick('kick', { query: 'deep sub' });
    expect(readTextFile).toHaveBeenCalledTimes(WAVS.length); // 3 reads total, not 6
  });

  it('returns null for an unknown role', async () => {
    const resolver = createKitResolver(host, '/lib', { rng: () => 0 });
    expect(await resolver.pick('triangle', { query: 'anything' })).toBeNull();
  });

  it('survives a sidecar read error by falling back to random', async () => {
    const listAudioFiles = jest.fn(async () => WAVS);
    const readTextFile = jest.fn(async () => {
      throw new Error('disk hiccup');
    });
    const errHost = { listAudioFiles, readTextFile } as unknown as PluginHost;
    const resolver = createKitResolver(errHost, '/lib', { rng: () => 0 });
    const picked = await resolver.pick('kick', { query: 'boom bap' });
    expect(picked).toBe('/lib/kick/k1.wav'); // all prompts '' → no signal → random
  });
});
