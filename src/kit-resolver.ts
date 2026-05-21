/**
 * Kit resolver — picks a random WAV sample from the configured drum
 * library for a given (role, subRole) pair.
 *
 * The library lives at `DEFAULT_SAMPLE_ROOT` for the prototype. Inside
 * that root, samples are organised in 14 folders (see role-mapping.ts).
 * Future work can move this under app-data or make it user-configurable.
 *
 * File listing happens once, lazily, via `host.listAudioFiles`, then is
 * cached for the lifetime of the resolver. Calling `reset()` forces
 * a re-scan (used when the sample library content changes underneath).
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { foldersForRole, folderForSubRole } from './role-mapping';

export const DEFAULT_SAMPLE_ROOT = '/Users/stevehiehn/Downloads/outputs/processed';

export interface KitResolver {
  /**
   * Pick a random WAV path for the given canonical `role`, optionally
   * preferring the folder hinted by `subRole`. If `excludePath` is
   * provided AND more than one candidate exists, the excluded path will
   * not be returned — used by the shuffle button so the user hears a
   * different sample on each click.
   *
   * Returns `null` if no candidates exist (library missing or empty).
   */
  pick(role: string, subRole?: string, excludePath?: string): Promise<string | null>;

  /** Force a re-scan of the library on the next pick. */
  reset(): void;
}

export function createKitResolver(host: PluginHost, rootPath: string = DEFAULT_SAMPLE_ROOT): KitResolver {
  /** Lazily-populated map: folder name → list of absolute WAV paths. */
  let cache: Map<string, string[]> | null = null;
  let listingPromise: Promise<Map<string, string[]>> | null = null;

  async function getCache(): Promise<Map<string, string[]>> {
    if (cache) return cache;
    if (listingPromise) return listingPromise;

    listingPromise = (async () => {
      try {
        const paths = await host.listAudioFiles(rootPath, { extensions: ['.wav'], recursive: true });
        const byFolder = new Map<string, string[]>();
        for (const p of paths) {
          // The folder we care about is the immediate parent dir name —
          // e.g. ".../processed/kick/kick-12345.wav" → "kick".
          const parts = p.split('/');
          const folder = parts[parts.length - 2] ?? '';
          if (!folder) continue;
          const list = byFolder.get(folder) ?? [];
          list.push(p);
          byFolder.set(folder, list);
        }
        cache = byFolder;
        return byFolder;
      } finally {
        // Always clear so a transient failure (disk hiccup, racing scene
        // load) doesn't permanently poison the resolver — the next pick
        // gets a fresh attempt.
        listingPromise = null;
      }
    })();

    return listingPromise;
  }

  async function pick(role: string, subRole?: string, excludePath?: string): Promise<string | null> {
    const folders = await collectFolders(role, subRole);
    if (folders.length === 0) return null;

    let byFolder: Map<string, string[]>;
    try {
      byFolder = await getCache();
    } catch (err: unknown) {
      // listAudioFiles errored (disk missing, permission denied, etc.).
      // Surface a warning but treat as "no library" — callers degrade
      // to silent tracks rather than crashing the generate flow.
      console.warn('[kit-resolver] Failed to list samples:', err);
      return null;
    }

    const pool: string[] = [];
    for (const folder of folders) {
      const list = byFolder.get(folder);
      if (list && list.length > 0) {
        pool.push(...list);
      }
    }
    if (pool.length === 0) return null;

    // Bias the pick to avoid `excludePath` if the pool has alternatives.
    const filtered = (excludePath && pool.length > 1)
      ? pool.filter(p => p !== excludePath)
      : pool;
    const idx = Math.floor(Math.random() * filtered.length);
    return filtered[idx] ?? null;
  }

  async function collectFolders(role: string, subRole?: string): Promise<string[]> {
    const folder = folderForSubRole(subRole);
    if (folder) {
      // sub-role hint maps to a specific folder; use that exclusively
      return [folder];
    }
    const list = foldersForRole(role);
    return [...list];
  }

  return {
    pick,
    reset(): void {
      cache = null;
      listingPromise = null;
    },
  };
}
